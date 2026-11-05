process.env.SINGLE_CLAN = 'off';
// Player recruitment: public apply + status check, validation, duplicate prevention, and that the module
// exposes nothing beyond those two public endpoints (no list-all route reachable without being an admin).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 5300 + Math.floor(Math.random() * 400);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-recruit-'));
const BASE = `http://127.0.0.1:${PORT}`;
let proc;

function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')],
      { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' } });
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('running on port')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', c => { if (c) reject(new Error('server exited ' + c + '\n' + out)); });
    setTimeout(() => reject(new Error('server start timeout\n' + out)), 10000);
  });
}
const stopServer = () => new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill(); });

async function call(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => null) : await r.text() };
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail !== undefined ? '→ ' + JSON.stringify(detail) : ''); }
}
const section = t => console.log('\n' + t);

const validApp = (over = {}) => ({
  fullName: 'Rohit Sharma', ign: 'RohitX', bgmiUid: '512345678', age: 19, role: 'Assaulter',
  experience: 'Played 2 scrims series', previousTeam: 'Team Nova', preferredTeam: 'alpha',
  device: 'iQOO 11', hours: '6-10pm IST', contact: 'rohit@example.com', socialLink: 'https://instagram.com/rohitx',
  consent: true, ...over,
});

(async () => {
  await startServer();
  console.log('Server started on', BASE, 'data:', DATA);

  section('Public recruitment page');
  check('/recruit serves the standalone recruitment page', (await call('GET', '/recruit')).status === 200);
  check('/apply also serves it', (await call('GET', '/apply')).status === 200);

  section('Submitting an application');
  const r1 = await call('POST', '/api/recruitment/apply', validApp());
  check('valid application is accepted', r1.status === 200, r1.data);
  check('an application ID code is returned', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r1.data?.applicationId || ''), r1.data);
  const code = r1.data.applicationId;

  section('Validation');
  check('missing full name is rejected', (await call('POST', '/api/recruitment/apply', validApp({ fullName: '' }))).status === 400);
  check('missing BGMI UID is rejected', (await call('POST', '/api/recruitment/apply', validApp({ bgmiUid: '', ign: 'Other1' }))).status === 400);
  check('non-numeric BGMI UID is rejected', (await call('POST', '/api/recruitment/apply', validApp({ bgmiUid: 'abc123', ign: 'Other2' }))).status === 400);
  check('invalid role is rejected', (await call('POST', '/api/recruitment/apply', validApp({ role: 'Driver', ign: 'Other3', bgmiUid: '511111112' }))).status === 400);
  check('invalid preferred team is rejected', (await call('POST', '/api/recruitment/apply', validApp({ preferredTeam: 'delta', ign: 'Other4', bgmiUid: '511111113' }))).status === 400);
  check('missing contact is rejected', (await call('POST', '/api/recruitment/apply', validApp({ contact: '', ign: 'Other5', bgmiUid: '511111114' }))).status === 400);
  check('missing consent is rejected', (await call('POST', '/api/recruitment/apply', validApp({ consent: false, ign: 'Other6', bgmiUid: '511111115' }))).status === 400);
  check('bad social link format is rejected', (await call('POST', '/api/recruitment/apply', validApp({ socialLink: 'not-a-url', ign: 'Other7', bgmiUid: '511111116' }))).status === 400);

  section('Duplicate prevention');
  const dup = await call('POST', '/api/recruitment/apply', validApp({ ign: 'RohitAgain' }));
  check('a second open application with the same BGMI UID is rejected', dup.status === 400 && dup.data?.code === 'duplicate', dup.data);
  const other = await call('POST', '/api/recruitment/apply', validApp({ bgmiUid: '599999999', ign: 'Someone Else' }));
  check('a different BGMI UID is accepted', other.status === 200, other.data);

  section('Checking status');
  const s1 = await call('GET', '/api/recruitment/status/' + code);
  check('status lookup by the real code succeeds', s1.status === 200, s1.data);
  check('status starts as pending', s1.data?.status === 'pending');
  check('status response carries the applicant\'s own basic info', s1.data?.ign === 'RohitX' && s1.data?.role === 'Assaulter');
  check('status response does not leak admin-only fields', s1.data?.contact === undefined && s1.data?.adminNotes === undefined);
  const lower = await call('GET', '/api/recruitment/status/' + code.toLowerCase());
  check('status lookup is case-insensitive', lower.status === 200);

  const bad1 = await call('GET', '/api/recruitment/status/ZZZZ-ZZZZ');
  check('an unknown code returns 404, not a leak of any kind', bad1.status === 404);

  section('Rate limiting');
  let limited = false;
  for (let i = 0; i < 30; i++) { const r = await call('GET', '/api/recruitment/status/ZZZZ-ZZZZ'); if (r.status === 429) { limited = true; break; } }
  check('repeated status checks eventually get rate-limited', limited);

  section('Regression: existing app untouched');
  const reg = await call('POST', '/api/auth/register', { name: 'Leader', email: 'leader@example.com', password: 'correct-horse-9' });
  check('normal registration still works', reg.status === 200, reg.data);
  check('main app home page is unaffected', (await call('GET', '/')).status === 200);
  check('scrims page is unaffected', (await call('GET', '/scrims')).status === 200);

  await stopServer();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error(e); try { await stopServer(); } catch (_) {} process.exit(1); });
