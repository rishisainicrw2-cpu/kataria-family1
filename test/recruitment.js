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

// Cookie-aware client, for the admin-review endpoints (which need a logged-in clan member).
class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const headers = {}; if (this.cookie) headers.cookie = this.cookie;
    let payload; if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => null) : await r.text() };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  patch(u, b = {}) { return this.req('PATCH', u, b); }
}
const PW = 'correct-horse-9';
async function register(email) { const c = new Client(); const r = await c.post('/api/auth/register', { name: 'User ' + email, email, password: PW }); return { c, r }; }

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

  section('Admin review: setup');
  const { c: leader } = await register('leader@example.com');
  check('leader creates the clan', (await leader.post('/api/family', { name: 'Hindu Esports' })).status === 200);
  const inv = (await leader.post('/api/invites', { maxUses: 5, days: 7 })).data;
  const { c: member } = await register('member@example.com');
  check('regular member joins the clan', (await member.post('/api/family/join', { code: inv.code })).status === 200);
  const outsider = (await register('outsider@example.com')).c;

  section('Admin review: access control');
  check('a logged-out request cannot list applications', (await call('GET', '/api/recruitment/applications')).status === 401);
  check('a clan member with no recruitment permission is forbidden', (await member.get('/api/recruitment/applications')).status === 403);
  check('a user outside the clan entirely is refused', [401, 403, 409].includes((await outsider.get('/api/recruitment/applications')).status));
  const asLeader = await leader.get('/api/recruitment/applications');
  check('the clan leader (owner) can list applications', asLeader.status === 200, asLeader.data);
  check('the list includes the applications submitted earlier', asLeader.data?.applications?.some(a => a.code === code));
  check('counts summary is included', typeof asLeader.data?.counts?.total === 'number');

  section('Admin review: granting the recruitment permission to a regular member');
  const fam = (await leader.get('/api/family')).data;
  const memberId = fam.members.find(m => m.name === 'User member@example.com')?.id;
  check('member found in clan roster', !!memberId, fam.members);
  check('leader grants the recruitment permission', (await leader.patch('/api/members/' + memberId, { perms: { recruitment: true } })).status === 200);
  check('member can now list applications', (await member.get('/api/recruitment/applications')).status === 200);

  section('Admin review: viewing and acting on an application');
  const appId = asLeader.data.applications.find(a => a.code === code).id;
  const detail = await leader.get('/api/recruitment/applications/' + appId);
  check('full detail is returned, including contact info', detail.status === 200 && detail.data.contact === 'rohit@example.com', detail.data);
  check('an empty history is returned before any status change', Array.isArray(detail.data.history) && detail.data.history.length === 0);

  const upd = await leader.patch('/api/recruitment/applications/' + appId, { status: 'trial_invited', adminNotes: 'Good aim, invite to trial', note: 'Looks promising' });
  check('admin can move an application to Trial Invited with notes', upd.status === 200 && upd.data.status === 'trial_invited', upd.data);

  const afterUpd = await leader.get('/api/recruitment/applications/' + appId);
  check('the status change is recorded in the audit history', afterUpd.data.history?.length === 1 && afterUpd.data.history[0].toStatus === 'trial_invited', afterUpd.data.history);
  check('the public status endpoint reflects the new status too', (await call('GET', '/api/recruitment/status/' + code)).data.status === 'trial_invited');

  const bad = await leader.patch('/api/recruitment/applications/' + appId, { status: 'not-a-real-status' });
  check('an invalid status value is rejected', bad.status === 400);

  section('Regression: existing app untouched');
  const reg = await call('POST', '/api/auth/register', { name: 'Leader2', email: 'leader2@example.com', password: 'correct-horse-9' });
  check('normal registration still works', reg.status === 200, reg.data);
  check('main app home page is unaffected', (await call('GET', '/')).status === 200);
  check('scrims page is unaffected', (await call('GET', '/scrims')).status === 200);

  section('Rate limiting (last: this trips the status-check limiter for this IP)');
  let limited = false;
  for (let i = 0; i < 30; i++) { const r = await call('GET', '/api/recruitment/status/ZZZZ-ZZZZ'); if (r.status === 429) { limited = true; break; } }
  check('repeated status checks eventually get rate-limited', limited);

  await stopServer();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error(e); try { await stopServer(); } catch (_) {} process.exit(1); });
