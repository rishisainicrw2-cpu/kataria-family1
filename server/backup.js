// Automatic, encrypted backups of the SQLite database to the family's Google Drive folder.
// Why: free hosts (e.g. Render free) wipe the local disk on restart/spin-down. Drive is the durable copy.
//   snapshot (VACUUM INTO) → gzip → AES-256-GCM (key derived from SECRET_KEY) → upload → keep the newest KEEP files.
// Backups are skipped while the database has no users, so an empty database can never displace real backups.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cfg = require('./config');
const { db, q, stats } = require('./db');
const drive = require('./drive');
const { enc, dec, sealBytes } = require('./secrets');
const { BACKUP_FOLDER, NAME_RE } = require('./restore');

const KEEP = +process.env.BACKUP_KEEP || 8;
const MIN_INTERVAL_MS = +process.env.BACKUP_MIN_INTERVAL_MS || 120000;
const state = { running: false, lastAt: null, lastName: null, lastSize: null, lastError: null, lastAttempt: 0, writesAtLast: -1 };

const disabled = () => process.env.BACKUP_TO_DRIVE === 'off';
// One backup per server: kept in the Drive of the first family that connected one.
const backupFamily = () => q.get("SELECT family_id FROM drive_config WHERE status='connected' AND refresh_enc IS NOT NULL ORDER BY connected_at, rowid LIMIT 1")?.family_id || null;
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');

async function run() {
  if (disabled()) return { skipped: 'disabled' };
  if (state.running) return { skipped: 'busy' };
  const fid = backupFamily(); if (!fid) return { skipped: 'drive-not-connected' };
  if (!q.get('SELECT 1 x FROM users LIMIT 1')) return { skipped: 'empty-database' };
  state.running = true; state.lastAttempt = Date.now();
  const tmp = path.join(cfg.DATA_DIR, `.snapshot-${process.pid}.db`);
  try {
    const writes = stats.writes;
    fs.rmSync(tmp, { force: true });
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const sealed = sealBytes(zlib.gzipSync(fs.readFileSync(tmp)));
    const root = q.get('SELECT root_folder_id FROM drive_config WHERE family_id=?', fid).root_folder_id;
    const folder = await drive.ensureFolder(fid, root, BACKUP_FOLDER);
    const name = `kataria-${stamp()}.kfb`;
    await drive.uploadTo(fid, folder, { filename: name, mime: 'application/octet-stream', data: sealed });
    const all = (await drive.listFiles(fid, folder)).filter(f => NAME_RE.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
    for (const old of all.slice(KEEP)) { try { await drive.remove(fid, old.id); } catch (_) {} }
    Object.assign(state, { lastAt: Date.now(), lastName: name, lastSize: sealed.length, lastError: null, writesAtLast: writes });
    return { ok: true, name, size: sealed.length, kept: Math.min(all.length, KEEP) };
  } catch (e) {
    state.lastError = e.message; throw e;
  } finally { fs.rmSync(tmp, { force: true }); state.running = false; }
}

// Background job: back up shortly after changes (never more often than MIN_INTERVAL_MS).
function start() {
  const t = setInterval(() => {
    if (stats.writes === state.writesAtLast || Date.now() - state.lastAttempt < MIN_INTERVAL_MS) return;
    run().catch(e => console.error('[backup]', e.message));
  }, 30000);
  t.unref();
}
// Called on SIGTERM (hosts send it before stopping an instance) so the last messages are saved too.
async function finalBackup(timeoutMs = 20000) {
  if (stats.writes === state.writesAtLast || !backupFamily()) return;
  await Promise.race([run().catch(e => console.error('[backup:final]', e.message)), new Promise(r => setTimeout(r, timeoutMs))]);
}

// The restore key = Drive refresh token + root folder id, encrypted with SECRET_KEY. Useless without SECRET_KEY.
function restoreKey(familyId) {
  const rt = drive.refreshTokenOf(familyId); if (!rt) return null;
  const root = q.get('SELECT root_folder_id FROM drive_config WHERE family_id=?', familyId).root_folder_id;
  return enc(JSON.stringify({ rt, root }));
}
function status(familyId) {
  const fid = backupFamily();
  const out = { enabled: !disabled(), thisFamilyHoldsBackups: fid === familyId, lastAt: state.lastAt, lastName: state.lastName, lastSize: state.lastSize, lastError: state.lastError, keep: KEEP };
  const env = (process.env.DRIVE_RESTORE_KEY || '').trim();
  out.restoreKeySet = !!env; out.restoreKeyCurrent = false;
  if (env && fid === familyId) { try { out.restoreKeyCurrent = JSON.parse(dec(env)).rt === drive.refreshTokenOf(familyId); } catch (_) {} }
  out.persistentSecret = !!process.env.SECRET_KEY;
  return out;
}

module.exports = { run, start, finalBackup, restoreKey, status, backupFamily };
