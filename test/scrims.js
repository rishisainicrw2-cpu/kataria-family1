process.env.SINGLE_CLAN = 'off';
// Scrims & Tournaments: valid invites, invalid codes, revoked/exhausted links, external (non-clan) users,
// existing clan members, admin management, and unauthorized API access — plus a regression check that the
// main clan app is untouched.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 4900 + Math.floor(Math.random() * 400);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-scrims-'));
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

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body) {
    const headers = {}; if (this.cookie) headers.cookie = this.cookie;
    let payload; if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() || []) { const kv = c.split(';')[0]; this.cookie = kv.endsWith('=') ? '' : kv; }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json().catch(() => null) : await r.text();
    return { status: r.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  patch(u, b = {}) { return this.req('PATCH', u, b); }
  del(u, b) { return this.req('DELETE', u, b); }
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, detail !== undefined ? '→ ' + JSON.stringify(detail) : ''); }
}
const section = t => console.log('\n' + t);
const PW = 'correct-horse-9';
async function register(email) { const c = new Client(); const r = await c.post('/api/auth/register', { name: 'User ' + email, email, password: PW }); return { c, r }; }

(async () => {
  await startServer();
  console.log('Server started on', BASE, 'data:', DATA);

  section('Setup: clan + leader + a regular member');
  const { c: leader } = await register('leader@example.com');
  check('leader creates the clan', (await leader.post('/api/family', { name: 'Hindu Esports' })).status === 200);
  const inv = (await leader.post('/api/invites', { maxUses: 5, days: 7 })).data;
  const { c: member } = await register('member@example.com');
  check('regular member joins the clan', (await member.post('/api/family/join', { code: inv.code })).status === 200);

  section('Unauthorized API access');
  check('anonymous cannot list scrims invites', (await new Client().get('/api/scrims/invites')).status === 401);
  check('anonymous cannot create scrims invites', (await new Client().post('/api/scrims/invites', { label: 'x' })).status === 401);
  check('regular clan member cannot manage scrims invites (not an admin)', (await member.post('/api/scrims/invites', { label: 'x' })).status === 403);
  check('anonymous cannot read scrims messages without joining', (await new Client().get('/api/scrims/messages')).status === 401);
  check('regular clan member cannot read scrims messages (never joined)', (await member.get('/api/scrims/messages')).status === 401);
  check('regular clan member cannot post scrims messages', (await member.post('/api/scrims/messages', { text: 'hi' })).status === 401);

  section('Valid invitations');
  const si = (await leader.post('/api/scrims/invites', { label: 'Open invite', maxUses: 2, days: 3 })).data;
  check('scrims invite created with a code', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(si.code), si);
  check('scrims invite code differs from clan invite code format usage (separate system)', si.id !== inv.id);
  const player1 = new Client();
  const j1 = await player1.post('/api/scrims/join', { code: si.code, name: 'ProGamer1' });
  check('valid invite lets an external player join', j1.status === 200, j1);
  check('joined player identity is reported correctly', (await player1.get('/api/scrims/me')).data.kind === 'player');
  check('external player did NOT become a clan member', (await player1.get('/api/me')).status === 401); // no kf_session was ever issued

  section('Invalid / revoked / exhausted codes');
  check('garbage code rejected', (await new Client().post('/api/scrims/join', { code: 'ZZZZ-ZZZZ', name: 'X' })).status === 400);
  check('missing name rejected', (await new Client().post('/api/scrims/join', { code: si.code, name: '' })).status === 400);
  const player2 = new Client();
  check('second use of a 2-use invite succeeds', (await player2.post('/api/scrims/join', { code: si.code, name: 'ProGamer2' })).status === 200);
  const player3 = new Client();
  check('third use of a 2-use invite is rejected (exhausted)', (await player3.post('/api/scrims/join', { code: si.code, name: 'ProGamer3' })).status === 400);
  const si2 = (await leader.post('/api/scrims/invites', { label: 'To revoke' })).data;
  check('revoke invite', (await leader.del('/api/scrims/invites/' + si2.id)).status === 200);
  check('revoked invite can no longer be used', (await new Client().post('/api/scrims/join', { code: si2.code, name: 'Late' })).status === 400);
  const si3 = (await leader.post('/api/scrims/invites', { label: 'To disable' })).data;
  check('disable (soft revoke) invite', (await leader.patch('/api/scrims/invites/' + si3.id, { revoked: true })).status === 200);
  check('disabled invite rejected', (await new Client().post('/api/scrims/join', { code: si3.code, name: 'X' })).status === 400);
  check('re-enable invite', (await leader.patch('/api/scrims/invites/' + si3.id, { revoked: false })).status === 200);
  check('re-enabled invite works again', (await new Client().post('/api/scrims/join', { code: si3.code, name: 'X2' })).status === 200);
  const regen = (await leader.post(`/api/scrims/invites/${si3.id}/regenerate`)).data;
  check('regenerate produces a new code', regen.code !== si3.code, regen);
  check('old code stops working after regenerate', (await new Client().post('/api/scrims/join', { code: si3.code, name: 'OldCode' })).status === 400);
  check('new code works after regenerate', (await new Client().post('/api/scrims/join', { code: regen.code, name: 'NewCode' })).status === 200);

  section('Isolated chat: messaging, announcements, room info, moderation');
  check('player can post a message', (await player1.post('/api/scrims/messages', { text: 'gg ready for scrims' })).status === 200);
  const msgs1 = (await player1.get('/api/scrims/messages')).data;
  check('message shows up for another joined player', msgs1.some(m => m.text === 'gg ready for scrims'));
  check('player cannot post an announcement', (await player1.post('/api/scrims/messages', { text: 'fake', kind: 'announcement' })).status === 403);
  check('player cannot post room info', (await player1.post('/api/scrims/messages', { text: '{}', kind: 'room' })).status === 403);
  check('admin (leader) can view the scrims chat via their normal account', (await leader.get('/api/scrims/messages')).status === 200);
  check('admin can post a pinned announcement', (await leader.post('/api/scrims/messages', { text: 'Round starts 8 PM', kind: 'announcement' })).status === 200);
  const pinned = (await leader.get('/api/scrims/pinned')).data;
  check('announcement is pinned', pinned.some(m => m.text === 'Round starts 8 PM' && m.pinned));
  const roomMsg = await leader.post('/api/scrims/messages', { text: JSON.stringify({ roomId: 'RM123', password: 'hunter2' }), kind: 'room' });
  check('admin can post room ID / password info', roomMsg.status === 200);
  check('room credentials are visible only inside the authorized chat (not on an unauthenticated read)', (await new Client().get('/api/scrims/messages')).status === 401);
  const toDelete = await player2.post('/api/scrims/messages', { text: 'spammy nonsense' });
  check('player cannot delete a message', (await player1.del('/api/scrims/messages/' + toDelete.data.id)).status === 403);
  check('player can report a message', (await player1.post(`/api/scrims/messages/${toDelete.data.id}/report`, { reason: 'spam' })).status === 200);
  check('admin can delete a message', (await leader.del('/api/scrims/messages/' + toDelete.data.id)).status === 200);
  const afterDel = (await leader.get('/api/scrims/messages')).data.find(m => m.id === toDelete.data.id);
  check('deleted message text is cleared', afterDel && afterDel.deleted && afterDel.text === '');

  section('Admin participant management');
  const parts = (await leader.get('/api/scrims/participants')).data;
  check('admin can list participants', parts.some(p => p.name === 'ProGamer1'));
  const p2 = parts.find(p => p.name === 'ProGamer2');
  check('admin can remove a participant', (await leader.del('/api/scrims/participants/' + p2.id)).status === 200);
  check('removed participant session is revoked immediately', (await player2.get('/api/scrims/me')).status === 401);
  check('removed participant cannot read messages any more', (await player2.get('/api/scrims/messages')).status === 401);

  section('Leaving');
  check('player can leave', (await player1.post('/api/scrims/leave')).status === 200);
  check('after leaving, session no longer works', (await player1.get('/api/scrims/me')).status === 401);

  section('Isolation: dedicated routes, no clan branding, main app untouched');
  const joinPage = await fetch(BASE + '/join-scrims?code=' + si.code);
  const joinHtml = await joinPage.text();
  check('/join-scrims serves the standalone Scrims page', joinPage.status === 200 && joinHtml.includes('Scrims'));
  check('/join-scrims page does not mention the clan brand', !/HINDU ESPORTS/i.test(joinHtml));
  const scrimsPage = await fetch(BASE + '/scrims');
  const scrimsHtml = await scrimsPage.text();
  check('/scrims serves the standalone Scrims page too', scrimsPage.status === 200 && scrimsHtml.includes('Scrims'));
  check('/scrims page does not mention the clan brand', !/HINDU ESPORTS/i.test(scrimsHtml));
  const mainPage = await fetch(BASE + '/');
  const mainHtml = await mainPage.text();
  check('main app home page is unaffected and still the clan app', mainPage.status === 200 && /HINDU ESPORTS/i.test(mainHtml));
  check('main app does not reference scrims internals', !/scrims_session/i.test(mainHtml));

  await stopServer(); fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(async e => { console.error(e); try { await stopServer(); } catch (_) {} process.exit(1); });
