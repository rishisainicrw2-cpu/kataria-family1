// Runs BEFORE the database is opened. On hosts with an ephemeral disk (e.g. Render's free tier) the SQLite file is wiped on every
// restart; if DRIVE_RESTORE_KEY is set and the local database is empty, the newest encrypted backup is fetched from Google Drive.
//
// Safety rules:
//  * A database that already contains users is NEVER overwritten.
//  * If a restore key is set but the restore fails (Drive unreachable, token revoked, wrong SECRET_KEY) the server REFUSES TO START
//    instead of quietly starting empty — starting empty could let the clan create a new, diverging history.
//  * "No backup found yet" is not a failure (first ever deploy): the server starts normally.
const fs = require('fs');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');
const { dec, openBytes } = require('./secrets');

const BACKUP_FOLDER = 'Hindu Esports App Backups (do not delete)';
const BACKUP_FOLDER_LEGACY = 'KATARIA App Backups (do not delete)';   // name used before the rebrand: still found (and renamed by the next backup)
const NAME_RE = /^kataria-\d{8}-\d{6}-\d{3}\.kfb$/;   // kataria-YYYYMMDD-HHMMSS-mmm.kfb (UTC; sorts oldest → newest)
const G_TOKEN = process.env.KF_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const DRIVE = process.env.KF_DRIVE_API || 'https://www.googleapis.com/drive/v3';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function dbHasUsers(file) {
  if (!fs.existsSync(file)) return false;
  try { const d = new DatabaseSync(file, { readOnly: true }); const n = d.prepare('SELECT COUNT(*) c FROM users').get().c; d.close(); return n > 0; }
  catch { return false; }
}

class Fatal extends Error {}
async function call(url, opts, what) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return r;
      const body = await r.text();
      if (r.status < 500 && r.status !== 429) throw new Fatal(`${what}: Google answered ${r.status} ${body.slice(0, 160)}`);
      last = new Error(`${what}: HTTP ${r.status}`);
    } catch (e) { if (e instanceof Fatal) throw e; last = e; }
    await sleep(Math.min(2000 * 2 ** i, 15000) * (process.env.KF_FAST_RETRY ? 0.01 : 1));
  }
  throw new Error(`${what}: ${last && last.message}`);
}

async function restoreIfNeeded(log = console.log) {
  const keyEnv = (process.env.DRIVE_RESTORE_KEY || '').trim();
  if (!keyEnv) return 'no-restore-key';
  if (dbHasUsers(cfg.DB_FILE)) return 'database-already-has-data';

  let cred;
  try { cred = JSON.parse(dec(keyEnv)); if (!cred.rt || !cred.root) throw new Error('incomplete'); }
  catch { throw new Fatal('DRIVE_RESTORE_KEY cannot be read. It must be created by this app with the SAME SECRET_KEY that is set now.'); }

  log('[restore] local database is empty — looking for a backup in Google Drive…');
  const tok = await call(G_TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.GOOGLE_CLIENT_ID, client_secret: cfg.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: cred.rt }) }, 'Google sign-in');
  const auth = { Authorization: 'Bearer ' + (await tok.json()).access_token };
  const list = async q => (await (await call(`${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: auth }, 'Drive listing')).json()).files || [];

  const inRoot = name => list(`'${cred.root}' in parents and name='${esc(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  let folders = await inRoot(BACKUP_FOLDER); if (!folders.length) folders = await inRoot(BACKUP_FOLDER_LEGACY);
  if (!folders.length) { log('[restore] no backup folder yet (first deployment?) — starting with a new database'); return 'no-backup-yet'; }
  const files = (await list(`'${folders[0].id}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`)).filter(f => NAME_RE.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
  if (!files.length) { log('[restore] backup folder is empty — starting with a new database'); return 'no-backup-yet'; }

  // Newest first; fall back to older ones if a file is damaged.
  const problems = [];
  for (const f of files) {
    try {
      const r = await call(`${DRIVE}/files/${f.id}?alt=media&supportsAllDrives=true`, { headers: auth }, 'Backup download');
      const bytes = zlib.gunzipSync(openBytes(Buffer.from(await r.arrayBuffer())));
      const tmp = cfg.DB_FILE + '.restoring';
      fs.writeFileSync(tmp, bytes);
      if (!dbHasUsers(tmp)) throw new Error('backup contains no users');
      const chk = new DatabaseSync(tmp, { readOnly: true }); const ic = chk.prepare('PRAGMA integrity_check').get(); chk.close();
      if (Object.values(ic)[0] !== 'ok') throw new Error('integrity check failed');
      for (const ext of ['', '-wal', '-shm']) fs.rmSync(cfg.DB_FILE + ext, { force: true });
      fs.renameSync(tmp, cfg.DB_FILE);
      log(`[restore] restored database from ${f.name}`);
      return 'restored:' + f.name;
    } catch (e) {
      problems.push(e.message);
      log(`[restore] ${f.name} unusable (${e.message}); trying an older backup`);
      fs.rmSync(cfg.DB_FILE + '.restoring', { force: true });
    }
  }
  if (problems.every(m => /cannot be decrypted/.test(m))) throw new Fatal(`${files.length} backup(s) found in Drive but none could be decrypted. SECRET_KEY must be exactly the same value that was set when they were made.`);
  throw new Fatal('Backups exist in Drive but none could be restored: ' + problems.slice(0, 3).join('; '));
}

module.exports = { restoreIfNeeded, BACKUP_FOLDER, BACKUP_FOLDER_LEGACY, NAME_RE, dbHasUsers };
