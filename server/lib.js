// Shared server helpers: auth, sessions, permission checks, notifications, DTOs, validation.
const crypto = require('crypto');
const cfg = require('./config');
const { q, uid, json, now } = require('./db');
const { HttpError, bad, forbidden, notFound, parseCookies, setCookie } = require('./http');
const ws = require('./ws');
const push = require('./push');

/* ---------- passwords ---------- */
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); return { hash: (await scrypt(pw, salt)).toString('hex'), salt: salt.toString('hex') }; }
async function checkPassword(pw, hash, salt) { const k = await scrypt(pw, Buffer.from(salt, 'hex')); const h = Buffer.from(hash, 'hex'); return h.length === k.length && crypto.timingSafeEqual(h, k); }
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

/* ---------- sessions ---------- */
function createSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  q.run('INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)', sha(token), userId, t, t + cfg.SESSION_DAYS * 86400000);
  setCookie(res, req, 'kf_session', token, cfg.SESSION_DAYS * 86400);
}
// Optional game ID (BGMI UID / Free Fire ID): spaces and dashes are ignored; it must then be 5-15 digits. Empty is fine.
function gameId(v, label) {
  const s = String(v ?? '').replace(/[\s-]/g, ''); if (!s) return '';
  if (!/^\d{5,15}$/.test(s)) throw new HttpError(400, `${label} must be numbers only (5 to 15 digits).`);
  return s;
}
function authenticate(req) {
  const token = parseCookies(req).kf_session; if (!token) return null;
  const s = q.get('SELECT * FROM sessions WHERE id=?', sha(token));
  if (!s || s.expires_at < now()) { if (s) q.run('DELETE FROM sessions WHERE id=?', s.id); return null; }
  const u = q.get(`SELECT u.*, m.family_id, m.role, m.perms FROM users u LEFT JOIN memberships m ON m.user_id=u.id WHERE u.id=?`, s.user_id);
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, familyId: u.family_id || null, role: u.role || null, perms: json(u.perms), prefs: json(u.prefs), sessionId: s.id, photoV: u.photo_v, hasPhoto: !!u.photo_v, bgmiUid: u.bgmi_uid || '', ffUid: u.ff_uid || '' };
}

/* ---------- permissions ---------- */
const isAdmin = u => u.role === 'owner' || u.role === 'admin';
const can = (u, perm) => isAdmin(u) || !!u.perms[perm];
function needFamily(u) { if (!u.familyId) throw new HttpError(409, 'Join or create a clan first.', 'no_family'); return u.familyId; }
function needPerm(u, perm, msg) { needFamily(u); if (!can(u, perm)) throw forbidden(msg || 'You do not have permission to do that. Ask the clan leader.'); }
function needAdmin(u) { const fid = needFamily(u); if (!isAdmin(u)) throw forbidden('Only the clan leader or an administrator can do that.'); return fid; }
function needOwner(u) { const fid = needFamily(u); if (u.role !== 'owner') throw forbidden('Only the clan leader can do that.'); return fid; }
// Row belongs to the caller's family, else 404 (never reveal other families' ids)
function owned(table, id, u) { const r = q.get(`SELECT * FROM ${table} WHERE id=? AND family_id=?`, id, needFamily(u)); if (!r) throw notFound(); return r; }

/* ---------- validation ---------- */
function str(v, { name = 'Value', min = 0, max = 500, required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad(`${name} is invalid`);
  v = v.trim();
  if ((required || min) && v.length < Math.max(min, 1)) throw bad(`${name} is required`);
  if (v.length > max) throw bad(`${name} is too long (max ${max})`);
  return v;
}
function num(v, { name = 'Number', min = -Infinity, max = Infinity, required = false } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${name} is required`); return null; }
  const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} is invalid`);
  return n;
}
function ts(v, { name = 'Date', required = false } = {}) {
  if (!v) { if (required) throw bad(`${name} is required`); return null; }
  const t = new Date(v).getTime(); if (!Number.isFinite(t)) throw bad(`${name} is invalid`); return t;
}
const emailOk = e => /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(e);

/* ---------- family helpers ---------- */
const familyMemberIds = fid => q.all('SELECT user_id FROM memberships WHERE family_id=?', fid).map(r => r.user_id);
const sameFamily = (u, otherId) => !!q.get('SELECT 1 FROM memberships WHERE user_id=? AND family_id=?', otherId, u.familyId);
function memberDto(r) { return { id: r.id, name: r.name, email: undefined, role: r.role, perms: json(r.perms), joinedAt: r.joined_at, hasPhoto: !!r.photo_v, photoV: r.photo_v, bgmiUid: r.bgmi_uid || '', ffUid: r.ff_uid || '' }; }
function members(fid) {
  return q.all('SELECT u.id,u.name,u.photo_v,u.bgmi_uid,u.ff_uid,m.role,m.perms,m.joined_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.family_id=? ORDER BY m.joined_at', fid).map(memberDto);
}
const SECTION_TYPES = ['general', 'daily', 'events', 'planning', 'shopping'];
const SECTION_NAMES = { general: 'General Clan Chat', daily: 'Daily Discussion', events: 'Clan Events', planning: 'Match Planning', shopping: 'Gear Chat' };
// One-time tidy-up: existing default rooms that still carry the old family names get the new clan names (renamed rooms are left alone).
const OLD_ROOM_NAMES = { general: 'General Family Chat', events: 'Family Events', planning: 'Family Planning', shopping: 'Shopping Chat' };
for (const [t, old] of Object.entries(OLD_ROOM_NAMES)) if (SECTION_NAMES[t] !== old) q.run('UPDATE rooms SET name=? WHERE type=? AND name=?', SECTION_NAMES[t], t, old);
// …and the original sample name of the family space becomes the clan's name (it can be changed any time in Clan settings).
q.run("UPDATE families SET name='Hindu Esports' WHERE name='Kataria Family'");
function ensureFamilyRooms(fid) {
  for (const t of SECTION_TYPES) if (!q.get('SELECT 1 FROM rooms WHERE family_id=? AND type=?', fid, t)) q.run('INSERT INTO rooms(id,family_id,type,name,created_at) VALUES(?,?,?,?,?)', uid(), fid, t, SECTION_NAMES[t], now());
}

/* ---------- rooms ---------- */
function roomFor(u, roomId) {
  const fid = needFamily(u);
  const r = q.get('SELECT * FROM rooms WHERE id=? AND family_id=?', roomId, fid);
  if (!r) throw notFound('Chat not found');
  if (r.type === 'dm' && !q.get('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?', r.id, u.id)) throw notFound('Chat not found'); // DMs invisible to everyone else
  return r;
}
const roomAudience = r => r.type === 'dm' ? q.all('SELECT user_id FROM room_members WHERE room_id=?', r.id).map(x => x.user_id) : familyMemberIds(r.family_id);
function canAccessRoom(u, roomId) { try { roomFor(u, roomId); return true; } catch (_) { return false; } }

/* ---------- notifications ---------- */
const PREF_OF = { message: 'n_messages', private: 'n_private', mention: 'n_mentions', plan: 'n_plans', event: 'n_events', reminder: 'n_reminders', poll: 'n_polls', task: 'n_tasks', announce: 'n_announce' };
function wants(userId, kind) {
  const p = json(q.get('SELECT prefs FROM users WHERE id=?', userId)?.prefs);
  return p[PREF_OF[kind]] !== false;
}
function notify(userIds, { title, body = '', url = '#/home', kind }) {
  for (const id of new Set(userIds)) {
    if (!wants(id, kind)) continue;
    const r = q.run('INSERT INTO notifications(user_id,title,body,url,kind,created_at) VALUES(?,?,?,?,?,?)', id, title, body, url, kind, now());
    ws.sendTo(id, { type: 'notification', id: Number(r.lastInsertRowid), title, body, url });
    if (!ws.isOnline(id)) push.tickle(id, { title, body, url });
  }
}
const bump = (fid, scope, except) => ws.broadcastFamily(fid, { type: 'data.changed', scope }, except);

/* ---------- DTOs ---------- */
function fileDto(f, u) {
  return { id: f.id, name: f.name, mime: f.mime, size: f.size, category: f.category, caption: f.caption || '', createdAt: f.created_at, uploadedBy: f.uploaded_by, albumId: f.album_id,
    canDelete: f.uploaded_by === u.id || isAdmin(u) };
}
function messageDtos(rows, roomId) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const reacts = q.all(`SELECT message_id,user_id,emoji FROM reactions WHERE message_id IN (${ph})`, ...ids);
  const states = q.all('SELECT user_id,last_read FROM room_state WHERE room_id=?', roomId);
  const fileIds = [...new Set(rows.map(r => r.file_id).filter(Boolean))];
  const files = fileIds.length ? q.all(`SELECT id,name,mime,size FROM files WHERE id IN (${fileIds.map(() => '?').join(',')})`, ...fileIds) : [];
  return rows.map(r => {
    const rx = {}; reacts.filter(x => x.message_id === r.id).forEach(x => (rx[x.emoji] = rx[x.emoji] || []).push(x.user_id));
    const f = files.find(x => x.id === r.file_id);
    return { id: r.id, roomId: r.room_id, userId: r.user_id, text: r.deleted ? '' : r.text, replyTo: r.reply_to, createdAt: r.created_at, editedAt: r.edited_at, deleted: !!r.deleted, pinned: !!r.pinned,
      file: r.deleted ? null : f ? { id: f.id, name: f.name, mime: f.mime, size: f.size } : null, reactions: rx,
      readBy: states.filter(s => s.user_id !== r.user_id && s.last_read >= r.id).map(s => s.user_id) };
  });
}
function loadMessage(id) { const r = q.get('SELECT * FROM messages WHERE id=?', id); return r ? messageDtos([r], r.room_id)[0] : null; }
function emitMessage(type, roomId, msg) { const r = q.get('SELECT * FROM rooms WHERE id=?', roomId); ws.sendToMany(roomAudience(r), { type, message: msg }); }

module.exports = { hashPassword, checkPassword, sha, createSession, authenticate, isAdmin, can, needFamily, needPerm, needAdmin, needOwner, owned, str, num, ts, emailOk, gameId, familyMemberIds, sameFamily, members, ensureFamilyRooms, SECTION_TYPES, roomFor, roomAudience, canAccessRoom, notify, bump, fileDto, messageDtos, loadMessage, emitMessage, memberDto };
