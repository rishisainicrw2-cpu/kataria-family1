// Google Drive integration using the official Drive v3 REST API + OAuth 2.0 (authorization-code flow, offline access).
// Tokens never leave the server. Refresh tokens are encrypted at rest with SECRET_KEY (AES-256-GCM).
//
// POOLED STORAGE: a family has one MAIN Google account (table drive_config — it also holds the database backups) and any number of
// EXTRA accounts (table drive_extra). Uploads go to whichever account has the most free space; each file remembers its account
// (files.drive_acct, NULL = main). A "ref" identifies one account: `familyId` for the main one, `familyId#accountId` for an extra.
const crypto = require('crypto');
const cfg = require('./config');
const { q, json, uid } = require('./db');
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
const EXTRA_ROOT_NAME = 'KATARIA Family Storage';
// Space kept free on the MAIN account so the (tiny) database backups can never fail because photos filled it up.
const MAIN_RESERVE = (+process.env.MAIN_ACCOUNT_RESERVE_MB || 512) * 1048576;
const QUOTA_TTL = 300000;
const { enc, dec } = require('./secrets');

const configured = () => !!(cfg.GOOGLE_CLIENT_ID && cfg.GOOGLE_CLIENT_SECRET && cfg.BASE_URL);
const redirectUri = () => cfg.BASE_URL + '/api/drive/callback';

// ---- account references ----
const ref = (familyId, acct) => acct ? `${familyId}#${acct}` : familyId;
const split = r => { const i = String(r).indexOf('#'); return i < 0 ? { fid: r, acct: null } : { fid: r.slice(0, i), acct: r.slice(i + 1) }; };
const getRow = r => { const { fid, acct } = split(r); return acct ? q.get('SELECT * FROM drive_extra WHERE id=? AND family_id=?', acct, fid) : q.get('SELECT * FROM drive_config WHERE family_id=?', fid); };
function setRow(r, cols) { // column names are internal constants, values are bound parameters
  const { fid, acct } = split(r); const ks = Object.keys(cols), set = ks.map(k => k + '=?').join(','), vals = ks.map(k => cols[k]);
  if (acct) q.run(`UPDATE drive_extra SET ${set} WHERE id=? AND family_id=?`, ...vals, acct, fid);
  else q.run(`UPDATE drive_config SET ${set} WHERE family_id=?`, ...vals, fid);
}

const states = new Map(); // oauth state -> {userId, familyId, add, exp}
function authUrl(userId, familyId, add = false) {
  const state = crypto.randomBytes(18).toString('base64url');
  states.set(state, { userId, familyId, add: !!add, exp: Date.now() + 600000 });
  // When adding another account the chooser must be shown, otherwise Google silently re-uses the account that is already signed in.
  const p = new URLSearchParams({ client_id: cfg.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: add ? 'select_account consent' : 'consent', include_granted_scopes: 'false', state });
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

const tokenCache = new Map(); // ref -> {token, exp}
async function accessToken(r) {
  const c = tokenCache.get(r); if (c && c.exp > Date.now() + 30000) return c.token;
  const row = getRow(r), extra = !!split(r).acct;
  if (!row || !row.refresh_enc) throw new HttpError(503, 'Google Drive is not connected. Ask the family owner to connect it in Profile → Google Drive.', 'drive_not_connected');
  if (row.status === 'expired') throw new HttpError(503, extra ? `The extra Google account ${row.account || ''} has expired. The family owner needs to add it again in Profile → Google Drive.` : 'Google Drive authorisation has expired. The family owner needs to reconnect it in Profile → Google Drive.', 'drive_expired');
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: dec(row.refresh_enc) });
    tokenCache.set(r, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
    return t.access_token;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e.google === 'invalid_grant') { setRow(r, { status: 'expired' }); throw new HttpError(503, extra ? `The extra Google account ${row.account || ''} has expired or was revoked. The family owner needs to add it again.` : 'Google Drive authorisation has expired or was revoked. The family owner needs to reconnect it.', 'drive_expired'); }
    throw new HttpError(502, 'Google Drive sign-in failed: ' + e.message, 'drive_auth');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Authenticated Drive call with retry for rate limits / transient errors. Returns the fetch Response (ok) or throws HttpError.
async function driveFetch(r0, url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const token = await accessToken(r0);
    let r;
    try { r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } }); }
    catch (e) { if (i === tries - 1) throw new HttpError(503, 'Google Drive is unreachable right now. Your file was not saved — please try again.', 'drive_unreachable'); await sleep(500 * 2 ** i); continue; }
    if (r.status === 401) { tokenCache.delete(r0); if (i < tries - 1) continue; }
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

async function about(r, tries) {
  const x = await driveFetch(r, `${DRIVE}/about?fields=user(emailAddress),storageQuota(limit,usage)`, {}, tries);
  const d = await x.json(); return { email: d.user?.emailAddress, used: +d.storageQuota?.usage || 0, limit: +d.storageQuota?.limit || 0 };
}

// Verify the root folder is reachable & writable, then create the 7 subfolders only if they do not already exist.
// MAIN account: the owner-supplied folder is used. EXTRA accounts: a folder "KATARIA Family Storage" is created in that account's My Drive.
async function setup(r) {
  const { acct } = split(r);
  const row = getRow(r);
  let root = row?.root_folder_id || (acct ? null : cfg.DRIVE_ROOT_FOLDER_ID);
  if (!root) {
    const c = await driveFetch(r, `${DRIVE}/files?fields=id&supportsAllDrives=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: EXTRA_ROOT_NAME, mimeType: 'application/vnd.google-apps.folder' }) });
    root = (await c.json()).id; setRow(r, { root_folder_id: root });
  }
  let meta;
  try {
    const x = await driveFetch(r, `${DRIVE}/files/${root}?fields=id,name,mimeType,trashed,capabilities(canAddChildren)&supportsAllDrives=true`);
    meta = await x.json();
  } catch (e) {
    if (e.code === 'drive_missing' || e.code === 'drive_forbidden') throw new HttpError(409, `The connected Google account cannot open the folder ${root}. Share that folder with the account (as Editor) or reconnect using the account that owns it. No other location was used.`, 'drive_folder_denied');
    throw e;
  }
  if (meta.mimeType !== 'application/vnd.google-apps.folder' || meta.trashed) throw new HttpError(409, 'The configured Drive ID is not a usable folder (it may be in the bin).', 'drive_folder_bad');
  if (!meta.capabilities?.canAddChildren) throw new HttpError(409, `The connected account can see "${meta.name}" but cannot add files to it. Ask for Editor access.`, 'drive_folder_readonly');
  const ids = {};
  for (const [cat, name] of Object.entries(CATEGORY_FOLDERS)) {
    const x = await driveFetch(r, `${DRIVE}/files?q=${encodeURIComponent(`'${root}' in parents and name='${esc(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    const found = (await x.json()).files?.[0];
    if (found) ids[cat] = found.id;
    else {
      const c = await driveFetch(r, `${DRIVE}/files?fields=id&supportsAllDrives=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [root] }) });
      ids[cat] = (await c.json()).id;
    }
  }
  setRow(r, { root_folder_id: root, folder_ids: JSON.stringify(ids), status: 'connected' });
  return { rootName: meta.name, folders: Object.values(CATEGORY_FOLDERS) };
}

async function extraStatuses(familyId) {
  const rows = q.all('SELECT * FROM drive_extra WHERE family_id=? ORDER BY connected_at, rowid', familyId);
  return Promise.all(rows.map(async row => {
    const r = ref(familyId, row.id);
    const o = { id: row.id, account: row.account, status: row.status, folderOk: false, used: 0, limit: 0, message: '' };
    if (row.status === 'expired') { o.message = 'Authorisation expired — remove this account and add it again.'; return o; }
    try { const a = await about(r); o.used = a.used; o.limit = a.limit; await setup(r); o.folderOk = true; o.message = 'Ready.'; }
    catch (e) { o.message = e.message; o.status = getRow(r)?.status || o.status; } // the failed call may have just marked it expired
    return o;
  }));
}

async function status(familyId) {
  const out = { configured: configured(), connected: false, folderOk: false, rootFolderId: cfg.DRIVE_ROOT_FOLDER_ID, message: '', accounts: [], pool: null };
  if (!configured()) { out.message = 'Google OAuth credentials are not set on the server yet (see README → Connect Google Drive).'; return out; }
  const row = q.get('SELECT * FROM drive_config WHERE family_id=?', familyId);
  if (!row || !row.refresh_enc) return out;
  out.connected = true; out.account = row.account; out.rootFolderId = row.root_folder_id || cfg.DRIVE_ROOT_FOLDER_ID;
  if (row.status === 'expired') { out.message = 'Authorisation expired — reconnect Google Drive.'; }
  else {
    try { out.quota = await about(familyId); const s = await setup(familyId); out.folderOk = true; out.folders = s.folders; out.message = `Folder "${s.rootName}" is reachable and ready.`; }
    catch (e) { out.message = e.message; }
  }
  out.accounts = await extraStatuses(familyId);
  // Combined storage across every account that answered.
  const parts = [out.quota, ...out.accounts.filter(a => a.status !== 'expired' && a.limit)].filter(Boolean);
  out.pool = { accounts: 1 + out.accounts.length, used: parts.reduce((s, a) => s + a.used, 0), limit: parts.reduce((s, a) => s + a.limit, 0) };
  return out;
}

async function handleCallback(code, stateObj) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new HttpError(400, 'Google did not return offline access. Remove the app at myaccount.google.com/permissions and connect again.');
  if (stateObj.add) return addAccount(stateObj.familyId, t);
  q.run(`INSERT INTO drive_config(family_id,refresh_enc,root_folder_id,status,connected_at) VALUES(?,?,?,?,?)
         ON CONFLICT(family_id) DO UPDATE SET refresh_enc=excluded.refresh_enc,status='connected',connected_at=excluded.connected_at`,
    stateObj.familyId, enc(t.refresh_token), cfg.DRIVE_ROOT_FOLDER_ID, 'connected', Date.now());
  tokenCache.set(stateObj.familyId, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
  try { const a = await about(stateObj.familyId); q.run('UPDATE drive_config SET account=? WHERE family_id=?', a.email, stateObj.familyId); } catch (_) {}
  return setup(stateObj.familyId); // throws a clear error if the folder cannot be used
}

// Add (or re-authorise) an extra Google account to the pool.
async function addAccount(familyId, t) {
  const main = q.get('SELECT refresh_enc, account FROM drive_config WHERE family_id=?', familyId);
  if (!main?.refresh_enc) throw new HttpError(409, 'Connect your main Google Drive first, then add more accounts.', 'drive_no_main');
  let email = null;
  try { const x = await fetch(`${DRIVE}/about?fields=user(emailAddress)`, { headers: { Authorization: 'Bearer ' + t.access_token } }); email = (await x.json())?.user?.emailAddress || null; } catch (_) {}
  if (!email) throw new HttpError(502, 'Could not read which Google account signed in. Please try again.', 'drive_auth');
  const same = a => (a || '').toLowerCase() === email.toLowerCase();
  // The same account twice would count its 15 GB twice, so it is refused (the unused token is simply discarded).
  if (same(main.account)) throw new HttpError(409, `${email} is already your main Google account. Choose a different account.`, 'drive_duplicate');
  const existing = q.all('SELECT * FROM drive_extra WHERE family_id=?', familyId).find(a => same(a.account));
  let acct;
  if (existing) {
    if (existing.status !== 'expired') throw new HttpError(409, `${email} is already added. Choose a different account.`, 'drive_duplicate');
    acct = existing.id; q.run("UPDATE drive_extra SET refresh_enc=?, status='connected', connected_at=? WHERE id=?", enc(t.refresh_token), Date.now(), acct);
  } else {
    acct = uid(); q.run('INSERT INTO drive_extra(id,family_id,refresh_enc,account,status,connected_at) VALUES(?,?,?,?,?,?)', acct, familyId, enc(t.refresh_token), email, 'connected', Date.now());
  }
  const r = ref(familyId, acct);
  tokenCache.set(r, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 }); quotaCache.delete(r);
  try { return await setup(r); }
  catch (e) { if (!existing) { q.run('DELETE FROM drive_extra WHERE id=?', acct); tokenCache.delete(r); } throw e; }
}

async function revokeToken(refreshEnc) {
  if (refreshEnc) { try { await fetch(G_REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: dec(refreshEnc) }) }); } catch (_) {} }
}
async function disconnect(familyId) {
  const row = q.get('SELECT refresh_enc FROM drive_config WHERE family_id=?', familyId);
  await revokeToken(row?.refresh_enc);
  q.run('DELETE FROM drive_config WHERE family_id=?', familyId); tokenCache.delete(familyId); quotaCache.delete(familyId);
}
// Remove one extra account. Refused while it still holds files, so nothing is ever orphaned.
async function disconnectExtra(familyId, acct) {
  const row = q.get('SELECT * FROM drive_extra WHERE id=? AND family_id=?', acct, familyId);
  if (!row) throw new HttpError(404, 'That Google account is not in the storage pool.');
  const n = q.get('SELECT COUNT(*) c FROM files WHERE family_id=? AND drive_acct=?', familyId, acct).c;
  if (n > 0) throw new HttpError(409, `${n} file${n === 1 ? ' is' : 's are'} stored in ${row.account || 'this account'}. Delete those files first — removing the account would make them unreachable.`, 'drive_account_in_use');
  await revokeToken(row.refresh_enc);
  q.run('DELETE FROM drive_extra WHERE id=?', acct); const r = ref(familyId, acct); tokenCache.delete(r); quotaCache.delete(r);
}
async function disconnectExtras(familyId) {
  for (const row of q.all('SELECT * FROM drive_extra WHERE family_id=?', familyId)) { await revokeToken(row.refresh_enc); tokenCache.delete(ref(familyId, row.id)); quotaCache.delete(ref(familyId, row.id)); }
  q.run('DELETE FROM drive_extra WHERE family_id=?', familyId);
}

async function folderFor(r, category) {
  const { fid } = split(r);
  let ids = json(getRow(r)?.folder_ids);
  if (!ids[category]) { await setup(r); ids = json(getRow(r).folder_ids); }
  return ids[category] || Object.values(ids)[0];
}

// ---- choosing where a new file goes ----
const quotaCache = new Map(); // ref -> {free, at}   free: bytes (Infinity = unlimited), -1 = unknown
function candidates(familyId) {
  const out = [];
  const m = q.get('SELECT status, refresh_enc FROM drive_config WHERE family_id=?', familyId);
  if (m?.refresh_enc && m.status !== 'expired') out.push({ ref: familyId, acct: null, main: true });
  for (const e of q.all("SELECT id FROM drive_extra WHERE family_id=? AND status!='expired' ORDER BY connected_at, rowid", familyId)) out.push({ ref: ref(familyId, e.id), acct: e.id, main: false });
  return out;
}
async function freeSpace(c) {
  const hit = quotaCache.get(c.ref); if (hit && Date.now() - hit.at < QUOTA_TTL) return hit.free;
  let free = -1;
  try { const a = await about(c.ref, 1); free = a.limit ? Math.max(0, a.limit - a.used - (c.main ? MAIN_RESERVE : 0)) : Infinity; quotaCache.set(c.ref, { free, at: Date.now() }); }
  catch (_) { /* unknown: still tried, but after the accounts we know have room */ }
  return free;
}
const byFreeDesc = (a, b) => (a.free === b.free ? 0 : a.free < b.free ? 1 : -1);

async function upload(familyId, category, file) {
  const cands = candidates(familyId);
  if (!cands.length) { await accessToken(familyId); throw new HttpError(503, 'Google Drive is not connected. Ask the family owner to connect it in Profile → Google Drive.', 'drive_not_connected'); }
  const need = file.data.length;
  const plan = async () => (await Promise.all(cands.map(async c => ({ ...c, free: await freeSpace(c) })))).filter(c => c.free < 0 || c.free >= need).sort(byFreeDesc);
  let order = await plan();
  if (!order.length) { for (const c of cands) quotaCache.delete(c.ref); order = await plan(); } // cached numbers may be stale (space was freed)
  if (!order.length) throw new HttpError(507, cands.length > 1 ? 'The Google Drive storage is full on every connected account. Free up space or add another account, then try again.' : 'The Google Drive storage is full. Free up space in Drive or upgrade storage, then try again.', 'drive_quota');
  let firstErr = null;
  for (const c of order) {
    try {
      const folder = await folderFor(c.ref, category);
      const res = await uploadTo(c.ref, folder, file);
      const hit = quotaCache.get(c.ref); if (hit && Number.isFinite(hit.free)) hit.free = Math.max(0, hit.free - need);
      return { ...res, acct: c.acct };
    } catch (e) {
      if (!(e instanceof HttpError) || !/^drive_/.test(e.code || '')) throw e;
      firstErr = firstErr || e;                                    // try the next account; if all fail, report the best account's error
      if (e.code === 'drive_quota') quotaCache.set(c.ref, { free: 0, at: Date.now() });
    }
  }
  if (firstErr?.code === 'drive_quota' && cands.length > 1) throw new HttpError(507, 'The Google Drive storage is full on every connected account. Free up space or add another account, then try again.', 'drive_quota');
  throw firstErr;
}
async function uploadTo(r, parent, { filename, mime, data }) {
  const boundary = 'kf' + crypto.randomBytes(12).toString('hex');
  const meta = Buffer.from(JSON.stringify({ name: filename, parents: [parent] }));
  const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`), meta, Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`), data, Buffer.from(`\r\n--${boundary}--`)]);
  const x = await driveFetch(r, `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,name,size,mimeType&supportsAllDrives=true`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  return x.json();
}
const download = (r, driveId, range) => driveFetch(r, `${DRIVE}/files/${driveId}?alt=media&supportsAllDrives=true`, { headers: range ? { Range: range } : {} });
async function thumbnail(r, driveId) {
  const x = await driveFetch(r, `${DRIVE}/files/${driveId}?fields=thumbnailLink&supportsAllDrives=true`);
  const link = (await x.json()).thumbnailLink; if (!link) return null;
  const t = await fetch(link.replace(/=s\d+$/, '=s400')); return t.ok ? t : null;
}
async function remove(r, driveId) {
  try { await driveFetch(r, `${DRIVE}/files/${driveId}?supportsAllDrives=true`, { method: 'DELETE' }, 2); }
  catch (e) { if (e.code !== 'drive_missing') throw e; }
  quotaCache.delete(r); // space was freed
}

// Find a sub-folder by name under `parent`, creating it only if it does not already exist.
async function ensureFolder(r, parent, name) {
  const x = await driveFetch(r, `${DRIVE}/files?q=${encodeURIComponent(`'${parent}' in parents and name='${esc(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const found = (await x.json()).files?.[0]; if (found) return found.id;
  const c = await driveFetch(r, `${DRIVE}/files?fields=id&supportsAllDrives=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) });
  return (await c.json()).id;
}
async function listFiles(r, parent) {
  const x = await driveFetch(r, `${DRIVE}/files?q=${encodeURIComponent(`'${parent}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,name)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  return (await x.json()).files || [];
}
const refreshTokenOf = familyId => { const row = q.get('SELECT refresh_enc FROM drive_config WHERE family_id=?', familyId); return row?.refresh_enc ? dec(row.refresh_enc) : null; };

module.exports = { configured, authUrl, takeState, handleCallback, disconnect, disconnectExtra, disconnectExtras, status, setup, upload, uploadTo, ensureFolder, listFiles, refreshTokenOf, download, thumbnail, remove, ref, CATEGORY_FOLDERS,
  ENDPOINTS: { G_TOKEN, DRIVE, DRIVE_UPLOAD } };
