// Phone notifications: a message to someone whose app is closed must reach their push service, and the keys must survive a restart.
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');
process.env.SINGLE_CLAN = 'off';
const PORT = 4100 + Math.floor(Math.random() * 300), PUSHPORT = PORT + 400, DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-push-')), BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0; const check = (n, c, d) => { c ? passed++ : failed++; console.log(`  ${c ? '✓' : '✗'} ${n}${c ? '' : ' ' + (d ? JSON.stringify(d) : '')}`); };
const PW = 'correct-horse-9';
// Minimal zip reader (reads the central directory) so the test can look inside the APK without extra packages.
function zipEntry(buf, name) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) return null;
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nlen) === name) {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + csize);
      return method === 0 ? data : require('zlib').inflateRawSync(data);
    }
    p += 46 + nlen + elen + clen;
  }
  return null;
}
async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => !c.endsWith('='));
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: sc };
}
let proc;
const start = () => new Promise((res, rej) => {
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUSH_TEST: '1', SECRET_KEY: 'test-secret-key-for-push-0123456789', BASE_URL: 'https://example.onrender.com', ANDROID_PACKAGE: 'com.example.app', ANDROID_SHA256: 'aa:bb:cc' } });
  let o = ''; proc.stdout.on('data', d => { o += d; if (o.includes('running on port')) res(); }); proc.stderr.on('data', d => { o += d; }); setTimeout(() => rej(new Error('start timeout\n' + o)), 10000);
});
const stop = () => new Promise(r => { proc.on('exit', r); proc.kill(); });
(async () => {
  const hits = []; const fake = http.createServer((req, res) => { hits.push({ url: req.url, auth: req.headers.authorization || '', ttl: req.headers.ttl }); res.statusCode = 201; res.end(); });
  await new Promise(r => fake.listen(PUSHPORT, '127.0.0.1', r));
  await start();
  console.log('Phone notifications');
  const a = await call('', 'POST', '/api/auth/register', { name: 'Leader', email: 'leader@example.com', password: PW });
  const key1 = (await call(a.cookie, 'GET', '/api/push/config')).data.publicKey;
  check('server has a push public key', typeof key1 === 'string' && key1.length > 80, key1);
  await call(a.cookie, 'POST', '/api/family', { name: 'Hindu Esports' });
  const inv = (await call(a.cookie, 'POST', '/api/invites', { maxUses: 2, days: 7 })).data;
  const b = await call('', 'POST', '/api/auth/register', { name: 'Player Two', email: 'two@example.com', password: PW });
  await call(b.cookie, 'POST', '/api/family/join', { code: inv.code });
  const sub = await call(b.cookie, 'POST', '/api/push/subscribe', { endpoint: `http://127.0.0.1:${PUSHPORT}/phone-b`, keys: { p256dh: 'x', auth: 'y' } });
  check('phone can register for alerts', sub.status === 200, sub);
  check('a non-https address is refused outside tests', (await call(b.cookie, 'POST', '/api/push/subscribe', { endpoint: 'http://evil.example/x' })).status === 400);
  const rooms = (await call(a.cookie, 'GET', '/api/rooms')).data; const list = rooms.rooms || rooms; const general = list.find(r => r.type !== 'dm') || list[0];
  const sent = await call(a.cookie, 'POST', `/api/rooms/${general.id}/messages`, { text: 'Match at 9 PM, be ready!' });
  check('message sent', sent.status === 200 || sent.status === 201, sent.status);
  await new Promise(r => setTimeout(r, 600));
  check('push service was called for the offline player', hits.length === 1 && hits[0].url === '/phone-b', hits);
  check('call is signed (VAPID) and urgent', /^vapid t=.+, k=.+/.test(hits[0]?.auth || '') && (hits[0]?.auth || '').includes(key1), hits[0]);
  const latest = await call(b.cookie, 'GET', '/api/notifications/latest');
  check('phone shows who wrote and what', /Leader/.test(latest.data.title) && latest.data.body === 'Match at 9 PM, be ready!', latest.data);
  const again = await call(b.cookie, 'GET', '/api/notifications/latest');
  check('the preview is used once', again.data.body !== 'Match at 9 PM, be ready!', again.data);
  const own = await call(a.cookie, 'GET', '/api/notifications/latest');
  check('sender gets no alert about own message', hits.length === 1 && own.data.body !== 'Match at 9 PM, be ready!', own.data);
  const al = await fetch(BASE + '/.well-known/assetlinks.json'); const alj = await al.json().catch(() => null);
  check('Android app link file is published', al.status === 200 && alj?.[0]?.target?.package_name === 'com.example.app' && alj[0].target.sha256_cert_fingerprints[0] === 'AA:BB:CC', alj);
  check('Android app link file is plain JSON (Android requires it)', /^application\/json/.test(al.headers.get('content-type') || ''), al.headers.get('content-type'));
  // The Android app (APK): downloadable as a file, and really the clan's app.
  const apk = await fetch(BASE + '/hindu-esports.apk'); const buf = Buffer.from(await apk.arrayBuffer());
  check('Android app (APK) downloads as a file', apk.status === 200 && apk.headers.get('content-type') === 'application/vnd.android.package-archive' && /^attachment/.test(apk.headers.get('content-disposition') || '') && Number(apk.headers.get('content-length')) === buf.length && buf.length > 50000, { s: apk.status, t: apk.headers.get('content-type'), n: buf.length });
  const manifest = zipEntry(buf, 'AndroidManifest.xml');
  const has = (b, s) => b && (b.includes(Buffer.from(s, 'utf8')) || b.includes(Buffer.from(s, 'utf16le')));
  check('APK is the Hindu Esports app for this website', has(manifest, 'com.hinduesports.clan') && has(manifest, 'hindu-esports.onrender.com') && has(manifest, 'android.support.customtabs.action.CustomTabsService'), manifest && manifest.length);
  check('APK carries the app code and a v2 signature', !!zipEntry(buf, 'classes.dex') && buf.includes(Buffer.from('APK Sig Block 42')), null);
  await stop(); await start();
  const a2 = await call('', 'POST', '/api/auth/login', { email: 'leader@example.com', password: PW });
  const key2 = (await call(a2.cookie, 'GET', '/api/push/config')).data.publicKey;
  check('push key is the same after a restart (phones stay subscribed)', !!key1 && key1 === key2, { key1, key2 });
  await stop(); fake.close(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); try { proc.kill(); } catch (_) {} process.exit(1); });
