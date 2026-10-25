process.env.SINGLE_CLAN = 'off'; // these suites create several clans on purpose
// Tests for encrypted database backups to Drive and restore-after-wipe (the free-hosting persistence story).
// Uses the local stand-in for Google (test/mock_google.js). Run: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock, ROOT_ID } = require('./mock_google');

const PORT = 4300 + Math.floor(Math.random() * 300);
const MOCK_PORT = PORT + 400;
const DATA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kf-bk-')), 'data');
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'test-secret-key-0123456789abcdef0123456789abcdef';
let mock, proc;

function envFor(extra = {}) {
  const M = mock.url;
  return { ...process.env, PORT: String(PORT), DATA_DIR: DATA, BASE_URL: BASE, SECRET_KEY: SECRET, GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret',
    KF_GOOGLE_AUTH_URL: M + '/auth', KF_GOOGLE_TOKEN_URL: M + '/token', KF_GOOGLE_REVOKE_URL: M + '/revoke', KF_DRIVE_API: M + '/drive/v3', KF_DRIVE_UPLOAD_API: M + '/upload/drive/v3',
    BACKUP_KEEP: '3', KF_FAST_RETRY: '1', DRIVE_RESTORE_KEY: '', ...extra };
}
// Resolves {out} once listening, or {exitCode,out} if the process exits first.
function boot(extra) {
  return new Promise(resolve => {
    proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], { env: envFor(extra) });
    let out = '', done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    proc.stdout.on('data', d => { out += d; if (out.includes('running on port')) fin({ out, up: true }); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => fin({ out, exitCode: c, up: false }));
    setTimeout(() => fin({ out, timeout: true }), 15000);
  });
}
const stop = (sig = 'SIGTERM') => new Promise(r => { if (!proc || proc.exitCode !== null) return r(proc && proc.exitCode); proc.once('exit', c => r(c)); proc.kill(sig); });
const wipeDisk = () => { fs.rmSync(DATA, { recursive: true, force: true }); };

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const headers = {}; if (this.cookie) headers.cookie = this.cookie;
    let payload; if (body instanceof FormData) payload = body; else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    const ct = r.headers.get('content-type') || ''; const raw = Buffer.from(await r.arrayBuffer());
    return { status: r.status, data: ct.includes('json') ? JSON.parse(raw.toString() || 'null') : raw, location: r.headers.get('location') };
  }
  get(u) { return this.req('GET', u); } post(u, b = {}) { return this.req('POST', u, b); }
}
const ctl = b => fetch(mock.url + '/__ctl', { method: 'POST', body: JSON.stringify(b) });
const mstate = () => fetch(mock.url + '/__state').then(r => r.json());
const backupsIn = async () => { const st = await mstate(); const folder = st.files.find(f => f.name === 'Hindu Esports App Backups (do not delete)'); return { folder, files: folder ? st.files.filter(f => f.parents.includes(folder.id)) : [] }; };

let passed = 0, failed = 0; const failures = [];
function check(name, cond, detail) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; failures.push(name); console.log('  ✗', name, detail !== undefined ? '→ ' + JSON.stringify(detail).slice(0, 400) : ''); } }
const section = t => console.log('\n' + t);
const PW = 'correct-horse-9';
async function connectDrive(c) {
  const st = new URL((await c.get('/api/drive/connect')).location).searchParams.get('state');
  return c.get(`/api/drive/callback?code=good-code&state=${st}`);
}
const upload = (c, name, bytes) => { const fd = new FormData(); fd.append('category', 'memories'); fd.append('file', new Blob([bytes], { type: 'image/jpeg' }), name); return c.req('POST', '/api/files', fd); };

(async () => {
  mock = await startMock(MOCK_PORT);
  let b = await boot();
  console.log('Server', BASE, '· stand-in Google', mock.url);
  if (!b.up) throw new Error('server did not start: ' + b.out);

  section('A. Backup is skipped while there is nothing worth saving');
  const asha = new Client();
  check('register owner', (await asha.post('/api/auth/register', { name: 'Asha', email: 'asha@example.com', password: PW })).status === 200);
  await asha.post('/api/family', { name: 'Kataria Family' });
  const rooms = (await asha.get('/api/rooms')).data; const general = rooms.find(r => r.type === 'general');
  const ravi = new Client(); await ravi.post('/api/auth/register', { name: 'Ravi', email: 'ravi@example.com', password: PW });
  const inv = (await asha.post('/api/invites', {})).data; await ravi.post('/api/family/join', { code: inv.code });
  let r = await asha.post('/api/drive/backup');
  check('"back up now" before Drive is connected → explains what to do', r.status === 409 && /connect google drive/i.test(r.data.error), r);
  let bs = (await asha.get('/api/drive/backup')).data;
  check('status: no restore key set, no backup yet', bs.restoreKeySet === false && bs.lastAt === null && bs.persistentSecret === true, bs);

  section('B. Creating encrypted backups');
  check('connect Drive', /drive=connected/.test((await connectDrive(asha)).location));
  await asha.post(`/api/rooms/${general.id}/messages`, { text: 'Remember the SECRET-PHRASE-ALPHA for Diwali plans' });
  const photoBytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7) % 256));
  const up = await upload(ravi, 'diwali.jpg', photoBytes);
  check('a photo is uploaded before the backup', up.status === 200, up);
  r = await asha.post('/api/drive/backup');
  check('owner can back up now', r.status === 200 && r.data.ok && /^kataria-\d{8}-\d{6}-\d{3}\.kfb$/.test(r.data.name), r);
  let bk = await backupsIn();
  check('backup is stored in a folder under the EXACT root folder', bk.folder && bk.folder.parents.includes(ROOT_ID), bk.folder);
  check('exactly one backup file so far', bk.files.length === 1, bk.files.map(f => f.name));
  const raw = Buffer.from(bk.files[0].data, 'base64');
  check('backup file is encrypted (KFB1 header, no SQLite header, no readable messages)', raw.subarray(0, 4).toString() === 'KFB1' && !raw.toString('latin1').includes('SQLite format') && !raw.toString('latin1').includes('SECRET-PHRASE-ALPHA') && !raw.toString('latin1').includes('asha@example.com'));
  check('status now shows the last backup', (await asha.get('/api/drive/backup')).data.lastAt > 0);
  for (let i = 0; i < 5; i++) { await asha.post(`/api/rooms/${general.id}/messages`, { text: 'filler ' + i }); await asha.post('/api/drive/backup'); }
  bk = await backupsIn();
  check('only the newest 3 backups are kept (older ones deleted)', bk.files.length === 3, bk.files.length);
  check('a member cannot back up', (await ravi.post('/api/drive/backup')).status === 403);
  check('a member cannot read the restore key', (await ravi.post('/api/drive/restore-key', { password: PW })).status === 403);
  check('restore key needs the password', (await asha.post('/api/drive/restore-key', { password: 'wrong-password' })).status === 400);
  const rk = await asha.post('/api/drive/restore-key', { password: PW });
  check('owner gets a restore key', rk.status === 200 && typeof rk.data.key === 'string' && rk.data.key.length > 40, rk);
  const ms = await mstate();
  check('restore key does not contain the Google refresh token in readable form', ms.refreshTokens.every(t => !rk.data.key.includes(t) && !Buffer.from(rk.data.key.split('.').pop(), 'base64').toString('latin1').includes(t)));
  check('status endpoint never returns the key', !JSON.stringify((await asha.get('/api/drive/backup')).data).includes(rk.data.key));
  const KEY = rk.data.key;

  section('C. Disk wiped (like a free-host restart): history comes back');
  await asha.post(`/api/rooms/${general.id}/messages`, { text: 'LAST-MESSAGE-BEFORE-SHUTDOWN' });  // not yet backed up
  const sessionCookie = asha.cookie;
  const code = await stop('SIGTERM');
  check('server exits cleanly on SIGTERM after saving a final backup', code === 0, code);
  wipeDisk();
  check('local database really is gone', !fs.existsSync(path.join(DATA, 'kataria.sqlite')));
  b = await boot({ DRIVE_RESTORE_KEY: KEY });
  check('server starts and reports a restore', b.up && /restored:kataria-/.test(b.out), b.out.slice(0, 500));
  const asha2 = new Client(); asha2.cookie = sessionCookie;
  check('the owner is still logged in (sessions were restored)', (await asha2.get('/api/me')).status === 200);
  const login = new Client();
  check('passwords still work', (await login.post('/api/auth/login', { email: 'ravi@example.com', password: PW })).status === 200);
  const msgs = (await asha2.get(`/api/rooms/${general.id}/messages`)).data;
  const texts = (Array.isArray(msgs) ? msgs : msgs.messages).map(m => m.text);
  check('earlier chat history is back', texts.includes('Remember the SECRET-PHRASE-ALPHA for Diwali plans'), texts.slice(0, 3));
  check('even the message sent right before shutdown is back (final backup worked)', texts.includes('LAST-MESSAGE-BEFORE-SHUTDOWN'), texts.slice(-3));
  const files = (await asha2.get('/api/files')).data;
  check('file records are back', files.some(f => f.name === 'diwali.jpg'));
  const dl = await fetch(`${BASE}/api/files/${files.find(f => f.name === 'diwali.jpg').id}/content`, { headers: { cookie: login.cookie } });
  check('…and the photo downloads from Drive (Drive connection survived the restore)', dl.status === 200 && Buffer.from(await dl.arrayBuffer()).equals(photoBytes), dl.status);
  bs = (await asha2.get('/api/drive/backup')).data;
  check('status shows the restore key is set and current', bs.restoreKeySet && bs.restoreKeyCurrent, bs);

  section('D. Existing data is never overwritten');
  await stop();
  b = await boot({ DRIVE_RESTORE_KEY: KEY });
  check('restart with data present keeps local data (no restore)', b.up && /database-already-has-data/.test(b.out), b.out.slice(0, 300));
  check('data intact after that restart', (await asha2.get('/api/me')).status === 200);

  section('E. Refuses to start empty when a restore was expected but is impossible');
  await stop(); wipeDisk();
  b = await boot({ DRIVE_RESTORE_KEY: KEY, SECRET_KEY: 'a-different-secret-key-aaaaaaaaaaaaaaaaaaaaaaaa' });
  check('wrong SECRET_KEY → server refuses to start (exit 1)', b.exitCode === 1 && /FATAL/.test(b.out) && /SECRET_KEY/.test(b.out), b);
  check('…and did not create a new database', !fs.existsSync(path.join(DATA, 'kataria.sqlite')));
  await ctl({ mode: 'down' });
  b = await boot({ DRIVE_RESTORE_KEY: KEY });
  check('Drive unreachable → server refuses to start rather than starting empty', b.exitCode === 1 && /FATAL/.test(b.out), b.out.slice(-300));
  await ctl({ mode: 'ok' });
  await ctl({ revoke: true });
  b = await boot({ DRIVE_RESTORE_KEY: KEY });
  check('revoked Google access → refuses to start with a clear message', b.exitCode === 1 && /FATAL/.test(b.out) && /invalid_grant|Google sign-in/.test(b.out), b.out.slice(-300));
  check('garbage restore key → refuses to start', (await boot({ DRIVE_RESTORE_KEY: 'not-a-key' })).exitCode === 1);
  check('the real backups in Drive were not touched by any of this', (await backupsIn()).files.length === 3);

  section('F. Damaged newest backup → falls back to an older one');
  await ctl({ reset: false });
  // Fresh Drive auth for this part: connect again with a new server on a wiped disk.
  await stop(); wipeDisk();
  await ctl({ reset: true });
  b = await boot();
  const o = new Client(); await o.post('/api/auth/register', { name: 'Owner', email: 'o@example.com', password: PW }); await o.post('/api/family', { name: 'F2' });
  await connectDrive(o);
  const g2 = (await o.get('/api/rooms')).data.find(x => x.type === 'general');
  await o.post(`/api/rooms/${g2.id}/messages`, { text: 'good data' });
  check('make a good backup', (await o.post('/api/drive/backup')).status === 200);
  const key2 = (await o.post('/api/drive/restore-key', { password: PW })).data.key;
  const folder = (await backupsIn()).folder;
  await ctl({ plant: { parent: folder.id, name: 'kataria-99990101-000000-000.kfb', data: Buffer.from('KFB1' + 'x'.repeat(80)).toString('base64') } });
  await stop(); wipeDisk();
  b = await boot({ DRIVE_RESTORE_KEY: key2 });
  check('damaged newest backup skipped, older one restored', b.up && /unusable/.test(b.out) && /restored:kataria-2/.test(b.out), b.out.slice(0, 600));
  const o2 = new Client(); check('data from the older backup is present', (await o2.post('/api/auth/login', { email: 'o@example.com', password: PW })).status === 200);

  section('G. First deployment with a restore key but no backup yet');
  await stop(); wipeDisk(); await ctl({ reset: true });
  b = await boot({ DRIVE_RESTORE_KEY: key2 });   // key2's token is no longer valid on the freshly reset Drive
  check('(stale key after Drive reset) → refuses to start', b.exitCode === 1, b.out.slice(-200));
  // Re-create valid credentials on a fresh server, then wipe and restore with an empty backup folder.
  wipeDisk(); b = await boot();
  const p = new Client(); await p.post('/api/auth/register', { name: 'P', email: 'p@example.com', password: PW }); await p.post('/api/family', { name: 'F3' });
  await connectDrive(p); const key3 = (await p.post('/api/drive/restore-key', { password: PW })).data.key;
  await stop('SIGKILL'); wipeDisk();   // SIGKILL: no final backup, so Drive has no backup folder at all
  b = await boot({ DRIVE_RESTORE_KEY: key3 });
  check('valid key but no backup in Drive yet → starts normally with a new database', b.up && /no-backup-yet|no backup/.test(b.out), b.out.slice(0, 300));
  check('empty database does not upload a backup (nothing to protect)', (await backupsIn()).files.length === 0);

  section('H. Switching backups off');
  await stop(); wipeDisk(); await ctl({ reset: true });
  b = await boot({ BACKUP_TO_DRIVE: 'off' });
  const z = new Client(); await z.post('/api/auth/register', { name: 'Z', email: 'z@example.com', password: PW }); await z.post('/api/family', { name: 'F4' }); await connectDrive(z);
  const off = await z.post('/api/drive/backup');
  check('BACKUP_TO_DRIVE=off disables backups with a clear message', off.status === 409 && /switched off/i.test(off.data.error), off);

  section('I. Backups made before the rebrand (old folder name) are still found');
  await stop(); wipeDisk(); await ctl({ reset: true });
  b = await boot();
  const q5 = new Client(); await q5.post('/api/auth/register', { name: 'Q', email: 'q@example.com', password: PW }); await q5.post('/api/family', { name: 'F5' }); await connectDrive(q5);
  check('a backup is made into the new-named folder', (await q5.post('/api/drive/backup')).status === 200 && (await backupsIn()).files.length === 1, (await backupsIn()).files.length);
  await ctl({ renameFile: { from: 'Hindu Esports App Backups (do not delete)', to: 'KATARIA App Backups (do not delete)' } });   // as it was before the rebrand
  const key5 = (await q5.post('/api/drive/restore-key', { password: PW })).data.key;
  await stop('SIGKILL'); wipeDisk();
  b = await boot({ DRIVE_RESTORE_KEY: key5 });
  check('a wiped server restores from the OLD-named backup folder', b.up && /restored:kataria-/.test(b.out), b.out.slice(0, 400));
  const q6 = new Client(); await q6.post('/api/auth/login', { email: 'q@example.com', password: PW });
  check('the next backup renames the old folder (no second folder, old backup kept)', (await q6.post('/api/drive/backup')).status === 200, null);
  const stF = (await mstate()).files;
  check('…old name gone, one new-named folder holding both backups', !stF.some(f => f.name === 'KATARIA App Backups (do not delete)') && stF.filter(f => f.name === 'Hindu Esports App Backups (do not delete)').length === 1 && (await backupsIn()).files.length === 2, (await backupsIn()).files.length);

  await stop(); await mock.close();
  fs.rmSync(path.dirname(DATA), { recursive: true, force: true });
  console.log(`\nBackup suite: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(async e => { console.error('Backup test runner crashed:', e); try { await stop('SIGKILL'); } catch (_) {} try { await mock.close(); } catch (_) {} process.exit(1); });
