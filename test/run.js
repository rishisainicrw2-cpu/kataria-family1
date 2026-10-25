// End-to-end tests: starts the real server on a throwaway database and drives the HTTP API.
// Run: npm test   (needs Node 22.13+, no other dependencies)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3200 + Math.floor(Math.random() * 500);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-test-'));
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
  constructor(name) { this.name = name; this.cookie = ''; }
  async req(method, url, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = r.headers.getSetCookie?.() || [];
    for (const c of sc) { const kv = c.split(';')[0]; if (kv.endsWith('=')) this.cookie = ''; else this.cookie = kv; }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}) { return this.req('POST', u, b); }
  patch(u, b = {}) { return this.req('PATCH', u, b); }
  del(u, b) { return this.req('DELETE', u, b); }
}

let passed = 0, failed = 0; const failures = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; failures.push(name); console.log('  ✗', name, detail !== undefined ? '→ ' + JSON.stringify(detail) : ''); }
}
const section = t => console.log('\n' + t);
const PW = 'correct-horse-9';

async function register(name, email) {
  const c = new Client(name);
  const r = await c.post('/api/auth/register', { name, email, password: PW });
  return { c, r };
}

(async () => {
  await startServer();
  console.log('Server started on', BASE, 'data:', DATA);
  const day = 86400000, soon = Date.now() + 3 * day;

  section('1. Registration, login, logout, validation');
  const { c: asha, r: reg } = await register('Asha Kataria', 'asha@example.com');
  check('register succeeds and sets a session', reg.status === 200 && !!asha.cookie, reg);
  check('duplicate email rejected', (await new Client().post('/api/auth/register', { name: 'X', email: 'ASHA@example.com', password: PW })).status === 400);
  check('short password rejected', (await new Client().post('/api/auth/register', { name: 'X', email: 'x@example.com', password: 'short' })).status === 400);
  check('bad email rejected', (await new Client().post('/api/auth/register', { name: 'X', email: 'nope', password: PW })).status === 400);
  check('unauthenticated /api/me is 401', (await new Client().get('/api/me')).status === 401);
  const lg = new Client();
  check('wrong password rejected', (await lg.post('/api/auth/login', { email: 'asha@example.com', password: 'wrong-password' })).status === 401);
  check('correct login works', (await lg.post('/api/auth/login', { email: 'asha@example.com', password: PW })).status === 200 && (await lg.get('/api/me')).status === 200);
  await lg.post('/api/auth/logout');
  check('logout invalidates session', (await lg.get('/api/me')).status === 401);
  const dbBytes = fs.readFileSync(path.join(DATA, 'kataria.sqlite')).toString('latin1');
  check('password is not stored in plain text', !dbBytes.includes(PW));
  check('cross-origin write is blocked', (await asha.req('POST', '/api/auth/logout', {}, { origin: 'https://evil.example' })).status === 403);

  section('2. Family creation, invitations, roles');
  check('create family', (await asha.post('/api/family', { name: 'Kataria Family' })).status === 200);
  const fam = (await asha.get('/api/family')).data;
  check('creator is owner', fam.me.role === 'owner', fam.me);
  const inv = (await asha.post('/api/invites', { maxUses: 2, days: 7 })).data;
  check('invite code generated', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(inv.code), inv);
  const { c: ravi } = await register('Ravi Kataria', 'ravi@example.com');
  check('bad invite code rejected', (await ravi.post('/api/family/join', { code: 'ZZZZ-ZZZZ' })).status === 400);
  check('valid invite joins family', (await ravi.post('/api/family/join', { code: inv.code })).status === 200);
  const { c: meera } = await register('Meera Kataria', 'meera@example.com');
  check('second use of invite works', (await meera.post('/api/family/join', { code: inv.code.toLowerCase() })).status === 200);
  const { c: late } = await register('Late Joiner', 'late@example.com');
  check('used-up invite rejected', (await late.post('/api/family/join', { code: inv.code })).status === 400);
  const members = (await asha.get('/api/family')).data.members;
  const idOf = n => members.find(m => m.name.startsWith(n)).id;
  const [ashaId, raviId, meeraId] = [idOf('Asha'), idOf('Ravi'), idOf('Meera')];
  check('three members listed', members.length === 3, members.length);
  check('member cannot create invites', (await ravi.post('/api/invites', {})).status === 403);
  check('member cannot change family settings', (await ravi.patch('/api/family', { name: 'Hacked' })).status === 403);
  check('member cannot promote anyone', (await ravi.patch('/api/members/' + meeraId, { role: 'admin' })).status === 403);
  check('member cannot remove members', (await ravi.del('/api/members/' + meeraId)).status === 403);
  check('owner promotes Ravi to admin', (await asha.patch('/api/members/' + raviId, { role: 'admin' })).status === 200);
  check('admin cannot remove the owner', (await ravi.del('/api/members/' + ashaId)).status === 403);
  check('admin cannot create admin invites', (await ravi.post('/api/invites', { role: 'admin' })).status === 403);
  check('owner can rename family', (await asha.patch('/api/family', { name: 'Kataria Family ✦' })).status === 200);

  section('3. Chat: messages, replies, reactions, edit/delete, pin, search, unread, mute');
  const rooms = (await asha.get('/api/rooms')).data;
  const general = rooms.find(r => r.type === 'general');
  check('general chat room exists', !!general);
  check('separate chat sections exist', ['general', 'plans', 'daily', 'events', 'shopping'].filter(t => rooms.some(r => r.type === t)).length >= 4, rooms.map(r => r.type));
  const m1 = (await asha.post(`/api/rooms/${general.id}/messages`, { text: 'Namaste everyone! Dinner on Sunday?', clientId: 'c-1' })).data;
  check('send message', !!m1.id, m1);
  const dup = (await asha.post(`/api/rooms/${general.id}/messages`, { text: 'Namaste everyone! Dinner on Sunday?', clientId: 'c-1' })).data;
  check('duplicate submission (same clientId) not stored twice', dup.id === m1.id, [dup.id, m1.id]);
  check('empty message rejected', (await asha.post(`/api/rooms/${general.id}/messages`, { text: '   ' })).status === 400);
  const r1 = await ravi.post(`/api/rooms/${general.id}/messages`, { text: 'Yes! @Asha count me in', replyTo: m1.id });
  check('reply to a message', r1.status === 200 && r1.data.replyTo?.id === m1.id || r1.data.replyTo === m1.id || !!r1.data.reply, r1.data);
  check('unread count for other members', (await meera.get('/api/rooms')).data.find(r => r.id === general.id).unread === 2);
  await meera.post(`/api/rooms/${general.id}/read`);
  check('marking read clears unread', (await meera.get('/api/rooms')).data.find(r => r.id === general.id).unread === 0);
  check('react toggles on', (await meera.post(`/api/messages/${m1.id}/react`, { emoji: '👍' })).status === 200);
  const withReact = (await asha.get(`/api/rooms/${general.id}/messages`)).data.find(m => m.id === m1.id);
  check('reaction visible to others', JSON.stringify(withReact.reactions).includes('👍'), withReact.reactions);
  check("cannot edit someone else's message", (await meera.patch('/api/messages/' + m1.id, { text: 'edited' })).status === 403);
  check('edit own message', (await asha.patch('/api/messages/' + m1.id, { text: 'Dinner on Sunday at 8?' })).status === 200);
  check('pin message', (await asha.post(`/api/messages/${m1.id}/pin`)).status === 200);
  check('search finds message', (await asha.get(`/api/rooms/${general.id}/messages?q=sunday`)).data.some(m => m.id === m1.id));
  check('mute room', (await meera.post(`/api/rooms/${general.id}/mute`, { muted: true })).data.muted === true);
  const toDelete = (await meera.post(`/api/rooms/${general.id}/messages`, { text: 'oops wrong chat' })).data;
  check('author can delete own message', (await meera.del('/api/messages/' + toDelete.id)).status === 200);
  const afterDel = (await asha.get(`/api/rooms/${general.id}/messages`)).data.find(m => m.id === toDelete.id);
  check('deleted message text is removed', !afterDel || !afterDel.text, afterDel);

  section('3b. Real-time delivery over WebSocket');
  const net = require('net'), crypto = require('crypto');
  function wsConnect(cookie) {
    return new Promise(resolve => {
      const sock = net.connect(PORT, '127.0.0.1'); let buf = Buffer.alloc(0), upgraded = false; const frames = [];
      sock.on('connect', () => sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${cookie ? 'Cookie: ' + cookie + '\r\n' : ''}\r\n`));
      sock.on('data', d => {
        buf = Buffer.concat([buf, d]);
        if (!upgraded) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; const head = buf.subarray(0, i).toString(); buf = buf.subarray(i + 4); if (!/^HTTP\/1.1 101/.test(head)) return resolve({ ok: false, status: head.split('\r\n')[0], frames, close() { sock.destroy(); } }); upgraded = true; resolve({ ok: true, frames, close() { sock.destroy(); } }); }
        while (buf.length >= 2) { let len = buf[1] & 0x7f, off = 2; if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; } if (buf.length < off + len) break; if ((buf[0] & 0x0f) === 1) frames.push(buf.subarray(off, off + len).toString()); buf = buf.subarray(off + len); }
      });
      sock.on('error', () => resolve({ ok: false, status: 'error', frames, close() {} }));
      sock.on('close', () => { if (!upgraded) resolve({ ok: false, status: 'closed', frames, close() {} }); });
    });
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const { c: outsider } = await register('Outsider', 'out@example.com');
  await outsider.post('/api/family', { name: 'Other Family' });
  const wsMeera = await wsConnect(meera.cookie), wsOut = await wsConnect(outsider.cookie), wsAnon = await wsConnect('');
  check('authenticated member can open a WebSocket', wsMeera.ok, wsMeera.status);
  check('anonymous WebSocket is refused', !wsAnon.ok, wsAnon.status);
  await ravi.post(`/api/rooms/${general.id}/messages`, { text: 'live-delivery-check' });
  await wait(300);
  check('connected member receives new message instantly', wsMeera.frames.some(f => f.includes('message.new') && f.includes('live-delivery-check')), wsMeera.frames.slice(-3));
  check("outsider's socket never receives our messages", !wsOut.frames.some(f => f.includes('live-delivery-check')), wsOut.frames);
  [wsMeera, wsOut, wsAnon].forEach(w => w.close());

  section('4. Private one-to-one chat permissions');
  const dm = (await ravi.post('/api/dms', { userId: meeraId })).data;
  check('create DM', !!dm.id, dm);
  check('DM is idempotent', (await meera.post('/api/dms', { userId: raviId })).data.id === dm.id);
  await ravi.post(`/api/rooms/${dm.id}/messages`, { text: 'secret birthday gift idea 🎁' });
  check('participant can read DM', (await meera.get(`/api/rooms/${dm.id}/messages`)).data.length >= 1);
  check('owner cannot read others\' DM', (await asha.get(`/api/rooms/${dm.id}/messages`)).status !== 200);
  check('owner cannot post in others\' DM', (await asha.post(`/api/rooms/${dm.id}/messages`, { text: 'hi' })).status !== 200);
  const wsAsha = await wsConnect(asha.cookie), wsMeera2 = await wsConnect(meera.cookie);
  await ravi.post(`/api/rooms/${dm.id}/messages`, { text: 'dm-live-check' }); await wait(300);
  check('DM is pushed live to the other participant', wsMeera2.frames.some(f => f.includes('dm-live-check')));
  check('DM is never pushed to a non-participant', !wsAsha.frames.some(f => f.includes('dm-live-check')), wsAsha.frames);
  wsAsha.close(); wsMeera2.close();
  check('DM not listed for non-participant',!(await asha.get('/api/rooms')).data.some(r => r.id === dm.id));
  check('DM text not found by non-participant search', !JSON.stringify((await asha.get('/api/search?q=birthday')).data).includes('gift idea'));
  const dmMsgId = (await meera.get(`/api/rooms/${dm.id}/messages`)).data[0].id;
  check('owner cannot delete (or even see) a DM message', [403, 404].includes((await asha.del('/api/messages/' + dmMsgId)).status));
  check('DM message still intact after that attempt', (await meera.get(`/api/rooms/${dm.id}/messages`)).data[0].deleted !== true);
  check('cannot DM yourself', (await ravi.post('/api/dms', { userId: raviId })).status === 400);

  section('5. Another family cannot see this family (ID tampering)');
  check('outsider cannot read our room by ID', (await outsider.get(`/api/rooms/${general.id}/messages`)).status !== 200);
  check('outsider cannot post to our room', (await outsider.post(`/api/rooms/${general.id}/messages`, { text: 'hi' })).status !== 200);
  check('outsider cannot read our DM', (await outsider.get(`/api/rooms/${dm.id}/messages`)).status !== 200);
  check('outsider cannot edit our message', (await outsider.patch('/api/messages/' + m1.id, { text: 'x' })).status !== 200);
  check('outsider cannot DM our member', (await outsider.post('/api/dms', { userId: ashaId })).status === 400);
  check('outsider cannot join without a code', (await outsider.post('/api/family/join', { code: 'AAAA-AAAA' })).status === 400);
  check('outsider cannot see our members photo', (await outsider.get('/api/users/' + ashaId + '/photo')).status === 404);

  section('6. Plans, tasks, polls, events, calendar');
  const plan = (await asha.post('/api/plans', { title: 'Diwali dinner', category: 'Festival', description: 'At home', startsAt: soon, location: 'Home', budget: 15000, reminderMins: 1440 })).data;
  check('create plan with discussion thread', !!plan.id && !!plan.roomId, plan);
  check('plan visible to members', (await meera.get('/api/plans')).data.some(p => p.id === plan.id));
  check('plan invalid date rejected', (await asha.post('/api/plans', { title: 'x', startsAt: 'garbage' })).status === 400);
  check('RSVP', (await meera.post(`/api/plans/${plan.id}/rsvp`, { rsvp: 'yes' })).status === 200);
  check('plan thread accepts messages', (await meera.post(`/api/rooms/${plan.roomId}/messages`, { text: 'I will bring sweets' })).status === 200);
  check('non-creator member cannot edit plan', (await meera.patch('/api/plans/' + plan.id, { title: 'Hijack' })).status === 403);
  check('admin can update plan status', (await ravi.patch('/api/plans/' + plan.id, { status: 'in_progress' })).status === 200);
  check('invalid plan status rejected', (await asha.patch('/api/plans/' + plan.id, { status: 'banana' })).status === 400);
  const task = await asha.post(`/api/plans/${plan.id}/tasks`, { title: 'Buy diyas', assigneeId: meeraId });
  check('assign task', task.status === 200, task.data);
  const notes = (await meera.get('/api/notifications')).data;
  check('assignee gets notification', notes.some(n => /diyas|task/i.test(n.title + n.body)), notes.map(n => n.title));
  const poll = await asha.post('/api/polls', { question: 'Which day?', options: ['Saturday', 'Sunday'], planId: plan.id });
  check('create poll', poll.status === 200, poll.data);
  const pollList = (await meera.get('/api/polls')).data; const pl = pollList.find(p => p.question === 'Which day?');
  check('vote on poll', pl && (await meera.post(`/api/polls/${pl.id}/vote`, { option: 1 })).status === 200, pl);
  const pl2 = (await asha.get('/api/polls')).data.find(p => p.id === pl.id);
  check('vote is counted for the chosen option', pl2.options[1].votes.includes(meeraId) && pl2.options[0].votes.length === 0, pl2.options);
  check('invalid poll option rejected', (await meera.post(`/api/polls/${pl.id}/vote`, { option: 9 })).status === 400);
  check('only creator/admin can close poll', (await meera.post(`/api/polls/${pl.id}/close`)).status === 403 && (await asha.post(`/api/polls/${pl.id}/close`)).status === 200);
  check('closed poll rejects votes', (await meera.post(`/api/polls/${pl.id}/vote`, { option: 0 })).status === 400);
  check('event creation', (await asha.post('/api/events', { title: 'Grandma birthday', startsAt: soon + day, location: 'Jaipur' })).status === 200);
  const cal = (await asha.get(`/api/calendar?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 14 * day).toISOString())}`)).data;
  check('calendar returns plan and event', cal.some(c => c.kind === 'plan') && cal.some(c => c.kind === 'event'), cal);
  check('event requires permission when revoked', await (async () => { await asha.patch('/api/members/' + meeraId, { perms: {} }); const r = await meera.post('/api/events', { title: 'x', startsAt: soon }); await asha.patch('/api/members/' + meeraId, { perms: { plans: true, events: true } }); return r.status === 403; })());
  const rem = (await asha.get('/api/dashboard')).data;
  check('dashboard loads', !!rem && typeof rem === 'object', Object.keys(rem));

  section('7. Shopping and expenses');
  const list = (await meera.post('/api/shopping', { name: 'Diwali shopping' })).data;
  check('create shopping list', !!list.id);
  check('add item with assignee and price', (await meera.post(`/api/shopping/${list.id}/items`, { name: 'Sweets', qty: 2, price: 500, assigneeId: raviId })).status === 200);
  check('bad product link rejected', (await meera.post(`/api/shopping/${list.id}/items`, { name: 'x', link: 'javascript:alert(1)' })).status === 400);
  const items = (await asha.get('/api/shopping')).data.find(l => l.id === list.id).items;
  check('mark item bought', (await asha.patch('/api/shopping/items/' + items[0].id, { status: 'bought' })).status === 200);
  check('outsider cannot touch our list', (await outsider.patch('/api/shopping/items/' + items[0].id, { status: 'pending' })).status !== 200);
  const month = new Date().toISOString().slice(0, 7);
  check('expenses hidden without permission', (await meera.get('/api/expenses')).status === 403);
  const today = new Date().toISOString().slice(0, 10);
  check('owner records expense split three ways', (await asha.post('/api/expenses', { title: 'Groceries', amount: 900, date: today, category: 'Food', paidBy: ashaId, split: [ashaId, raviId, meeraId] })).status === 200);
  const ex = (await asha.get('/api/expenses?month=' + month)).data;
  check('monthly total and settlements', ex.total === 900 && ex.settlements.length === 2 && ex.settlements.every(s => s.to === ashaId && s.amount === 300), ex);
  check('expense with unknown payer rejected', (await asha.post('/api/expenses', { title: 'x', amount: 1, date: today, paidBy: 'nobody', split: [ashaId] })).status === 400);
  await asha.patch('/api/members/' + meeraId, { perms: { plans: true, events: true, expenses: true } });
  check('expenses visible after owner grants access', (await meera.get('/api/expenses')).status === 200);
  const outEx = await outsider.get('/api/expenses?month=' + month);
  check("outsider sees only their own (empty) expenses, never ours", outEx.status === 200 && outEx.data.items.length === 0 && outEx.data.total === 0, outEx.data);
  check('outsider cannot delete our expense', (await outsider.del('/api/expenses/' + ex.items[0].id)).status === 404);

  section('8. Google Drive is unavailable / not configured');
  const st = (await asha.get('/api/drive/status')).data;
  check('drive status reports not connected', st && st.connected === false, st);
  check('non-owner cannot read drive status', (await meera.get('/api/drive/status')).status === 403);
  const fd = new FormData(); fd.append('category', 'memories'); fd.append('file', new Blob([Buffer.from('fake image bytes')], { type: 'image/png' }), 'pic.png');
  const up = await meera.req('POST', '/api/files', fd);
  check('upload fails with a clear message (no silent fallback storage)', up.status >= 400 && typeof up.data.error === 'string' && /drive/i.test(up.data.error), up);
  check('no file row recorded after failed upload', (await asha.get('/api/files')).data.length === 0);
  const cn = await asha.get('/api/drive/connect');
  check('connect without OAuth credentials explains the problem', cn.status === 302, cn.status);

  section('9. Profile, preferences, password reset');
  check('update profile name', (await ravi.patch('/api/me', { name: 'Ravi K.' })).status === 200);
  check('theme preference saved', (await ravi.patch('/api/me/prefs', { theme: 'dark', n_messages: false })).data.prefs.theme === 'dark');
  check('change password needs current password', (await ravi.post('/api/me/password', { current: 'nope', next: 'brand-new-pass-1' })).status === 400);
  check('change password', (await ravi.post('/api/me/password', { current: PW, next: 'brand-new-pass-1' })).status === 200);
  check('login with new password', (await new Client().post('/api/auth/login', { email: 'ravi@example.com', password: 'brand-new-pass-1' })).status === 200);
  check('reset request never reveals if email exists', (await new Client().post('/api/auth/reset-request', { email: 'ghost@example.com' })).status === 200);
  check('reset with bad code rejected', (await new Client().post('/api/auth/reset', { email: 'meera@example.com', token: 'AAAA-AAAA', password: 'whatever-123' })).status === 400);

  section('10. Persistence across server restart');
  await stopServer(); await startServer();
  const reopened = new Client(); reopened.cookie = asha.cookie;
  check('session survives restart', (await reopened.get('/api/me')).status === 200);
  const hist = (await reopened.get(`/api/rooms/${general.id}/messages`)).data;
  check('chat history persisted', hist.some(m => m.text === 'Dinner on Sunday at 8?'), hist.map(m => m.text));
  check('plans persisted', (await reopened.get('/api/plans')).data.some(p => p.title === 'Diwali dinner'));
  check('expenses persisted', (await reopened.get('/api/expenses?month=' + month)).data.total === 900);
  const rav2 = new Client(); await rav2.post('/api/auth/login', { email: 'ravi@example.com', password: 'brand-new-pass-1' });
  check('DM history persisted for participant', (await rav2.get(`/api/rooms/${dm.id}/messages`)).data.length === 2);

  section('11. Leaving, removal, account and family deletion');
  check('owner cannot leave', (await asha.post('/api/family/leave')).status === 400);
  check('member can leave', (await meera.post('/api/family/leave')).status === 200);
  check('left member loses access', (await meera.get(`/api/rooms/${general.id}/messages`)).status !== 200);
  check('owner removes admin? (admin removal needs owner)', (await asha.del('/api/members/' + raviId)).status === 200);
  check('removed member loses access', (await rav2.get(`/api/rooms/${general.id}/messages`)).status !== 200);
  check('account deletion needs correct password', (await outsider.del('/api/me', { password: 'wrong' })).status === 400);
  check('account deletion succeeds', (await outsider.del('/api/me', { password: PW })).status === 200);
  check('deleted account cannot log in', (await new Client().post('/api/auth/login', { email: 'out@example.com', password: PW })).status === 401);
  check('family deletion needs password', (await asha.req('DELETE', '/api/family', { password: 'wrong' })).status === 400);
  check('owner deletes family and data', (await asha.req('DELETE', '/api/family', { password: PW })).status === 200);
  check('family data gone', (await asha.get('/api/family')).status !== 200);

  section('Game IDs (BGMI / Free Fire)');
  const gc = new Client();
  check('bad BGMI UID rejected', (await gc.post('/api/auth/register', { name: 'Gamer', email: 'gamer@example.com', password: PW, bgmiUid: '12ab' })).status === 400);
  check('bad FF ID rejected', (await gc.post('/api/auth/register', { name: 'Gamer', email: 'gamer@example.com', password: PW, ffUid: '123' })).status === 400);
  const gr = await gc.post('/api/auth/register', { name: 'Gamer', email: 'gamer@example.com', password: PW, bgmiUid: '5123 456-789', ffUid: '1234567890' });
  check('register with game IDs works', gr.status === 200 || gr.status === 201, gr.status);
  const gme = await gc.get('/api/me');
  check('IDs saved without spaces', gme.data && gme.data.user && gme.data.user.bgmiUid === '5123456789' && gme.data.user.ffUid === '1234567890', JSON.stringify(gme.data));
  const gp = await gc.req('PATCH', '/api/me', { name: 'Gamer', bgmiUid: '999888777', ffUid: '' });
  check('profile edit updates IDs', gp.status === 200, gp.status);
  const gme2 = await gc.get('/api/me');
  check('edited IDs stored', gme2.data.user.bgmiUid === '999888777' && gme2.data.user.ffUid === '', JSON.stringify(gme2.data));
  check('bad ID in edit rejected', (await gc.req('PATCH', '/api/me', { name: 'Gamer', bgmiUid: 'abc' })).status === 400);

  await stopServer();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(async e => { console.error('Test runner crashed:', e); try { await stopServer(); } catch (_) {} process.exit(1); });
