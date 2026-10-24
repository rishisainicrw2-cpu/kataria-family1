// Pooled storage: several Google accounts acting as ONE storage, tested against the local stand-in for Google (test/mock_google.js).
// The stand-in keeps every account's files separate and enforces per-account quotas, so these tests prove files really land in,
// and are fetched from, the right account. It does not prove a live Google account works.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock, ROOT_ID } = require('./mock_google');

const PORT = 4300 + Math.floor(Math.random() * 400);
const MOCK_PORT = PORT + 500;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-pool-'));
const BASE = `http://127.0.0.1:${PORT}`;
const MAIN = 'family.owner@example.com', BOB = 'bobdrive@example.com', CARO = 'caro@example.com';
const GB = 1073741824, FULL = 16106127360;
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
const restart = async () => { await stopServer(); await startServer(); };   // also empties the server's in-memory token and quota caches

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
  get(u) { return this.req('GET', u); }
  rawGet(u, headers = {}) { return fetch(BASE + u, { headers: { cookie: this.cookie, ...headers }, redirect: 'manual' }).then(async r => ({ status: r.status, headers: r.headers, data: Buffer.from(await r.arrayBuffer()) })); }
  post(u, b = {}) { return this.req('POST', u, b); }
  del(u, b) { return this.req('DELETE', u, b); }
}
const ctl = b => fetch(mock.url + '/__ctl', { method: 'POST', body: JSON.stringify(b) });
const mstate = () => fetch(mock.url + '/__state').then(r => r.json());

let passed = 0, failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; failures.push(name); console.log('  ✗', name, detail !== undefined ? '→ ' + JSON.stringify(detail).slice(0, 400) : ''); }
}
const section = t => console.log('\n' + t);
const PW = 'correct-horse-9';
const upload = (c, category, name, bytes, mime = 'image/jpeg') => {
  const fd = new FormData(); fd.append('category', category); fd.append('file', new Blob([bytes], { type: mime }), name);
  return c.req('POST', '/api/files', fd);
};
const msg = loc => decodeURIComponent(loc || '');
// Sign in with `code` as an EXTRA account (add=1) or as the main account.
async function connect(c, code, add = true) {
  const cn = await c.get('/api/drive/connect' + (add ? '?add=1' : ''));
  const state = new URL(cn.location).searchParams.get('state');
  return c.get(`/api/drive/callback?code=${code}&state=${state}`);
}
const snap = async () => (await mstate()).tokens.map(t => t.token);
const discarded = new Set();   // tokens Google issued for sign-ins the app REJECTED; they are never stored (and are not revoked: that could revoke the real grant)
const ownerOf = async name => (await mstate()).files.find(f => f.name === name)?.owner;

(async () => {
  mock = await startMock(MOCK_PORT);
  await startServer();
  console.log('Server', BASE, '· stand-in Google', mock.url);

  const mk = async (name, email) => { const c = new Client(); const r = await c.post('/api/auth/register', { name, email, password: PW }); if (r.status !== 200) throw new Error('register ' + JSON.stringify(r.data)); return c; };
  const asha = await mk('Asha', 'asha@example.com'), ravi = await mk('Ravi', 'ravi@example.com'), zed = await mk('Zed', 'zed@example.com');
  await asha.post('/api/family', { name: 'Kataria Family' });
  const inv = (await asha.post('/api/invites', { maxUses: 5 })).data;
  await ravi.post('/api/family/join', { code: inv.code });
  await zed.post('/api/family', { name: 'Other Family' });
  const relogin = async () => { await asha.post('/api/auth/login', { email: 'asha@example.com', password: PW }); await ravi.post('/api/auth/login', { email: 'ravi@example.com', password: PW }); };

  section('A. An extra account needs the main one first');
  const a0 = await snap();
  let r = await connect(zed, 'good-code-early');
  (await snap()).filter(t => !a0.includes(t)).forEach(t => discarded.add(t));
  check('adding an account before connecting the main Drive is refused with a clear message', /connect your main google drive first/i.test(msg(r.location)), r.location);
  check('…and nothing was added', (await zed.get('/api/drive/status')).data.accounts.length === 0);

  section('B. Connect the main account, then add extra accounts');
  r = await connect(asha, 'good-code', false);
  check('main account connects as before', /drive=connected/.test(r.location), r.location);
  const addUrl = new URL((await asha.get('/api/drive/connect?add=1')).location);
  check('adding an account shows the Google account chooser', addUrl.searchParams.get('prompt') === 'select_account consent', addUrl.searchParams.get('prompt'));
  const mainUrl = new URL((await asha.get('/api/drive/connect')).location);
  check('the normal connect flow is unchanged (consent only)', mainUrl.searchParams.get('prompt') === 'consent');
  check('a member cannot add accounts', (await ravi.get('/api/drive/connect?add=1')).status === 403);
  r = await connect(asha, 'good-code-bobdrive');
  check('owner adds a second Google account', /drive=connected/.test(r.location), r.location);
  let st = (await asha.get('/api/drive/status')).data;
  check('status lists the extra account, ready', st.accounts.length === 1 && st.accounts[0].account === BOB && st.accounts[0].folderOk && st.accounts[0].status === 'connected', st.accounts);
  check('combined storage = both accounts together', st.pool.accounts === 2 && st.pool.limit === 2 * FULL, st.pool);
  let ms = await mstate();
  const bobRoot = ms.files.find(f => f.owner === BOB && f.name === 'KATARIA Family Storage');
  check('a "KATARIA Family Storage" folder was created in the NEW account', !!bobRoot);
  check('…with the 7 category folders inside it', ms.files.filter(f => f.owner === BOB && bobRoot && f.parents.includes(bobRoot.id) && f.mimeType === 'application/vnd.google-apps.folder').length === 7);
  check('the main account\'s folder was left alone (still its 7 folders, nothing of bob\'s inside)', ms.files.filter(f => f.parents.includes(ROOT_ID)).length === 7 && ms.files.filter(f => f.parents.includes(ROOT_ID)).every(f => f.owner === MAIN));
  const bobId = st.accounts[0].id;

  section('C. The same account can never be counted twice');
  const c0 = await snap();
  r = await connect(asha, 'good-code');
  check('signing in with the main account again is refused', /already your main/i.test(msg(r.location)), r.location);
  r = await connect(asha, 'good-code-bobdrive');
  check('signing in with an already-added account is refused', /already added/i.test(msg(r.location)), r.location);
  check('…and the pool is unchanged', (await asha.get('/api/drive/status')).data.accounts.length === 1);
  (await snap()).filter(t => !c0.includes(t)).forEach(t => discarded.add(t));
  // bob gets a smaller quota BEFORE the first upload so we can see "most free space wins"
  await ctl({ limit: { acct: BOB, bytes: 3 * GB } });
  r = await connect(asha, 'good-code-caro');
  check('a third account is added', /drive=connected/.test(r.location), r.location);
  st = (await asha.get('/api/drive/status')).data; const caroId = st.accounts.find(a => a.account === CARO).id;
  check('three accounts are pooled', st.pool.accounts === 3 && st.accounts.length === 2, st.pool);

  section('D. Uploads go to the account with the most free space');
  const photo = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  let up = await upload(ravi, 'memories', 'diwali.jpg', photo);
  check('upload succeeds', up.status === 200, up);
  check('it went to the account with the most room (not the 3 GB one, not the main one that keeps backup headroom)', await ownerOf('diwali.jpg') === CARO, await ownerOf('diwali.jpg'));
  ms = await mstate();
  const stored = ms.files.find(f => f.name === 'diwali.jpg'), parent = ms.files.find(f => f.id === stored.parents[0]);
  check('it sits in that account\'s "Family Memories" folder', parent.name === 'Family Memories' && parent.owner === CARO, parent);
  let dl = await asha.rawGet(`/api/files/${up.data.id}/content`);
  check('another member downloads identical bytes (fetched from the right account)', dl.status === 200 && dl.data.equals(photo), dl.status);
  dl = await asha.rawGet(`/api/files/${up.data.id}/content`, { Range: 'bytes=10-19' });
  check('range requests (video seeking) work across accounts', dl.status === 206 && dl.data.equals(photo.subarray(10, 20)), dl.status);
  check('image previews work', (await asha.rawGet(`/api/files/${up.data.id}/thumb`)).status === 200);
  check('the file list is one combined list', (await asha.get('/api/files')).data.length === 1);
  check('no account id or Drive id leaks to clients', !JSON.stringify((await asha.get('/api/files')).data).includes(caroId) && !JSON.stringify((await asha.get('/api/files')).data).includes(stored.id));
  const caroFile = up.data;

  section('E. When an account is full the app moves on to the next one');
  await ctl({ limit: { acct: CARO, bytes: 1048576 + 100 } });     // caro is now full, but the server's cached numbers still say it has room
  up = await upload(ravi, 'documents', 'overflow.pdf', Buffer.alloc(6000, 7), 'application/pdf');
  check('upload still succeeds', up.status === 200, up);
  check('it was stored in the next account with room (the main one), not the full one', await ownerOf('overflow.pdf') === MAIN, await ownerOf('overflow.pdf'));
  check('downloads of the fallback file work', (await asha.rawGet(`/api/files/${up.data.id}/content`)).data.equals(Buffer.alloc(6000, 7)));
  check('files already on the full account are still readable', (await asha.rawGet(`/api/files/${caroFile.id}/content`)).data.equals(photo));
  check('no duplicate copy was left behind on the full account', (await mstate()).files.filter(f => f.name === 'overflow.pdf').length === 1);

  section('F. Removing an account is safe');
  r = await ravi.post(`/api/drive/accounts/${caroId}/disconnect`);
  check('a member cannot remove an account', r.status === 403);
  r = await asha.post(`/api/drive/accounts/${caroId}/disconnect`);
  check('an account that still holds files cannot be removed (they would become unreachable)', r.status === 409 && /1 file is stored/i.test(r.data.error), r);
  check('unknown account id → 404', (await asha.post('/api/drive/accounts/nope/disconnect')).status === 404);
  check('another family cannot remove our account', (await zed.post(`/api/drive/accounts/${caroId}/disconnect`)).status === 404);
  check('the uploader deletes the file (removed from the correct account)', (await ravi.del('/api/files/' + caroFile.id)).status === 200 && !(await mstate()).files.some(f => f.name === 'diwali.jpg'));
  const tokensBefore = (await mstate()).tokens.filter(t => t.account === CARO && t.revoked).length;
  r = await asha.post(`/api/drive/accounts/${caroId}/disconnect`);
  check('now the empty account can be removed', r.status === 200, r);
  check('its Google authorisation is revoked', (await mstate()).tokens.filter(t => t.account === CARO && t.revoked).length > tokensBefore);
  st = (await asha.get('/api/drive/status')).data;
  check('pool shrinks back to two accounts', st.pool.accounts === 2 && !st.accounts.some(a => a.account === CARO), st.pool);

  section('G. An account whose authorisation is revoked');
  // put a file on bob: make the main account look full so bob is the only one with room
  await ctl({ limit: { acct: MAIN, bytes: 2 * 1048576 } });
  await restart(); await relogin();
  up = await upload(ravi, 'photos', 'bobfile.jpg', photo);
  check('with the main account full, the file goes to the extra account', up.status === 200 && await ownerOf('bobfile.jpg') === BOB, [up.status, await ownerOf('bobfile.jpg')]);
  const bobFile = up.data;
  await ctl({ limit: { acct: MAIN, bytes: FULL } });
  await ctl({ revokeAcct: BOB });
  await restart(); await relogin();
  up = await upload(ravi, 'photos', 'after-revoke.jpg', Buffer.from('still works'));
  check('uploads keep working through the other accounts', up.status === 200 && await ownerOf('after-revoke.jpg') === MAIN, [up.status, await ownerOf('after-revoke.jpg')]);
  dl = await asha.rawGet(`/api/files/${bobFile.id}/content`);
  check('a file on the revoked account says so clearly (not a vague error)', dl.status === 503 && /expired|revoked|add it again/i.test(dl.data.toString()), [dl.status, dl.data.toString().slice(0, 150)]);
  st = (await asha.get('/api/drive/status')).data;
  check('status reports that account as expired', st.accounts.length === 1 && st.accounts[0].status === 'expired', st.accounts);
  r = await connect(asha, 'good-code-bobdrive');
  check('adding the same account again re-authorises it', /drive=connected/.test(r.location), r.location);
  st = (await asha.get('/api/drive/status')).data;
  check('…it is the same entry, now connected', st.accounts.length === 1 && st.accounts[0].id === bobId && st.accounts[0].status === 'connected', st.accounts);
  check('…and its files are reachable again', (await asha.rawGet(`/api/files/${bobFile.id}/content`)).data.equals(photo));

  section('H. Every account full');
  await ctl({ limit: { acct: MAIN, bytes: 1048576 } }); await ctl({ limit: { acct: BOB, bytes: 1048576 } });
  await restart(); await relogin();
  const before = (await asha.get('/api/files')).data.length;
  up = await upload(ravi, 'photos', 'nowhere.jpg', Buffer.from('x'.repeat(100)));
  check('clear message that every account is full (HTTP 507)', up.status === 507 && /every connected account/i.test(up.data.error), up);
  check('…and nothing was recorded', (await asha.get('/api/files')).data.length === before);
  await ctl({ limit: { acct: MAIN, bytes: FULL } }); await ctl({ limit: { acct: BOB, bytes: FULL } });

  section('I. Secrets and cleaning up');
  const dbBytes = ['', '-wal'].map(x => fs.existsSync(path.join(DATA, 'kataria.sqlite' + x)) ? fs.readFileSync(path.join(DATA, 'kataria.sqlite' + x)).toString('latin1') : '').join('');
  ms = await mstate();
  check('extra-account refresh tokens are NOT stored in plain text', ms.tokens.length > 2 && ms.tokens.every(t => !dbBytes.includes(t.token)));
  const dump = JSON.stringify([(await asha.get('/api/drive/status')).data, (await asha.get('/api/files')).data, (await asha.get('/api/family')).data]);
  check('no token appears in any API response', ms.tokens.every(t => !dump.includes(t.token)) && ms.accessTokens.every(t => !dump.includes(t)));
  const live = ms.tokens.filter(t => !t.revoked).map(t => t.token);
  r = await asha.del('/api/family', { password: PW });
  check('deleting the family succeeds', r.status === 200, r);
  const after = await mstate();
  check('…and revokes every Google account it had connected', live.filter(t => !discarded.has(t)).length > 0 && live.filter(t => !discarded.has(t)).every(t => after.tokens.find(x => x.token === t).revoked), after.tokens.filter(t => live.includes(t.token) && !discarded.has(t.token) && !t.revoked).map(t => t.account));
  check('…and removes the files from every account', !after.files.some(f => f.data && ['diwali.jpg', 'bobfile.jpg', 'after-revoke.jpg'].includes(f.name)), after.files.filter(f => f.data).map(f => f.name));

  await stopServer(); await mock.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\nPool suite: ${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(async e => { console.error('Pool test runner crashed:', e); try { await stopServer(); } catch (_) {} try { await mock.close(); } catch (_) {} process.exit(1); });
