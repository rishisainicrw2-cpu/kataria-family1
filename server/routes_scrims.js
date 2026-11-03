// API: Scrims & Tournaments — a single standalone group chat, isolated from the clan.
//
// Two kinds of people can reach it, each with its own access path:
//  - Clan leaders/co-leaders manage it and post into it using their normal account (kf_session), gated by
//    L.needAdmin — regular clan members get no special access to it, same as any other visitor.
//  - External players join through an invite link/code with just a display name. They get a separate
//    session cookie (scrims_session) that is NOT a clan account: it cannot read or touch anything else in
//    this app. There is no "username/password" for them — the invite code itself is the credential.
//
// Every route below enforces access on the server; the frontend (public/scrims.html + js/scrims.js) is a
// completely separate, unbranded page that never loads the clan app's HTML/JS, so there is nothing to leak.
const crypto = require('crypto');
const { route, bad, forbidden, notFound, HttpError, parseCookies, setCookie, rateLimit, clientIp } = require('./http');
const { q, uid, tx, now, json } = require('./db');
const L = require('./lib');
const ws = require('./ws');

const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeCode = () => { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length]; return s.slice(0, 4) + '-' + s.slice(4); };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const GROUP_NAME = 'Scrims & Tournaments';
const SESSION_DAYS = 14;

/* ---------- participant session (separate cookie, separate table — not a clan account) ---------- */
function createParticipantSession(res, req, participantId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  q.run('INSERT INTO scrims_sessions(id,participant_id,created_at,expires_at) VALUES(?,?,?,?)', sha(token), participantId, t, t + SESSION_DAYS * 86400000);
  setCookie(res, req, 'scrims_session', token, SESSION_DAYS * 86400);
}
function authenticateParticipant(req) {
  const token = parseCookies(req).scrims_session; if (!token) return null;
  const s = q.get('SELECT * FROM scrims_sessions WHERE id=?', sha(token));
  if (!s || s.expires_at < now()) { if (s) q.run('DELETE FROM scrims_sessions WHERE id=?', s.id); return null; }
  const p = q.get('SELECT * FROM scrims_participants WHERE id=?', s.participant_id);
  if (!p || p.removed) return null;
  return { id: p.id, name: p.name, sessionId: s.id };
}
// Resolves whoever is making the request: a clan admin on their normal account, or a joined external participant.
// Never both — an admin viewing via their kf_session does not also need a scrims_session.
function actorFor(ctx) {
  const u = L.authenticate(ctx.req);
  if (u && L.isAdmin(u)) return { kind: 'admin', user: u };
  const p = authenticateParticipant(ctx.req);
  if (p) return { kind: 'player', participant: p };
  throw new HttpError(401, 'Please join with a valid invitation link first.', 'auth');
}
const actorKey = a => a.kind === 'admin' ? 'a:' + a.user.id : 'p:' + a.participant.id;
const actorName = a => a.kind === 'admin' ? a.user.name : a.participant.name;
const actorRole = a => a.kind === 'admin' ? 'admin' : 'player';

/* ---------- invite management (clan admins only, normal kf_session auth) ---------- */
route('GET', '/api/scrims/invites', ctx => {
  L.needAdmin(ctx.user);
  return q.all('SELECT * FROM scrims_invites ORDER BY created_at DESC').map(inviteDto);
});
function inviteDto(i) {
  return { id: i.id, code: i.code, label: i.label || '', maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at, revoked: !!i.revoked, createdAt: i.created_at,
    active: !i.revoked && (!i.expires_at || i.expires_at > now()) && (!i.max_uses || i.uses < i.max_uses) };
}
route('POST', '/api/scrims/invites', ctx => {
  L.needAdmin(ctx.user);
  const label = L.str(ctx.body.label, { name: 'Label', max: 60 });
  const maxUses = ctx.body.maxUses === undefined || ctx.body.maxUses === '' || ctx.body.maxUses === null ? 0 : Math.round(L.num(ctx.body.maxUses, { name: 'Member limit', min: 1, max: 5000 }));
  const days = ctx.body.days === undefined || ctx.body.days === '' || ctx.body.days === null ? null : L.num(ctx.body.days, { name: 'Days', min: 1, max: 365 });
  const id = uid(); let code; do code = makeCode(); while (q.get('SELECT 1 FROM scrims_invites WHERE code=?', code));
  q.run('INSERT INTO scrims_invites(id,code,label,max_uses,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
    id, code, label, maxUses || 0, days ? now() + days * 86400000 : null, ctx.user.id, now());
  return inviteDto(q.get('SELECT * FROM scrims_invites WHERE id=?', id));
});
route('PATCH', '/api/scrims/invites/:id', ctx => {
  L.needAdmin(ctx.user);
  const inv = q.get('SELECT * FROM scrims_invites WHERE id=?', ctx.params.id); if (!inv) throw notFound();
  if (typeof ctx.body.revoked === 'boolean') q.run('UPDATE scrims_invites SET revoked=? WHERE id=?', ctx.body.revoked ? 1 : 0, inv.id);
  return inviteDto(q.get('SELECT * FROM scrims_invites WHERE id=?', inv.id));
});
route('POST', '/api/scrims/invites/:id/regenerate', ctx => {
  L.needAdmin(ctx.user);
  const inv = q.get('SELECT * FROM scrims_invites WHERE id=?', ctx.params.id); if (!inv) throw notFound();
  let code; do code = makeCode(); while (q.get('SELECT 1 FROM scrims_invites WHERE code=?', code));
  q.run('UPDATE scrims_invites SET code=?, uses=0, revoked=0 WHERE id=?', code, inv.id); // old link stops working immediately; a fresh one takes its place
  return inviteDto(q.get('SELECT * FROM scrims_invites WHERE id=?', inv.id));
});
route('DELETE', '/api/scrims/invites/:id', ctx => {
  L.needAdmin(ctx.user);
  const r = q.run('UPDATE scrims_invites SET revoked=1 WHERE id=?', ctx.params.id); if (!r.changes) throw notFound();
});

/* ---------- participants (admin: list/remove) ---------- */
function participantDto(p) { return { id: p.id, name: p.name, online: ws.isOnline('scrim:' + p.id), joinedAt: p.created_at, removed: !!p.removed }; }
route('GET', '/api/scrims/participants', ctx => {
  L.needAdmin(ctx.user);
  return q.all('SELECT * FROM scrims_participants WHERE removed=0 ORDER BY created_at DESC').map(participantDto);
});
route('DELETE', '/api/scrims/participants/:id', ctx => {
  L.needAdmin(ctx.user);
  const p = q.get('SELECT * FROM scrims_participants WHERE id=?', ctx.params.id); if (!p) throw notFound();
  q.run('UPDATE scrims_participants SET removed=1 WHERE id=?', p.id);
  q.run('DELETE FROM scrims_sessions WHERE participant_id=?', p.id); // any open link/cookie for them stops working right away
  ws.disconnectUser('scrim:' + p.id);
  broadcastScrims({ type: 'scrims.participant_removed', participantId: p.id });
});

/* ---------- joining (public — the invite code is the only credential) ---------- */
route('POST', '/api/scrims/join', ctx => {
  const code = L.str(ctx.body.code, { name: 'Invitation code', required: true, max: 20 }).toUpperCase().replace(/\s/g, '');
  rateLimit('scrimsjoin:' + ctx.ip, 20, 60000);
  const inv = q.get('SELECT * FROM scrims_invites WHERE code=?', code);
  if (!inv || inv.revoked || (inv.expires_at && inv.expires_at < now()) || (inv.max_uses && inv.uses >= inv.max_uses)) throw bad('That invitation link is invalid, expired or no longer accepting new players.');
  const name = L.str(ctx.body.name, { name: 'Display name', required: true, max: 40 });
  const id = uid();
  tx(() => {
    q.run('INSERT INTO scrims_participants(id,name,invite_id,created_at) VALUES(?,?,?,?)', id, name, inv.id, now());
    q.run('UPDATE scrims_invites SET uses=uses+1 WHERE id=?', inv.id);
  });
  createParticipantSession(ctx.res, ctx.req, id);
  return { ok: true, name };
}, { auth: false, limit: { bucket: 'scrimsjoinreg', max: 30 } });

route('POST', '/api/scrims/leave', ctx => {
  const p = authenticateParticipant(ctx.req); if (!p) throw new HttpError(401, 'Not joined.', 'auth');
  q.run('DELETE FROM scrims_sessions WHERE id=?', p.sessionId);
  setCookie(ctx.res, ctx.req, 'scrims_session', '', 0);
}, { auth: false });

/* ---------- the group itself ---------- */
route('GET', '/api/scrims/me', ctx => {
  const a = actorFor(ctx);
  return { kind: a.kind, name: actorName(a), role: actorRole(a), group: { name: GROUP_NAME } };
}, { auth: false });

route('GET', '/api/scrims/room', ctx => {
  const a = actorFor(ctx);
  const online = q.all('SELECT id,name FROM scrims_participants WHERE removed=0').filter(p => ws.isOnline('scrim:' + p.id)).map(p => ({ id: p.id, name: p.name }));
  return { group: { name: GROUP_NAME }, me: { kind: a.kind, name: actorName(a), role: actorRole(a) }, online };
}, { auth: false });

function messageDto(m) {
  return { id: m.id, authorName: m.deleted ? '' : m.author_name, role: m.role, kind: m.kind, text: m.deleted ? '' : m.text, pinned: !!m.pinned, deleted: !!m.deleted, createdAt: m.created_at,
    mine: undefined }; // 'mine' is filled in per-request by the caller (depends on who is asking)
}
route('GET', '/api/scrims/messages', ctx => {
  const a = actorFor(ctx);
  const before = ctx.query.before ? +ctx.query.before : null;
  const rows = before ? q.all('SELECT * FROM scrims_messages WHERE id<? ORDER BY id DESC LIMIT 100', before).reverse()
    : q.all('SELECT * FROM scrims_messages ORDER BY id DESC LIMIT 150').reverse();
  const key = actorKey(a);
  return rows.map(m => { const d = messageDto(m); d.mine = (a.kind === 'admin' ? m.admin_id === a.user.id : m.participant_id === a.participant.id); return d; });
}, { auth: false });

route('POST', '/api/scrims/messages', ctx => {
  const a = actorFor(ctx);
  rateLimit('scrimsmsg:' + actorKey(a), 20, 60000);
  const text = L.str(ctx.body.text, { name: 'Message', max: 1000 });
  let kind = 'message';
  if (ctx.body.kind === 'announcement' || ctx.body.kind === 'room') { if (a.kind !== 'admin') throw forbidden('Only a clan leader or co-leader can post that.'); kind = ctx.body.kind; }
  if (!text) throw bad('Write a message first.');
  const pinned = kind === 'announcement' ? 1 : 0;
  const res = q.run('INSERT INTO scrims_messages(participant_id,admin_id,author_name,role,kind,text,pinned,created_at) VALUES(?,?,?,?,?,?,?,?)',
    a.kind === 'admin' ? null : a.participant.id, a.kind === 'admin' ? a.user.id : null, actorName(a), actorRole(a), kind, text, pinned, now());
  const id = Number(res.lastInsertRowid);
  const m = q.get('SELECT * FROM scrims_messages WHERE id=?', id);
  broadcastScrims({ type: 'scrims.message', message: messageDto(m) });
  return { ...messageDto(m), mine: true };
}, { auth: false });

function msgFor(ctx) { const m = q.get('SELECT * FROM scrims_messages WHERE id=?', ctx.params.id); if (!m) throw notFound(); return m; }
route('DELETE', '/api/scrims/messages/:id', ctx => {
  const a = actorFor(ctx); if (a.kind !== 'admin') throw forbidden('Only a clan leader or co-leader can delete messages.');
  const m = msgFor(ctx);
  q.run("UPDATE scrims_messages SET deleted=1, text='', pinned=0 WHERE id=?", m.id);
  broadcastScrims({ type: 'scrims.message_update', message: messageDto(q.get('SELECT * FROM scrims_messages WHERE id=?', m.id)) });
}, { auth: false });
route('POST', '/api/scrims/messages/:id/pin', ctx => {
  const a = actorFor(ctx); if (a.kind !== 'admin') throw forbidden('Only a clan leader or co-leader can pin messages.');
  const m = msgFor(ctx); if (m.deleted) throw bad('Message was deleted.');
  q.run('UPDATE scrims_messages SET pinned=? WHERE id=?', m.pinned ? 0 : 1, m.id);
  broadcastScrims({ type: 'scrims.message_update', message: messageDto(q.get('SELECT * FROM scrims_messages WHERE id=?', m.id)) });
}, { auth: false });
route('GET', '/api/scrims/pinned', ctx => {
  actorFor(ctx);
  return q.all('SELECT * FROM scrims_messages WHERE pinned=1 AND deleted=0 ORDER BY id DESC').map(messageDto);
}, { auth: false });

// Basic abuse reporting: flags a message to every clan leader/co-leader as an in-app notification.
route('POST', '/api/scrims/messages/:id/report', ctx => {
  const a = actorFor(ctx);
  const m = msgFor(ctx); if (m.deleted) throw bad('Message was already removed.');
  rateLimit('scrimsreport:' + actorKey(a), 10, 60000);
  const reason = L.str(ctx.body.reason, { max: 300 });
  q.run('INSERT INTO scrims_reports(id,message_id,reporter_participant_id,reporter_admin_id,reason,created_at) VALUES(?,?,?,?,?,?)',
    uid(), m.id, a.kind === 'player' ? a.participant.id : null, a.kind === 'admin' ? a.user.id : null, reason, now());
  const admins = q.all("SELECT user_id FROM memberships WHERE role IN ('owner','admin')").map(r => r.user_id);
  L.notify(admins, { title: `Scrims message reported by ${actorName(a)}`, body: (m.deleted ? '' : m.text).slice(0, 120), url: '#/scrims-admin', kind: 'announce' });
}, { auth: false });

/* ---------- realtime audience ---------- */
function scrimsAudience() {
  const admins = q.all("SELECT user_id FROM memberships WHERE role IN ('owner','admin')").map(r => r.user_id);
  const parts = q.all('SELECT id FROM scrims_participants WHERE removed=0').map(r => 'scrim:' + r.id);
  return [...admins, ...parts];
}
function broadcastScrims(obj) { ws.sendToMany(scrimsAudience(), obj); }

module.exports = { authenticateParticipant };
