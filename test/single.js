// Only the first account may create the clan; everyone else must join with a code.
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const PORT = 3800 + Math.floor(Math.random() * 300), DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-single-')), BASE = `http://127.0.0.1:${PORT}`;
let passed = 0, failed = 0; const check = (n, c) => { c ? passed++ : failed++; console.log(`  ${c ? '\u2713' : '\u2717'} ${n}`); };
async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).find(c => !c.endsWith('='));
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: sc };
}
(async () => {
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }; delete env.SINGLE_CLAN;
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server', 'index.js')], { env });
  await new Promise((res, rej) => { let o = ''; proc.stdout.on('data', d => { o += d; if (o.includes('running on port')) res(); }); setTimeout(() => rej(new Error('start timeout')), 10000); });
  console.log('Single clan rule');
  const a = await call('', 'POST', '/api/auth/register', { name: 'Leader', email: 'leader@example.com', password: 'correct-horse-9' });
  check('first account is allowed to create a clan', (await call(a.cookie, 'GET', '/api/me')).data.canCreateClan === true);
  check('first account creates the clan', (await call(a.cookie, 'POST', '/api/family', { name: 'Hindu Esports' })).status === 200);
  const b = await call('', 'POST', '/api/auth/register', { name: 'Member', email: 'member@example.com', password: 'correct-horse-9' });
  check('later account is not offered clan creation', (await call(b.cookie, 'GET', '/api/me')).data.canCreateClan === false);
  const r = await call(b.cookie, 'POST', '/api/family', { name: 'Rival Clan' });
  check('later account cannot create a clan (server refuses)', r.status === 400);
  proc.kill(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
