// Google Drive integration using the official Drive v3 REST API + OAuth 2.0 (authorization-code flow, offline access).
// Tokens never leave the server. The refresh token is encrypted at rest with SECRET_KEY (AES-256-GCM).
const crypto = require('crypto');
const cfg = require('./config');
const { q, json } = require('./db');
const { HttpError } = require('./http');

// Google endpoints. The KF_GOOGLE_* overrides exist ONLY so the automated tests can point at a local stand-in server; defaults are the real Google URLs.
const G_AUTH = process.env.KF_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN = process.env.KF_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const G_REVOKE = process.env.KF_GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const DRIVE = process.env.KF_DRIVE_API || 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = process.env.KF_DRIVE_UPLOAD_API || 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive'; // needed to use a pre-existing folder by ID (drive.file cannot see it)
const CATEGORY_FOLDERS = {
  chat: 'Family Chat Media', photos: 'Family Photos and Videos', plans: 'Family Plans', events: 'Family Events',
  memories: 'Family Memories', documents: 'Shared Documents', shopping: 'Shopping and Other Files',
};
const { enc, dec } = require('./secrets');

const configured = () => !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.BASE_URL);
const redirectUri = () => cfg.BASE_URL + '/api/drive/callback';

const states = new Map(); // oauth state -> {userId, familyId, exp}
function authUrl(userId, familyId) {
  const state = crypto.randomBytes(18).toString('base64url');
  states.set(state, { userId, familyId, exp: Date.now() + 600000 });
  const p = new URLSearchParams({ client_id: cfg.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', state });
  return G_AUTH + '?' + p;
}
const takeState = s => { const v = states.get(s); states.delete(s); return v && v.exp > Date.now() ? v : null; };

async function tokenRequest(params) {
  let r;
  try { r = await fetch(G_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cfg.GOOGLE_CLIENT_ID, client_secret: cfg.GOOGLE_CLIENT_SECRET, ...params }) }); }
  catch (e) { throw new HttpError(503, 'Google is unreachable right now. Please try again shortly.', 'drive_unreachable'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(data.error_description || data.error || 'token error'); err.google = data.error; throw err; }
  return data;
}

const tokenCache = new Map(); // familyId -> {token, exp}
async function accessToken(familyId) {
  const c = tokenCache.get(familyId); if (c && c.exp > Date.now() + 30000) return c.token;
  const row = q.get('SELECT * FROM drive_config WHERE family_id=?', familyId);
  if (!row || !row.refresh_enc) throw new HttpError(503, 'Google Drive is not connected. Ask the family owner to connect it in Profile → Google Drive.', 'drive_not_connected');
  if (row.status === 'expired') throw new HttpError(503, 'Google Drive authorisation has expired. The family owner needs to reconnect it in Profile → Google Drive.', 'drive_expired');
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: dec(row.refresh_enc) });
    tokenCache.set(familyId, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
    return t.access_token;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e.google === 'invalid_grant') { q.run("UPDATE drive_config SET status='expired' WHERE family_id=?", familyId); throw new HttpError(503, 'Google Drive authorisation has expired or was revoked. The family owner needs to reconnect it.', 'drive_expired'); }
    throw new HttpError(502, 'Google Drive sign-in failed: ' + e.message, 'drive_auth');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Authenticated Drive call with retry for rate limits / transient errors. Returns the fetch Response (ok) or throws HttpError.
async function driveFetch(familyId, url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const token = await accessToken(familyId);
    let r;
    try { r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } }); }
    catch (e) { if (i === tries - 1) throw new HttpError(503, 'Google Drive is unreachable right now. Your file was not saved — please try again.', 'drive_unreachable'); await sleep(500 * 2 ** i); continue; }
    if (r.status === 401) { tokenCache.delete(familyId); if (i < tries - 1) continue; }
    if (r.ok || r.status === 206) return r;
    const body = await r.json().catch(() => ({}));
    const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
    if ((r.status === 429 || r.status >= 500 || /rateLimit|userRateLimit/i.test(reason)) && i < tries - 1) { await sleep(800 * 2 ** i + Math.random() * 300); continue; }
    if (/storageQuotaExceeded/i.test(reason)) throw new HttpError(507, 'The Google Drive storage is full. Free up space in Drive or upgrade storage, then try again.', 'drive_quota');
    if (r.status === 404) throw new HttpError(404, 'This file no longer exists in Google Drive.', 'drive_missing');
    if (r.status === 403) throw new HttpError(502, 'Google Drive refused access (' + (reason || 'forbidden') + '). Check that the connected account can edit the folder.', 'drive_forbidden');
    if (r.status === 429 || /rateLimit/i.test(reason)) throw new HttpError(429, 'Google Drive is busy (rate limit). Please try again in a minute.', 'drive_rate');
    throw new HttpError(502, 'Google Drive error: ' + (body?.error?.message || r.status), 'drive_error');
  }
}
const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function about(familyId) {
  const r = await driveFetch(familyId, `${DRIVE}/about?fields=user(emailAddress),storageQuota(limit,usage)`);
  const d = await r.json(); return { email: d.user?.emailAddress, used: +d.storageQuota?.usage || 0, limit: +d.storageQuota?.limit || 0 };
}

// Verify the owner-supplied root folder is reachable & writable, then create the 7 subfolders only if they do not already exist.
async function setup(familyId) {
  const root = q.get('SELECT root_folder_id FROM drive_config WHERE family_id=?', familyId)?.root_folder_id || cfg.DRIVE_ROOT_FOLDER_ID;
  let meta;
  try {
    const r = await driveFetch(familyId, `${DRIVE}/files/${root}?fields=id,name,mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`);
    meta = await r.json();
  } catch (e) {
    if (e.code === 'drive_missing' || e.code === 'drive_forbidden') throw new HttpError(409, `The connected Google account cannot open the folder ${root}. Share that folder with the account (as Editor) or reconnect using the account that owns it. No other location was used.`, 'drive_folder_denied');
    throw e;
  }
  if (meta.mimeType !== 'application/vnd.google-apps.folder' || meta.trashed) throw new HttpError(409, 'The configured Drive ID is not a usable folder (it may be in the bin).', 'drive_folder_bad');
  if (!meta.capabilities?.canAddChildren) throw new HttpError(409, `The connected account can see "${meta.name}" but cannot add files to it. Ask for Editor access.`, 'drive_folder_readonly');
  const ids = {};
  for (const [cat, name] of Object.entries(CATEGORY_FOLDERS)) {
    const r = await driveFetch(familyId, `${DRIVE}/files?q=${encodeURIComponent(`'${root}' in parents and name='${esc(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    const found = (await r.json()).files?.[0];
    if (found) ids[cat] = found.id;
    else {
      const c = await driveFetch(familyId, `${DRIVE}/files?fields=id&supportsAllDrives=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [root] }) });
      ids[cat] = (await c.json()).id;
    }
  }
  q.run('UPDATE drive_config SET root_folder_id=?, folder_ids=?, status=? WHERE family_id=?', root, JSON.stringify(ids), 'connected', familyId);
  return { rootName: meta.name, folders: Object.values(CATEGORY_FOLDERS) };
}

async function status(familyId) {
  const out = { configured: configured(), connected: false, folderOk: false, rootFolderId: cfg.DRIVE_ROOT_FOLDER_ID, message: '' };
  if (!configured()) { out.message = 'Google OAuth credentials are not set on the server yet (see README → Connect Google Drive).'; return out; }
  const row = q.get('SELECT * FROM drive_config WHERE family_id=?', familyId);
  if (!row || !row.refresh_enc) return out;
  out.connected = true; out.account = row.account; out.rootFolderId = row.root_folder_id || cfg.DRIVE_ROOT_FOLDER_ID;
  if (row.status === 'expired') { out.message = 'Authorisation expired — reconnect Google Drive.'; return out; }
  try { out.quota = await about(familyId); const s = await setup(familyId); out.folderOk = true; out.folders = s.folders; out.message = `Folder "${s.rootName}" is reachable and ready.`; }
  catch (e) { out.message = e.message; }
  return out;
}

async function handleCallback(code, stateObj) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new HttpError(400, 'Google did not return offline access. Remove the app at myaccount.google.com/permissions and connect again.');
  q.run(`INSERT INTO drive_config(family_id,refresh_enc,root_folder_id,status,connected_at) VALUES(?,?,?,?,?)
         ON CONFLICT(family_id) DO UPDATE SET refresh_enc=excluded.refresh_enc,status='connected',connected_at=excluded.connected_at`,
    stateObj.familyId, enc(t.refresh_token), cfg.DRIVE_ROOT_FOLDER_ID, 'connected', Date.now());
  tokenCache.set(stateObj.familyId, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
  try { const a = await about(stateObj.familyId); q.run('UPDATE drive_config SET account=? WHERE family_id=?', a.email, stateObj.familyId); } catch (_) {}
  return setup(stateObj.familyId); // throws a clear error if the folder cannot be used
}

async function disconnect(familyId) {
  const row = q.get('SELECT refresh_enc FROM drive_config WHERE family_id=?', familyId);
  if (row?.refresh_enc) { try { await fetch(G_REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: dec(row.refresh_enc) }) }); } catch (_) {} }
  q.run('DELETE FROM drive_config WHERE family_id=?', familyId); tokenCache.delete(familyId);
}

async function folderFor(familyId, category) {
  let row = q.get('SELECT folder_ids FROM drive_config WHERE family_id=?', familyId);
  let ids = json(row?.folder_ids);
  if (!ids[category]) { await setup(familyId); ids = json(q.get('SELECT folder_ids FROM drive_config WHERE family_id=?', familyId).folder_ids); }
  return ids[category] || Object.values(ids)[0];
}

const upload = async (familyId, category, file) => uploadTo(familyId, await folderFor(familyId, category), file);
async function uploadTo(familyId, parent, { filename, mime, data }) {
  const boundary = 'kf' + crypto.randomBytes(12).toString('hex');
  const meta = Buffer.from(JSON.stringify({ name: filename, parents: [parent] }));
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`), meta, Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--`)]);
  const r = await driveFetch(familyId, `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,size,mimeType&supportsAllDrives=true`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return r.json();
}
const download = (familyId, driveId, range) => driveFetch(familyId, `${DRIVE}/files/${driveId}?alt=media&supportsAllDrives=true`, { headers: range ? { Range: range } : {} });
async function thumbnail(familyId, driveId) {
  const r = await driveFetch(familyId, `${DRIVE}/files/${driveId}?fields=thumbnailLink&supportsAllDrives=true`);
  const link = (await r.json()).thumbnailLink; if (!link) return null;
  const t = await fetch(link.replace(/=s\d+$/, '=s400')); return t.ok ? t : null;
}
async function remove(familyId, driveId) {
  try { await driveFetch(familyId, `${DRIVE}/files/${driveId}?supportsAllDrives=true`, { method: 'DELETE' }, 2); }
  catch (e) { if (e.code !== 'drive_missing') throw e; }
}

// Find a sub-folder by name under `parent`, creating it only if it does not already exist.
async function ensureFolder(familyId, parent, name) {
  const r = await driveFetch(familyId, `${DRIVE}/files?q=${encodeURIComponent(`'${parent}' in parents and name='${esc(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const found = (await r.json()).files?.[0]; if (found) return found.id;
  const c = await driveFetch(familyId, `${DRIVE}/files?fields=id&supportsAllDrives=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) });
  return (await c.json()).id;
}
async function listFiles(familyId, parent) {
  const r = await driveFetch(familyId, `${DRIVE}/files?q=${encodeURIComponent(`'${parent}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,name)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return (await r.json()).files || [];
}
const refreshTokenOf = familyId => { const row = q.get('SELECT refresh_enc FROM drive_config WHERE family_id=?', familyId); return row?.refresh_enc ? dec(row.refresh_enc) : null; };

module.exports = { configured, authUrl, takeState, handleCallback, disconnect, status, setup, upload, uploadTo, ensureFolder, listFiles, refreshTokenOf, download, thumbnail, remove, CATEGORY_FOLDERS,
  ENDPOINTS: { G_TOKEN, DRIVE, DRIVE_UPLOAD } };
