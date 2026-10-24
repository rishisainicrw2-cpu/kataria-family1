// Google Drive integration tests against a LOCAL STAND-IN for Google (test/mock_google.js).
// Run: npm test   — proves the app's OAuth/upload/download/permission/error code paths; it does NOT prove a live Google account works.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock, ROOT_ID } = require('./mock_google');

const PORT = 3800 + Math.floor(Math.random() * 400);
const MOCK_PORT = PORT + 500;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-drive-'));
const BASE = `http://127.0.0.1:${PORT}`;
let proc, mock;

function startServer() {
  const M = mock.url;
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, BASE_URL: BASE, BACKUP_TO_DRIVE: 'off', GOOGLE_CLIENT_ID: 'test-client-id', GOOGLE_CLIENT_SECRET: 'test-client-secret',
        KF_GOOGLE_AUTH_URL: M + '/auth', KF_GOOGLE_TOKEN_URL: M + '/token', KF_GOOGLE_REVOKE_URL: M + '/revoke', KF_DRIVE_API: M + '/drive/v3', KF_DRIVE_UPLOAD_API: M + '/upload/drive/v3' },
    });
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('running on port')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => { if (c) reject(new Error('server exited ' + c + '\n' + out)); });
    setTimeout(() => reject(new Error('server start timeout\n' + out)), 10000);
  });
}
const stopServer = () => new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill(); });

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const headers = {}; if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (body instanceof FormData) payload = body; else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    const ct = r.headers.get('content-type') || '';
    const raw = Buffer.from(await r.arrayBuffer());
    const data = ct.includes('json') ? JSON.parse(raw.toString() || 'null') : raw;
    return { status: r.status, data, headers: r.headers, location: r.headers.get('location') };
  }
  get(u, extra) { return this.req('GET', u); }
  rawGet(u, headers = {}) { return fetch(BASE + u, { headers: { cookie: this.cookie, ...headers }, redirect: 'manual' }).then(async r => ({ status: r.status, headers: r.headers, data: Buffer.from(await r.arrayBuffer()) })); }
  post(u, b = {}) { return this.req('POST', u, b); }
  del(u, b) { return this.req('DELETE', u, b); }
}
const ctl = (b) => fetch(mock.url + '/__ctl', { method: 'POST', body: JSON.stringify(b) });
const mstate = () => fetch(mock.url + '/__state').then(r => r.json());

let passed = 0, failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; failures.push(name); console.log('  ✗', name, detail !== undefined ? '→ ' + JSON.stringify(detail).slice(0, 400) : ''); }
}
const section = t => console.log('\n' + t);
const PW = 'correct-horse-9';
const upload = (c, category, name, bytes, mime, extra = {}) => {
  const fd = new FormData(); fd.append('category', category);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('file', new Blob([bytes], { type: mime }), name);
  return c.req('POST', '/api/files', fd);
};

(async () => {
  mock = await startMock(MOCK_PORT);
  await startServer();
  console.log('Server', BASE, '· stand-in Google', mock.url);

  // ---- people ----
  const mk = async (name, email) => { const c = new Client(); const r = await c.post('/api/auth/register', { name, email, password: PW }); if (r.status !== 200) throw new Error('register ' + JSON.stringify(r.data)); return c; };
  const asha = await mk('Asha', 'asha@example.com'), ravi = await mk('Ravi', 'ravi@example.com'), meera = await mk('Meera', 'meera@example.com'), zed = await mk('Zed', 'zed@example.com');
  await asha.post('/api/family', { name: 'Kataria Family' });
  const inv = (await asha.post('/api/invites', { maxUses: 5 })).data;
  await ravi.post('/api/family/join', { code: inv.code }); await meera.post('/api/family/join', { code: inv.code });
  await zed.post('/api/family', { name: 'Other Family' });
  const members = (await asha.get('/api/family')).data.members; const idOf = n => members.find(m => m.name === n).id;

  section('A. Before Drive is connected');
  let st = (await asha.get('/api/drive/status')).data;
  check('status: OAuth configured but not connected', st.configured === true && st.connected === false, st);
  check('status shows the exact folder ID supplied by the owner', st.rootFolderId === ROOT_ID, st.rootFolderId);
  let up = await upload(ravi, 'memories', 'a.png', Buffer.from('x'), 'image/png');
  check('upload refused with a clear message (no other storage used)', up.status === 503 && /not connected/i.test(up.data.error), up);

  // Folders made before the clan rebrand must be RENAMED in place (same folder, same files), never duplicated.
  await ctl({ plantFolder: { name: 'Family Memories', parent: ROOT_ID } }); await ctl({ plantFolder: { name: 'Family Plans', parent: ROOT_ID } });
  const legacy = (await mstate()).files.filter(f => ['Family Memories', 'Family Plans'].includes(f.name));

  section('B. OAuth connection (owner only)');
  const cn = await asha.get('/api/drive/connect');
  check('connect redirects to Google consent', cn.status === 302 && cn.location.startsWith(mock.url + '/auth?'), cn.location);
  const url = new URL(cn.location);
  check('asks for offline access with consent', url.searchParams.get('access_type') === 'offline' && url.searchParams.get('prompt') === 'consent');
  check('redirect URI is this server\'s callback', url.searchParams.get('redirect_uri') === BASE + '/api/drive/callback', url.searchParams.get('redirect_uri'));
  check('client secret is never sent to the browser', !cn.location.includes('test-client-secret'));
  check('member cannot start the connection', (await ravi.get('/api/drive/connect')).status === 403);
  const state = url.searchParams.get('state');
  check('forged state is rejected', /expired|try again/i.test(decodeURIComponent((await asha.get('/api/drive/callback?code=good-code&state=forged')).location || '')));
  check('a non-owner cannot use the callback at all (403)', (await ravi.get('/api/drive/callback?code=good-code&state=' + state)).status === 403);
  const zedCb = await zed.get('/api/drive/callback?code=good-code&state=' + state);
  check("another family's owner cannot replay our state (rejected, nothing connected)", /expired|try again/i.test(decodeURIComponent(zedCb.location || '')) && (await zed.get('/api/drive/status')).data.connected === false, zedCb.location);
  const url2 = new URL((await asha.get('/api/drive/connect')).location); // the replayed state was consumed, so ask for a fresh one
  const cb = await asha.get(`/api/drive/callback?code=good-code&state=${url2.searchParams.get('state')}`);
  check('callback with valid state connects', cb.status === 302 && /drive=connected/.test(cb.location), cb.location);
  check('state is single-use', /expired|try again/i.test(decodeURIComponent((await asha.get(`/api/drive/callback?code=good-code&state=${url2.searchParams.get('state')}`)).location || '')));

  section('C. Folder verification and organisation');
  st = (await asha.get('/api/drive/status')).data;
  check('connected and the specified folder is reachable', st.connected && st.folderOk, st);
  check('connected account shown', st.account === 'family.owner@example.com', st.account);
  let ms = await mstate();
  const subs = ms.files.filter(f => f.parents.includes(ROOT_ID) && f.mimeType === 'application/vnd.google-apps.folder');
  check('all 7 category folders exist under the EXACT root folder', subs.length === 7, subs.map(s => s.name));
  check('folder names match the specification', ['Clan Chat Media', 'Clan Photos and Videos', 'Clan Match Plans', 'Clan Events', 'Clan Highlights', 'Shared Documents', 'Gear and Other Files'].every(n => subs.some(s => s.name === n)));
  check('an old "Family Memories" folder was renamed in place to "Clan Highlights" (same folder, no duplicate)', ms.files.some(f => f.id === legacy.find(l => l.name === 'Family Memories').id && f.name === 'Clan Highlights') && !ms.files.some(f => f.name === 'Family Memories'), legacy);
  check('…and "Family Plans" became "Clan Match Plans"', ms.files.some(f => f.id === legacy.find(l => l.name === 'Family Plans').id && f.name === 'Clan Match Plans') && !ms.files.some(f => f.name === 'Family Plans'));
  const n1 = ms.files.length;
  await asha.get('/api/drive/status'); await asha.post('/api/drive/setup');
  ms = await mstate();
  check('re-running setup does not create duplicate folders', ms.files.length === n1, [n1, ms.files.length]);
  check('nothing was created outside the root folder', ms.files.every(f => f.id === ROOT_ID || f.parents.includes(ROOT_ID)));

  section('D. Upload to the correct folder + metadata');
  const photo = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  up = await upload(ravi, 'memories', 'diwali.jpg', photo, 'image/jpeg', { caption: 'Diwali 2026' });
  check('member uploads a photo to Memories', up.status === 200 && up.data.name === 'diwali.jpg', up);
  ms = await mstate();
  const mem = ms.files.find(f => f.name === 'Clan Highlights' && f.parents.includes(ROOT_ID));
  const stored = ms.files.find(f => f.name === 'diwali.jpg');
  check('file landed in "Clan Highlights" under the root folder', stored && stored.parents[0] === mem.id, stored);
  check('stored bytes are identical to what was uploaded', stored && Buffer.from(stored.data, 'base64').equals(photo));
  const docUp = await upload(asha, 'documents', 'passport-copy.pdf', Buffer.from('%PDF-1.4 fake'), 'application/pdf');
  const docFolder = (await mstate()).files.find(f => f.name === 'Shared Documents');
  check('PDF lands in "Shared Documents"', (await mstate()).files.find(f => f.name === 'passport-copy.pdf').parents[0] === docFolder.id);
  const list = (await asha.get('/api/files')).data;
  check('file metadata (name, size, date, Drive id) saved in the app database', list.length === 2 && list.every(f => f.name && f.size > 0 && f.createdAt), list);
  check('Drive file id is not exposed to ordinary clients', !JSON.stringify(list).includes(stored.id));
  check('unknown category rejected', (await upload(ravi, 'nonsense', 'x.txt', Buffer.from('x'), 'text/plain')).status === 400);
  check('empty upload rejected', (await upload(ravi, 'memories', 'x.txt', Buffer.alloc(0), 'text/plain')).status === 400);
  check('unauthenticated upload rejected', (await upload(new Client(), 'memories', 'x.txt', Buffer.from('x'), 'text/plain')).status === 401);

  section('E. Download, previews and who may fetch what');
  const fileId = up.data.id;
  let dl = await meera.rawGet(`/api/files/${fileId}/content`);
  check('another family member downloads identical bytes', dl.status === 200 && dl.data.equals(photo), dl.status);
  check('image is shown inline with the right type', /^inline/.test(dl.headers.get('content-disposition')) && dl.headers.get('content-type') === 'image/jpeg');
  dl = await meera.rawGet(`/api/files/${fileId}/content?download=1`);
  check('?download=1 forces a download', /^attachment/.test(dl.headers.get('content-disposition')));
  dl = await meera.rawGet(`/api/files/${fileId}/content`, { Range: 'bytes=10-19' });
  check('range requests work (video seeking)', dl.status === 206 && dl.data.equals(photo.subarray(10, 20)) && /bytes 10-19\/5000/.test(dl.headers.get('content-range')), dl.status);
  const thumb = await meera.rawGet(`/api/files/${fileId}/thumb`);
  check('image preview endpoint works', thumb.status === 200 && /^image\//.test(thumb.headers.get('content-type')), thumb.status);
  const pdf = await asha.rawGet(`/api/files/${docUp.data.id}/content`);
  check('PDF served inline for preview', pdf.status === 200 && /application\/pdf/.test(pdf.headers.get('content-type')));
  check('outsider (other family) cannot download by guessing the id', (await zed.rawGet(`/api/files/${fileId}/content`)).status === 404);
  check('logged-out user cannot download', (await new Client().rawGet(`/api/files/${fileId}/content`)).status === 401);
  check('outsider\'s file list does not include our files', (await zed.get('/api/files')).data.length === 0);
  check('the app never calls the Drive permissions API (nothing is shared or made public)', !(await mstate()).log.some(l => /permissions/i.test(l)), (await mstate()).log.filter(l => /permissions/i.test(l)));
  const html = await upload(ravi, 'documents', 'evil.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
  const hd = await asha.rawGet(`/api/files/${html.data.id}/content`);
  check('HTML uploads are never rendered inline (forced download as octet-stream)', /^attachment/.test(hd.headers.get('content-disposition')) && hd.headers.get('content-type') === 'application/octet-stream', hd.headers.get('content-type'));
  check('only uploader or admin can delete', (await meera.del('/api/files/' + fileId)).status === 403);

  section('F. Private-chat attachments stay private');
  const dm = (await ravi.post('/api/dms', { userId: idOf('Asha') })).data;
  const priv = await upload(ravi, 'chat', 'secret.jpg', Buffer.from('private bytes'), 'image/jpeg', { roomId: dm.id });
  check('attachment uploaded into a private chat', priv.status === 200, priv);
  check('private-chat attachment can be posted', (await ravi.post(`/api/rooms/${dm.id}/messages`, { text: 'look', fileId: priv.data.id })).status === 200);
  check('the other participant can open it', (await asha.rawGet(`/api/files/${priv.data.id}/content`)).status === 200);
  check('a third family member CANNOT open it', (await meera.rawGet(`/api/files/${priv.data.id}/content`)).status === 404);
  check('…and it is hidden from their file list', !(await meera.get('/api/files')).data.some(f => f.id === priv.data.id));

  section('G. Failure handling');
  await ctl({ mode: 'down' });
  const before = (await asha.get('/api/files')).data.length;
  up = await upload(ravi, 'memories', 'down.jpg', Buffer.from('x'), 'image/jpeg');
  check('Drive outage → clear error, nothing saved', up.status >= 500 && /drive/i.test(up.data.error) && (await asha.get('/api/files')).data.length === before, up);
  await ctl({ mode: 'ok' });
  await ctl({ mode: 'quota' });
  up = await upload(ravi, 'memories', 'big.jpg', Buffer.from('x'), 'image/jpeg');
  check('Drive storage full → helpful message (HTTP 507)', up.status === 507 && /storage is full/i.test(up.data.error), up);
  check('…and no file row was recorded', (await asha.get('/api/files')).data.length === before);
  await ctl({ mode: 'ok', rateLimitNext: 2 });
  const t0 = Date.now(); up = await upload(ravi, 'memories', 'ratelimited.jpg', Buffer.from('rl'), 'image/jpeg');
  check('rate limiting (429) is retried with back-off and then succeeds', up.status === 200 && Date.now() - t0 > 700, [up.status, Date.now() - t0]);
  const gone = (await asha.get('/api/files')).data.find(f => f.name === 'ratelimited.jpg');
  const ms2 = await mstate(); ms2.files; // remove from "Drive" behind the app's back
  const driveCopy = ms2.files.find(f => f.name === 'ratelimited.jpg');
  await fetch(mock.url + '/drive/v3/files/' + driveCopy.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + ms2.accessTokens[ms2.accessTokens.length - 1] } });
  dl = await asha.rawGet(`/api/files/${gone.id}/content`);
  check('file deleted from Drive directly → clear "no longer exists" error', dl.status === 404, [dl.status, dl.data.toString().slice(0, 100)]);

  section('H. Expired / revoked authorisation and reconnecting');
  await ctl({ revoke: true });
  await new Promise(r => setTimeout(r, 50));
  // force a fresh access token by waiting? The cached token is still valid; revoke affects only refresh. Simulate expiry by restarting the server (cache is in memory).
  await stopServer(); await startServer();
  await asha.post('/api/auth/login', { email: 'asha@example.com', password: PW }); await ravi.post('/api/auth/login', { email: 'ravi@example.com', password: PW });
  up = await upload(ravi, 'memories', 'after-revoke.jpg', Buffer.from('x'), 'image/jpeg');
  check('revoked authorisation → asks the owner to reconnect', up.status === 503 && /expired|revoked/i.test(up.data.error), up);
  st = (await asha.get('/api/drive/status')).data;
  check('status reports expired', /expired|reconnect/i.test(st.message), st);
  const again = await asha.get('/api/drive/connect'); const s3 = new URL(again.location).searchParams.get('state');
  await asha.get(`/api/drive/callback?code=good-code&state=${s3}`);
  up = await upload(ravi, 'memories', 'after-reconnect.jpg', Buffer.from('ok'), 'image/jpeg');
  check('reconnecting restores uploads', up.status === 200, up);
  check('existing files still listed after reconnect', (await asha.get('/api/files')).data.some(f => f.name === 'diwali.jpg'));

  section('I. Folder permission problems (no silent fallback)');
  await ctl({ rootWritable: false });
  await asha.post('/api/drive/disconnect');
  const c4 = new URL((await asha.get('/api/drive/connect')).location).searchParams.get('state');
  const cb4 = await asha.get(`/api/drive/callback?code=good-code&state=${c4}`);
  check('read-only folder → clear explanation, not another location', /cannot add files|Editor/i.test(decodeURIComponent(cb4.location)), cb4.location);
  await ctl({ rootWritable: true });
  const bad = await asha.post('/api/drive/setup');
  check('after fixing permissions, setup succeeds', bad.status === 200, bad);

  section('J. Secrets and disconnecting');
  const dbBytes = fs.readFileSync(path.join(DATA, 'kataria.sqlite')).toString('latin1') + (fs.existsSync(path.join(DATA, 'kataria.sqlite-wal')) ? fs.readFileSync(path.join(DATA, 'kataria.sqlite-wal')).toString('latin1') : '');
  const msx = await mstate();
  check('refresh token is NOT stored in plain text in the database', msx.refreshTokens.length > 0 && msx.refreshTokens.every(t => !dbBytes.includes(t)));
  const apiDump = JSON.stringify([(await asha.get('/api/drive/status')).data, (await asha.get('/api/me')).data, (await asha.get('/api/family')).data, (await asha.get('/api/files')).data]);
  check('no access/refresh token appears in any API response', msx.refreshTokens.concat(msx.accessTokens).every(t => !apiDump.includes(t)));
  const idx = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'features2.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check('no Google credentials in frontend code', !/GOCSPX|client_secret|refresh_token/.test(idx));
  check('member cannot disconnect Drive', (await ravi.post('/api/drive/disconnect')).status === 403);
  check('owner disconnects Drive', (await asha.post('/api/drive/disconnect')).status === 200);
  const finalState = await mstate();
  check('the stored token is revoked at Google on disconnect', finalState.revoked.includes(finalState.refreshTokens[finalState.refreshTokens.length - 1]), finalState.revoked);
  up = await upload(ravi, 'memories', 'post-disconnect.jpg', Buffer.from('x'), 'image/jpeg');
  check('uploads refused after disconnect', up.status === 503, up);
  check('files already stored keep their metadata after disconnect', (await asha.get('/api/files')).data.some(f => f.name === 'diwali.jpg'));

  await stopServer(); await mock.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\nDrive suite: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(async e => { console.error('Drive test runner crashed:', e); try { await stopServer(); } catch (_) {} try { await mock.close(); } catch (_) {} process.exit(1); });
