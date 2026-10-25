// API: auth, profile, family, members, invitations, chat, files, Drive, push, search, dashboard
const crypto = require('crypto');
const { Readable } = require('stream');
const { route, bad, forbidden, notFound, HttpError, setCookie, rateLimit, clientIp } = require('./http');
const { q, uid, tx, now, json } = require('./db');
const L = require('./lib');
const backup = require('./backup');
const ws = require('./ws');
const drive = require('./drive');
const push = require('./push');
const cfg = require('./config');

const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeCode = () => { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length]; return s.slice(0, 4) + '-' + s.slice(4); };
const PERM_KEYS = ['plans', 'events', 'expenses', 'plans_manage', 'invite'];
const DEFAULT_PERMS = { plans: true, events: true };

const userDto = u => ({ id: u.id, name: u.name, email: u.email, hasPhoto: !!u.photoV, photoV: u.photoV, prefs: u.prefs, role: u.role, bgmiUid: u.bgmiUid || '', ffUid: u.ffUid || '' });

/* =============== AUTH =============== */
route('POST', '/api/auth/register', async ctx => {
  const name = L.str(ctx.body.name, { name: 'Name', required: true, max: 60 });
  const email = L.str(ctx.body.email, { name: 'Email', required: true, max: 200 }).toLowerCase();
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  if (!L.emailOk(email)) throw bad('Please enter a valid email address.');
  if (password.length < 8) throw bad('Password must be at least 8 characters.');
  if (password.length > 200) throw bad('Password is too long.');
  const bgmiUid = L.gameId(ctx.body.bgmiUid, 'BGMI UID'), ffUid = L.gameId(ctx.body.ffUid, 'Free Fire ID');
  if (q.get('SELECT 1 FROM users WHERE email=?', email)) throw bad('An account with this email already exists. Try logging in.');
  const { hash, salt } = await L.hashPassword(password);
  const id = uid();
  q.run('INSERT INTO users(id,email,name,pass_hash,pass_salt,bgmi_uid,ff_uid,created_at) VALUES(?,?,?,?,?,?,?,?)', id, email, name, hash, salt, bgmiUid, ffUid, now());
  L.createSession(ctx.res, ctx.req, id);
  return { ok: true };
}, { auth: false, limit: { bucket: 'reg', max: 10 } });

route('POST', '/api/auth/login', async ctx => {
  const email = L.str(ctx.body.email, { max: 200 }).toLowerCase();
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  rateLimit('loginemail:' + email, 10, 60000);
  const u = q.get('SELECT * FROM users WHERE email=?', email);
  // always run the hash to keep timing similar for unknown emails
  const ok = u ? await L.checkPassword(password, u.pass_hash, u.pass_salt) : (await L.hashPassword(password), false);
  if (!ok) throw new HttpError(401, 'Incorrect email or password.');
  L.createSession(ctx.res, ctx.req, u.id);
  return { ok: true };
}, { auth: false, limit: { bucket: 'login', max: 20 } });

route('POST', '/api/auth/logout', ctx => {
  q.run('DELETE FROM sessions WHERE id=?', ctx.user.sessionId);
  setCookie(ctx.res, ctx.req, 'kf_session', '', 0);
});

route('POST', '/api/auth/reset-request', async ctx => {
  const email = L.str(ctx.body.email, { max: 200 }).toLowerCase();
  const u = q.get('SELECT * FROM users WHERE email=?', email);
  if (u) {
    const code = makeCode();
    q.run('UPDATE users SET reset_hash=?, reset_expires=? WHERE id=?', L.sha(code), now() + 30 * 60000, u.id);
    console.log(`[password reset] code for ${email}: ${code} (valid 30 min)`);
    // No email service is used. Clan leaders/admins see the code in-app so they can pass it on securely.
    const fam = q.get('SELECT family_id FROM memberships WHERE user_id=?', u.id);
    if (fam) {
      const admins = q.all("SELECT user_id FROM memberships WHERE family_id=? AND role IN ('owner','admin') AND user_id!=?", fam.family_id, u.id).map(r => r.user_id);
      for (const a of admins) { q.run('INSERT INTO notifications(user_id,title,body,url,kind,created_at) VALUES(?,?,?,?,?,?)', a, `${u.name} asked for a password reset`, `Give them this one-time code (valid 30 minutes): ${code}`, '#/notifications', 'reset', now()); ws.sendTo(a, { type: 'notification', title: `${u.name} asked for a password reset` }); }
    }
  }
  return { ok: true };
}, { auth: false, limit: { bucket: 'reset', max: 5 } });

route('POST', '/api/auth/reset', async ctx => {
  const email = L.str(ctx.body.email, { max: 200 }).toLowerCase();
  const token = L.str(ctx.body.token, { max: 20 }).toUpperCase();
  const password = typeof ctx.body.password === 'string' ? ctx.body.password : '';
  if (password.length < 8) throw bad('Password must be at least 8 characters.');
  rateLimit('resetfail:' + email, 8, 60000);
  const u = q.get('SELECT * FROM users WHERE email=?', email);
  if (!u || !u.reset_hash || u.reset_expires < now() || u.reset_hash !== L.sha(token)) throw bad('That reset code is invalid or has expired.');
  const { hash, salt } = await L.hashPassword(password);
  q.run('UPDATE users SET pass_hash=?, pass_salt=?, reset_hash=NULL, reset_expires=NULL WHERE id=?', hash, salt, u.id);
  q.run('DELETE FROM sessions WHERE user_id=?', u.id);
  return { ok: true };
}, { auth: false, limit: { bucket: 'reset2', max: 20 } });

/* =============== ME =============== */
route('GET', '/api/me', ctx => ({ user: userDto(ctx.user), family: !!ctx.user.familyId, canCreateClan: !(singleClan() && q.get('SELECT 1 AS x FROM families LIMIT 1')) }));
route('PATCH', '/api/me', ctx => {
  const b = ctx.body;
  const name = b.name !== undefined ? L.str(b.name, { name: 'Name', required: true, max: 60 }) : ctx.user.name;
  const bgmiUid = b.bgmiUid !== undefined ? L.gameId(b.bgmiUid, 'BGMI UID') : ctx.user.bgmiUid;
  const ffUid = b.ffUid !== undefined ? L.gameId(b.ffUid, 'Free Fire ID') : ctx.user.ffUid;
  q.run('UPDATE users SET name=?, bgmi_uid=?, ff_uid=? WHERE id=?', name, bgmiUid, ffUid, ctx.user.id);
  if (ctx.user.familyId) ws.broadcastFamily(ctx.user.familyId, { type: 'family.changed' });
  return userDto({ ...ctx.user, name, bgmiUid, ffUid });
});
const PREF_BOOL = ['n_messages', 'n_private', 'n_mentions', 'n_plans', 'n_events', 'n_reminders', 'n_polls', 'n_tasks', 'n_announce'];
route('PATCH', '/api/me/prefs', ctx => {
  const prefs = { ...ctx.user.prefs };
  for (const [k, v] of Object.entries(ctx.body)) {
    if (k === 'theme' && ['auto', 'light', 'dark'].includes(v)) prefs.theme = v;
    else if (k === 'chatBg' && (v === '' || /^#[0-9a-fA-F]{6}$/.test(v))) prefs.chatBg = v;
    else if (PREF_BOOL.includes(k) && typeof v === 'boolean') prefs[k] = v;
  }
  q.run('UPDATE users SET prefs=? WHERE id=?', JSON.stringify(prefs), ctx.user.id);
  return { prefs };
});
const IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
route('POST', '/api/me/photo', ctx => {
  const f = ctx.file; if (!f) throw bad('Choose an image first.');
  if (!IMG_TYPES.includes(f.mime)) throw bad('Please choose a JPG, PNG, WebP or GIF image.');
  if (f.data.length > 2 * 1048576) throw bad('Profile photos must be under 2 MB.');
  q.run('UPDATE users SET photo=?, photo_mime=?, photo_v=photo_v+1 WHERE id=?', f.data, f.mime, ctx.user.id);
  if (ctx.user.familyId) ws.broadcastFamily(ctx.user.familyId, { type: 'family.changed' });
  const u = q.get('SELECT photo_v FROM users WHERE id=?', ctx.user.id);
  return userDto({ ...ctx.user, photoV: u.photo_v });
});
route('GET', '/api/users/:id/photo', ctx => {
  if (ctx.params.id !== ctx.user.id && !(ctx.user.familyId && L.sameFamily(ctx.user, ctx.params.id))) throw notFound();
  const u = q.get('SELECT photo,photo_mime FROM users WHERE id=?', ctx.params.id);
  if (!u?.photo) throw notFound();
  ctx.res.writeHead(200, { 'Content-Type': u.photo_mime, 'Cache-Control': 'private, max-age=86400' }); ctx.res.end(Buffer.from(u.photo)); ctx.handled = true;
});
route('POST', '/api/me/password', async ctx => {
  const u = q.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!(await L.checkPassword(String(ctx.body.current || ''), u.pass_hash, u.pass_salt))) throw bad('Your current password is incorrect.');
  const next = String(ctx.body.next || ''); if (next.length < 8) throw bad('New password must be at least 8 characters.');
  const { hash, salt } = await L.hashPassword(next);
  q.run('UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?', hash, salt, ctx.user.id);
  q.run('DELETE FROM sessions WHERE user_id=? AND id!=?', ctx.user.id, ctx.user.sessionId);
});
route('GET', '/api/me/export', ctx => {
  const u = ctx.user, fid = u.familyId;
  const rooms = fid ? q.all('SELECT * FROM rooms WHERE family_id=?', fid).filter(r => L.canAccessRoom(u, r.id)) : [];
  return {
    exportedAt: new Date().toISOString(), profile: { id: u.id, name: u.name, email: u.email, role: u.role, prefs: u.prefs, bgmiUid: u.bgmiUid, ffUid: u.ffUid },
    messages: rooms.flatMap(r => q.all('SELECT id,text,created_at,room_id FROM messages WHERE room_id=? AND user_id=? AND deleted=0', r.id, u.id).map(m => ({ ...m, room: r.name }))),
    plansCreated: q.all('SELECT title,description,starts_at,status FROM plans WHERE created_by=?', u.id),
    expensesPaidOrShared: fid ? q.all('SELECT e.title,e.amount,e.date FROM expenses e WHERE e.family_id=? AND (e.paid_by=? OR EXISTS(SELECT 1 FROM expense_splits s WHERE s.expense_id=e.id AND s.user_id=?))', fid, u.id, u.id) : [],
    filesUploaded: q.all('SELECT name,size,category,created_at FROM files WHERE uploaded_by=?', u.id),
  };
});

// remove a user from their family and clean up what only made sense inside it
function removeFromFamily(userId, fid) {
  tx(() => {
    const dms = q.all("SELECT r.id FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE r.family_id=? AND r.type='dm' AND m.user_id=?", fid, userId);
    for (const d of dms) { q.run("UPDATE files SET room_id=NULL WHERE room_id=?", d.id); q.run('DELETE FROM rooms WHERE id=?', d.id); }
    q.run('DELETE FROM room_state WHERE user_id=? AND room_id IN (SELECT id FROM rooms WHERE family_id=?)', userId, fid);
    q.run('DELETE FROM plan_participants WHERE user_id=? AND plan_id IN (SELECT id FROM plans WHERE family_id=?)', userId, fid);
    q.run('DELETE FROM memberships WHERE user_id=?', userId);
  });
  ws.broadcastFamily(fid, { type: 'family.changed' });
}
async function deleteDriveFiles(fid, files) { for (const f of files) { try { await drive.remove(drive.ref(fid, f.drive_acct), f.drive_id); } catch (_) {} } }

route('DELETE', '/api/me', async ctx => {
  const u = q.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!(await L.checkPassword(String(ctx.body.password || ''), u.pass_hash, u.pass_salt))) throw bad('Password is incorrect.');
  const fid = ctx.user.familyId;
  if (fid && ctx.user.role === 'owner' && q.get('SELECT 1 FROM memberships WHERE family_id=? AND user_id!=?', fid, u.id))
    throw new HttpError(409, 'You are the clan leader. Transfer ownership (Members → manage) or delete the clan before deleting your account.');
  if (fid && ctx.user.role === 'owner') await deleteFamily(fid);
  else if (fid) removeFromFamily(u.id, fid);
  tx(() => {
    // posted messages become "deleted" rather than orphaned with a name
    q.run("UPDATE messages SET deleted=1, text='', file_id=NULL WHERE user_id=?", u.id);
    q.run('DELETE FROM users WHERE id=?', u.id);
  });
  ws.disconnectUser(u.id);
  setCookie(ctx.res, ctx.req, 'kf_session', '', 0);
});

/* =============== FAMILY =============== */
// One clan per server: only the very first account can create it. Tests set SINGLE_CLAN=off.
const singleClan = () => process.env.SINGLE_CLAN !== 'off';
function familyDto(f) { return { id: f.id, name: f.name, accent: f.accent, currency: f.currency, sections: f.sections ? json(f.sections, null) : null, hasLogo: !!f.logo_mime }; }
route('POST', '/api/family', ctx => {
  if (ctx.user.familyId) throw bad('You are already in a clan.');
  if (singleClan() && q.get('SELECT 1 AS x FROM families LIMIT 1')) throw bad('Only the clan leader can create the clan. Ask your leader for an invitation code.');
  const name = L.str(ctx.body.name, { name: 'Clan name', required: true, max: 60 });
  const id = uid();
  tx(() => {
    q.run('INSERT INTO families(id,name,sections,owner_id,created_at) VALUES(?,?,?,?,?)', id, name, JSON.stringify(L.SECTION_TYPES), ctx.user.id, now());
    q.run('INSERT INTO memberships(user_id,family_id,role,perms,joined_at) VALUES(?,?,?,?,?)', ctx.user.id, id, 'owner', '{}', now());
    L.ensureFamilyRooms(id);
  });
  return { ok: true };
});
route('POST', '/api/family/join', ctx => {
  if (ctx.user.familyId) throw bad('You are already in a clan.');
  const code = L.str(ctx.body.code, { name: 'Invitation code', required: true, max: 20 }).toUpperCase().replace(/\s/g, '');
  const inv = q.get('SELECT * FROM invites WHERE code=?', code);
  if (!inv || inv.revoked || inv.uses >= inv.max_uses || inv.expires_at < now()) throw bad('That invitation code is invalid, used up or expired.');
  tx(() => {
    q.run('INSERT INTO memberships(user_id,family_id,role,perms,joined_at) VALUES(?,?,?,?,?)', ctx.user.id, inv.family_id, inv.role, JSON.stringify(DEFAULT_PERMS), now());
    q.run('UPDATE invites SET uses=uses+1 WHERE id=?', inv.id);
    for (const p of q.all("SELECT id FROM plans WHERE family_id=? AND status IN ('upcoming','in_progress')", inv.family_id)) q.run('INSERT OR IGNORE INTO plan_participants(plan_id,user_id) VALUES(?,?)', p.id, ctx.user.id);
  });
  ws.broadcastFamily(inv.family_id, { type: 'family.changed' });
  L.notify(L.familyMemberIds(inv.family_id).filter(i => i !== ctx.user.id), { title: `${ctx.user.name} joined the clan 🎉`, url: '#/members', kind: 'announce' });
  return { ok: true };
}, { limit: { bucket: 'join', max: 10 } });
route('GET', '/api/family', ctx => {
  const fid = L.needFamily(ctx.user);
  const f = q.get('SELECT * FROM families WHERE id=?', fid);
  return { family: familyDto(f), members: L.members(fid), me: { role: ctx.user.role, perms: ctx.user.perms }, online: L.members(fid).map(m => m.id).filter(ws.isOnline) };
});
route('PATCH', '/api/family', ctx => {
  const fid = L.needAdmin(ctx.user) || ctx.user.familyId; const b = ctx.body; const f = q.get('SELECT * FROM families WHERE id=?', fid);
  const name = b.name !== undefined ? L.str(b.name, { name: 'Clan name', required: true, max: 60 }) : f.name;
  const currency = b.currency !== undefined ? L.str(b.currency, { name: 'Currency', max: 3 }) || '₹' : f.currency;
  let accent = f.accent; if (b.accent !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(b.accent)) throw bad('Invalid colour'); accent = b.accent; }
  let sections = f.sections; if (Array.isArray(b.sections)) sections = JSON.stringify(['general', ...b.sections.filter(s => L.SECTION_TYPES.includes(s) && s !== 'general')]);
  q.run('UPDATE families SET name=?,currency=?,accent=?,sections=? WHERE id=?', name, currency, accent, sections, fid);
  ws.broadcastFamily(fid, { type: 'family.changed' });
  return { ok: true };
});
route('POST', '/api/family/logo', ctx => {
  const fid = L.needAdmin(ctx.user) || ctx.user.familyId; const f = ctx.file;
  if (!f || !IMG_TYPES.includes(f.mime)) throw bad('Please choose a JPG, PNG, WebP or GIF image.');
  if (f.data.length > 2 * 1048576) throw bad('Logo must be under 2 MB.');
  q.run('UPDATE families SET logo=?, logo_mime=? WHERE id=?', f.data, f.mime, fid);
  ws.broadcastFamily(fid, { type: 'family.changed' });
});
route('GET', '/api/family/logo', ctx => {
  const f = q.get('SELECT logo,logo_mime FROM families WHERE id=?', L.needFamily(ctx.user));
  if (!f?.logo) throw notFound();
  ctx.res.writeHead(200, { 'Content-Type': f.logo_mime, 'Cache-Control': 'private, max-age=3600' }); ctx.res.end(Buffer.from(f.logo)); ctx.handled = true;
});
async function deleteFamily(fid) {
  const files = q.all('SELECT drive_id, drive_acct FROM files WHERE family_id=?', fid);
  const ids = L.familyMemberIds(fid);
  await deleteDriveFiles(fid, files);
  try { await drive.disconnectExtras(fid); } catch (_) {}
  try { await drive.disconnect(fid); } catch (_) {}
  q.run('DELETE FROM families WHERE id=?', fid);
  ids.forEach(id => ws.sendTo(id, { type: 'family.changed' }));
}
route('DELETE', '/api/family', async ctx => {
  L.needOwner(ctx.user);
  const u = q.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!(await L.checkPassword(String(ctx.body.password || ''), u.pass_hash, u.pass_salt))) throw bad('Password is incorrect.');
  await deleteFamily(ctx.user.familyId);
});
route('POST', '/api/family/leave', ctx => {
  const fid = L.needFamily(ctx.user);
  if (ctx.user.role === 'owner') throw bad('The clan leader cannot leave. Transfer leadership or delete the clan.');
  removeFromFamily(ctx.user.id, fid);
});
route('POST', '/api/family/transfer', async ctx => {
  L.needOwner(ctx.user); const fid = ctx.user.familyId;
  const u = q.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!(await L.checkPassword(String(ctx.body.password || ''), u.pass_hash, u.pass_salt))) throw bad('Password is incorrect.');
  const target = q.get('SELECT * FROM memberships WHERE user_id=? AND family_id=?', ctx.body.userId, fid);
  if (!target || target.user_id === ctx.user.id) throw bad('Choose another clan member.');
  tx(() => { q.run("UPDATE memberships SET role='admin' WHERE user_id=?", ctx.user.id); q.run("UPDATE memberships SET role='owner' WHERE user_id=?", target.user_id); q.run('UPDATE families SET owner_id=? WHERE id=?', target.user_id, fid); });
  ws.broadcastFamily(fid, { type: 'family.changed' });
});

/* =============== MEMBERS & INVITES =============== */
route('PATCH', '/api/members/:id', ctx => {
  const fid = L.needAdmin(ctx.user);
  const t = q.get('SELECT * FROM memberships WHERE user_id=? AND family_id=?', ctx.params.id, fid);
  if (!t) throw notFound('Member not found');
  if (t.user_id === ctx.user.id || t.role === 'owner') throw forbidden('You cannot change this member.');
  if (ctx.user.role === 'admin' && t.role !== 'member') throw forbidden('Administrators can only manage regular members.');
  if (ctx.body.role !== undefined) {
    L.needOwner(ctx.user);
    if (!['member', 'admin'].includes(ctx.body.role)) throw bad('Invalid role');
    q.run('UPDATE memberships SET role=? WHERE user_id=?', ctx.body.role, t.user_id);
  }
  if (ctx.body.perms && typeof ctx.body.perms === 'object') {
    const p = {}; for (const k of PERM_KEYS) if (ctx.body.perms[k] === true) p[k] = true;
    q.run('UPDATE memberships SET perms=? WHERE user_id=?', JSON.stringify(p), t.user_id);
  }
  ws.broadcastFamily(fid, { type: 'family.changed' });
});
route('DELETE', '/api/members/:id', ctx => {
  const fid = L.needAdmin(ctx.user);
  const t = q.get('SELECT * FROM memberships WHERE user_id=? AND family_id=?', ctx.params.id, fid);
  if (!t) throw notFound('Member not found');
  if (t.user_id === ctx.user.id || t.role === 'owner') throw forbidden('You cannot remove this member.');
  if (ctx.user.role === 'admin' && t.role !== 'member') throw forbidden('Administrators can only remove regular members.');
  removeFromFamily(t.user_id, fid);
  ws.sendTo(t.user_id, { type: 'family.changed' });
});
route('GET', '/api/invites', ctx => {
  const fid = L.needFamily(ctx.user); if (!L.can(ctx.user, 'invite')) throw forbidden();
  return q.all('SELECT * FROM invites WHERE family_id=? AND revoked=0 AND expires_at>? AND uses<max_uses ORDER BY created_at DESC', fid, now())
    .map(i => ({ id: i.id, code: i.code, role: i.role, maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at }));
});
route('POST', '/api/invites', ctx => {
  const fid = L.needFamily(ctx.user); if (!L.can(ctx.user, 'invite')) throw forbidden('You cannot create invitations.');
  const role = ctx.body.role === 'admin' ? 'admin' : 'member';
  if (role === 'admin' && ctx.user.role !== 'owner') throw forbidden('Only the owner can invite administrators.');
  const maxUses = Math.min(Math.max(Math.round(L.num(ctx.body.maxUses, { name: 'Maximum uses', min: 1, max: 50 }) || 1), 1), 50);
  const days = Math.min(Math.max(L.num(ctx.body.days, { name: 'Days', min: 1, max: 60 }) || 7, 1), 60);
  const id = uid(); let code; do code = makeCode(); while (q.get('SELECT 1 FROM invites WHERE code=?', code));
  q.run('INSERT INTO invites(id,family_id,code,role,max_uses,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', id, fid, code, role, maxUses, now() + days * 86400000, ctx.user.id, now());
  return { id, code };
});
route('DELETE', '/api/invites/:id', ctx => {
  const fid = L.needFamily(ctx.user); if (!L.can(ctx.user, 'invite')) throw forbidden();
  const r = q.run('UPDATE invites SET revoked=1 WHERE id=? AND family_id=?', ctx.params.id, fid); if (!r.changes) throw notFound();
});

/* =============== ROOMS & MESSAGES =============== */
function roomDto(r, u) {
  const st = q.get('SELECT * FROM room_state WHERE room_id=? AND user_id=?', r.id, u.id) || { last_read: 0, muted: 0 };
  const last = q.get('SELECT text,created_at,file_id,deleted FROM messages WHERE room_id=? ORDER BY id DESC LIMIT 1', r.id);
  const unread = q.get('SELECT COUNT(*) c FROM messages WHERE room_id=? AND id>? AND deleted=0 AND (user_id IS NULL OR user_id!=?)', r.id, st.last_read, u.id).c;
  const dto = { id: r.id, type: r.type, name: r.name, muted: !!st.muted, unread, lastText: last ? (last.deleted ? 'Message deleted' : last.text || (last.file_id ? '📎 Attachment' : '')) : '', lastAt: last?.created_at || null };
  if (r.type === 'dm') { const peer = q.get('SELECT user_id FROM room_members WHERE room_id=? AND user_id!=?', r.id, u.id); dto.peerId = peer?.user_id; dto.name = peer ? (q.get('SELECT name FROM users WHERE id=?', peer.user_id)?.name || 'Former member') : 'Former member'; }
  return dto;
}
route('GET', '/api/rooms', ctx => {
  const fid = L.needFamily(ctx.user); const f = q.get('SELECT sections FROM families WHERE id=?', fid);
  const sections = f.sections ? json(f.sections, L.SECTION_TYPES) : L.SECTION_TYPES;
  L.ensureFamilyRooms(fid);
  const rooms = q.all("SELECT * FROM rooms WHERE family_id=? AND type!='plan' ORDER BY created_at", fid)
    .filter(r => r.type === 'dm' ? !!q.get('SELECT 1 FROM room_members WHERE room_id=? AND user_id=?', r.id, ctx.user.id) : sections.includes(r.type));
  const order = L.SECTION_TYPES;
  return rooms.map(r => roomDto(r, ctx.user)).sort((a, b) => (a.type === 'dm') - (b.type === 'dm') || order.indexOf(a.type) - order.indexOf(b.type) || (b.lastAt || 0) - (a.lastAt || 0));
});
route('GET', '/api/rooms/:id', ctx => roomDto(L.roomFor(ctx.user, ctx.params.id), ctx.user));
route('POST', '/api/dms', ctx => {
  const fid = L.needFamily(ctx.user); const other = String(ctx.body.userId || '');
  if (other === ctx.user.id || !L.sameFamily(ctx.user, other)) throw bad('Choose another member of your clan.');
  const existing = q.get("SELECT r.id FROM rooms r WHERE r.family_id=? AND r.type='dm' AND (SELECT COUNT(*) FROM room_members m WHERE m.room_id=r.id AND m.user_id IN (?,?))=2", fid, ctx.user.id, other);
  if (existing) return { id: existing.id };
  const id = uid();
  tx(() => { q.run("INSERT INTO rooms(id,family_id,type,name,created_at) VALUES(?,?,'dm','Private chat',?)", id, fid, now()); q.run('INSERT INTO room_members(room_id,user_id) VALUES(?,?)', id, ctx.user.id); q.run('INSERT INTO room_members(room_id,user_id) VALUES(?,?)', id, other); });
  return { id };
});
route('GET', '/api/rooms/:id/messages', ctx => {
  const r = L.roomFor(ctx.user, ctx.params.id); let rows;
  const term = (ctx.query.q || '').trim();
  if (term) rows = q.all("SELECT * FROM messages WHERE room_id=? AND deleted=0 AND text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 100", r.id, '%' + term.replace(/[\\%_]/g, '\\$&') + '%').reverse();
  else if (ctx.query.before) rows = q.all('SELECT * FROM messages WHERE room_id=? AND id<? ORDER BY id DESC LIMIT 100', r.id, +ctx.query.before).reverse();
  else rows = q.all('SELECT * FROM messages WHERE room_id=? ORDER BY id DESC LIMIT 150', r.id).reverse();
  return L.messageDtos(rows, r.id);
});
route('POST', '/api/rooms/:id/messages', ctx => {
  const r = L.roomFor(ctx.user, ctx.params.id);
  const text = L.str(ctx.body.text, { name: 'Message', max: 4000 });
  const clientId = L.str(ctx.body.clientId, { max: 80 }) || null;
  let fileId = ctx.body.fileId || null;
  if (!text && !fileId) throw bad('Write a message first.');
  if (fileId) { const f = q.get('SELECT * FROM files WHERE id=? AND family_id=? AND uploaded_by=?', fileId, ctx.user.familyId, ctx.user.id); if (!f) throw bad('Attachment not found.'); }
  let replyTo = ctx.body.replyTo ? +ctx.body.replyTo : null;
  if (replyTo && !q.get('SELECT 1 FROM messages WHERE id=? AND room_id=?', replyTo, r.id)) replyTo = null;
  if (clientId) { const dup = q.get('SELECT id FROM messages WHERE room_id=? AND user_id=? AND client_id=?', r.id, ctx.user.id, clientId); if (dup) return L.loadMessage(dup.id); }
  const res = q.run('INSERT INTO messages(room_id,user_id,text,reply_to,file_id,client_id,created_at) VALUES(?,?,?,?,?,?,?)', r.id, ctx.user.id, text, replyTo, fileId, clientId, now());
  const id = Number(res.lastInsertRowid);
  q.run('INSERT INTO room_state(room_id,user_id,last_read) VALUES(?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET last_read=excluded.last_read', r.id, ctx.user.id, id);
  const msg = L.loadMessage(id);
  L.emitMessage('message.new', r.id, msg);
  // notifications: mentions & replies create in-app rows; everyone else (unmuted, offline) gets a push tickle
  const audience = L.roomAudience(r).filter(x => x !== ctx.user.id);
  const first = n => n.split(/\s+/)[0].toLowerCase();
  const mentioned = new Set(); (text.match(/@(\w+)/g) || []).forEach(m => { const nm = m.slice(1).toLowerCase(); q.all('SELECT u.id,u.name FROM users u JOIN memberships s ON s.user_id=u.id WHERE s.family_id=?', r.family_id).forEach(u => { if (first(u.name) === nm && audience.includes(u.id)) mentioned.add(u.id); }); });
  if (replyTo) { const orig = q.get('SELECT user_id FROM messages WHERE id=?', replyTo); if (orig?.user_id && audience.includes(orig.user_id)) mentioned.add(orig.user_id); }
  const rname = r.type === 'dm' ? ctx.user.name : r.name;
  const url = '#/room/' + r.id;
  const muted = uid => !!q.get('SELECT 1 FROM room_state WHERE room_id=? AND user_id=? AND muted=1', r.id, uid);
  L.notify([...mentioned].filter(x => !muted(x)), { title: `${ctx.user.name} in ${rname}`, body: text.slice(0, 120), url, kind: 'mention' });
  for (const a of audience) if (!mentioned.has(a) && !ws.isOnline(a) && !muted(a)) {
    const kind = r.type === 'dm' ? 'private' : 'message';
    const p = json(q.get('SELECT prefs FROM users WHERE id=?', a)?.prefs); if (p[kind === 'private' ? 'n_private' : 'n_messages'] !== false) push.tickle(a, { title: r.type === 'dm' ? ctx.user.name : `${ctx.user.name} in ${rname}`, body: text || (fileId ? '📎 Sent a file' : 'New message'), url });
  }
  return msg;
});
function msgFor(ctx) {
  const m = q.get('SELECT * FROM messages WHERE id=?', ctx.params.id); if (!m) throw notFound();
  const r = L.roomFor(ctx.user, m.room_id); return { m, r };
}
route('PATCH', '/api/messages/:id', ctx => {
  const { m, r } = msgFor(ctx);
  if (m.user_id !== ctx.user.id || m.deleted) throw forbidden('You can only edit your own messages.');
  const text = L.str(ctx.body.text, { name: 'Message', required: true, max: 4000 });
  q.run('UPDATE messages SET text=?, edited_at=? WHERE id=?', text, now(), m.id);
  const msg = L.loadMessage(m.id); L.emitMessage('message.update', r.id, msg); return msg;
});
route('DELETE', '/api/messages/:id', ctx => {
  const { m, r } = msgFor(ctx);
  if (m.user_id !== ctx.user.id && !(L.isAdmin(ctx.user) && r.type !== 'dm')) throw forbidden('You cannot delete this message.');
  q.run("UPDATE messages SET deleted=1, text='', pinned=0 WHERE id=?", m.id);
  L.emitMessage('message.update', r.id, L.loadMessage(m.id));
});
route('POST', '/api/messages/:id/react', ctx => {
  const { m, r } = msgFor(ctx); if (m.deleted) throw bad('Message was deleted.');
  const emoji = L.str(ctx.body.emoji, { name: 'Emoji', required: true, max: 12 });
  const had = q.get('SELECT 1 FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', m.id, ctx.user.id, emoji);
  if (had) q.run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', m.id, ctx.user.id, emoji);
  else q.run('INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)', m.id, ctx.user.id, emoji);
  L.emitMessage('message.update', r.id, L.loadMessage(m.id));
});
route('POST', '/api/messages/:id/pin', ctx => {
  const { m, r } = msgFor(ctx); if (m.deleted) throw bad('Message was deleted.');
  q.run('UPDATE messages SET pinned=? WHERE id=?', m.pinned ? 0 : 1, m.id);
  L.emitMessage('message.update', r.id, L.loadMessage(m.id));
});
route('POST', '/api/rooms/:id/read', ctx => {
  const r = L.roomFor(ctx.user, ctx.params.id);
  const last = q.get('SELECT COALESCE(MAX(id),0) id FROM messages WHERE room_id=?', r.id).id;
  q.run('INSERT INTO room_state(room_id,user_id,last_read) VALUES(?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET last_read=MAX(last_read,excluded.last_read)', r.id, ctx.user.id, last);
  ws.sendToMany(L.roomAudience(r), { type: 'read', roomId: r.id, userId: ctx.user.id, upTo: last });
});
route('POST', '/api/rooms/:id/mute', ctx => {
  const r = L.roomFor(ctx.user, ctx.params.id); const muted = ctx.body.muted ? 1 : 0;
  q.run('INSERT INTO room_state(room_id,user_id,muted) VALUES(?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET muted=excluded.muted', r.id, ctx.user.id, muted);
  return { muted: !!muted };
});
ws.setTypingHandler((userId, roomId) => {
  const m = q.get('SELECT family_id FROM memberships WHERE user_id=?', userId); if (!m) return;
  const u = { id: userId, familyId: m.family_id };
  try { const r = L.roomFor(u, roomId); ws.sendToMany(L.roomAudience(r).filter(x => x !== userId), { type: 'typing', roomId, userId }); } catch (_) {}
});

/* =============== FILES (Google Drive) =============== */
const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|quicktime)|audio\/(webm|mp4|mpeg|ogg|wav|aac|x-m4a)|application\/pdf)$/;
const cleanName = n => (n || 'file').replace(/[\x00-\x1f\\/:*?"<>|]+/g, '_').slice(0, 150) || 'file';
const cleanMime = m => { const t = String(m || '').split(';')[0].trim().toLowerCase(); return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) ? t : 'application/octet-stream'; };

function fileFor(ctx) {
  const f = q.get('SELECT * FROM files WHERE id=? AND family_id=?', ctx.params.id, L.needFamily(ctx.user)); if (!f) throw notFound('File not found');
  if (f.room_id && !L.canAccessRoom(ctx.user, f.room_id)) throw notFound('File not found'); // attachments in someone else's private chat
  return f;
}
route('POST', '/api/files', async ctx => {
  const fid = L.needFamily(ctx.user); const b = ctx.body, file = ctx.file;
  if (!file || !file.data.length) throw bad('No file received.');
  if (file.data.length > cfg.MAX_UPLOAD_MB * 1048576) throw new HttpError(413, `File too large (limit ${cfg.MAX_UPLOAD_MB} MB).`);
  const category = b.category; if (!drive.CATEGORY_FOLDERS[category]) throw bad('Unknown file category.');
  let roomId = null; if (b.roomId) { roomId = L.roomFor(ctx.user, b.roomId).id; }
  let planId = null; if (b.planId) planId = L.owned('plans', b.planId, ctx.user).id;
  let albumId = null; if (b.albumId) albumId = L.owned('albums', b.albumId, ctx.user).id;
  const name = cleanName(file.filename), mime = cleanMime(file.mime);
  const up = await drive.upload(fid, category, { filename: name, mime, data: file.data }); // throws clear errors if Drive is unavailable
  const id = uid();
  q.run('INSERT INTO files(id,family_id,drive_id,drive_acct,name,mime,size,category,uploaded_by,caption,album_id,plan_id,room_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, fid, up.id, up.acct || null, name, mime, file.data.length, category, ctx.user.id, L.str(b.caption, { max: 300 }), albumId, planId, roomId, now());
  if (!roomId) L.bump(fid, category === 'memories' ? 'memories' : category === 'plans' ? 'plan' : 'files', ctx.user.id);
  return L.fileDto(q.get('SELECT * FROM files WHERE id=?', id), ctx.user);
});
route('GET', '/api/files', ctx => {
  const fid = L.needFamily(ctx.user); const cat = ctx.query.category;
  const rows = (cat ? q.all('SELECT * FROM files WHERE family_id=? AND category=? ORDER BY created_at DESC LIMIT 400', fid, cat) : q.all('SELECT * FROM files WHERE family_id=? ORDER BY created_at DESC LIMIT 400', fid))
    .filter(f => !f.room_id || L.canAccessRoom(ctx.user, f.room_id));
  return rows.map(f => L.fileDto(f, ctx.user));
});
route('GET', '/api/files/:id/content', async ctx => {
  const f = fileFor(ctx);
  const r = await drive.download(drive.ref(ctx.user.familyId, f.drive_acct), f.drive_id, ctx.req.headers.range);
  const inline = SAFE_INLINE.test(f.mime) && !ctx.query.download;
  const h = { 'Content-Type': SAFE_INLINE.test(f.mime) ? f.mime : 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'Cache-Control': 'private, max-age=3600', 'Accept-Ranges': 'bytes' };
  for (const k of ['content-length', 'content-range']) if (r.headers.get(k)) h[k] = r.headers.get(k);
  ctx.res.writeHead(r.status, h); ctx.handled = true;
  Readable.fromWeb(r.body).on('error', () => ctx.res.destroy()).pipe(ctx.res);
});
const thumbCache = new Map();
route('GET', '/api/files/:id/thumb', async ctx => {
  const f = fileFor(ctx); if (!f.mime.startsWith('image/')) throw notFound();
  let t = thumbCache.get(f.id);
  if (!t) {
    const dref = drive.ref(ctx.user.familyId, f.drive_acct);
    let r = null; try { r = await drive.thumbnail(dref, f.drive_id); } catch (_) {}
    if (r) t = { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
    else if (f.size < 8 * 1048576 && SAFE_INLINE.test(f.mime)) { const d = await drive.download(dref, f.drive_id); t = { buf: Buffer.from(await d.arrayBuffer()), type: f.mime }; }
    else throw notFound();
    if (thumbCache.size > 150) thumbCache.delete(thumbCache.keys().next().value); thumbCache.set(f.id, t);
  }
  ctx.res.writeHead(200, { 'Content-Type': t.type, 'Cache-Control': 'private, max-age=86400' }); ctx.res.end(t.buf); ctx.handled = true;
});
route('DELETE', '/api/files/:id', async ctx => {
  const f = fileFor(ctx);
  if (f.uploaded_by !== ctx.user.id && !L.isAdmin(ctx.user)) throw forbidden('Only the uploader or an administrator can delete this file.');
  await drive.remove(drive.ref(ctx.user.familyId, f.drive_acct), f.drive_id);
  tx(() => { q.run('UPDATE messages SET file_id=NULL WHERE file_id=?', f.id); q.run('DELETE FROM files WHERE id=?', f.id); });
  thumbCache.delete(f.id); L.bump(ctx.user.familyId, 'memories', ctx.user.id);
});

/* ---- Drive connection (owner only) ---- */
route('GET', '/api/drive/status', async ctx => { L.needOwner(ctx.user); return drive.status(ctx.user.familyId); });
route('GET', '/api/drive/connect', ctx => {
  L.needOwner(ctx.user); ctx.handled = true;
  const to = loc => { ctx.res.writeHead(302, { Location: loc }); ctx.res.end(); };
  if (!drive.configured()) return to('/?drive=' + encodeURIComponent('not configured on server') + '#/drive');
  to(drive.authUrl(ctx.user.id, ctx.user.familyId, ctx.query.add === '1')); // add=1 → sign in with ANOTHER Google account for the storage pool
});
route('GET', '/api/drive/callback', async ctx => {
  ctx.handled = true; L.needOwner(ctx.user);
  const to = loc => { ctx.res.writeHead(302, { Location: loc }); ctx.res.end(); };
  const st = drive.takeState(ctx.query.state || '');
  if (!st || st.userId !== ctx.user.id) return to('/?drive=' + encodeURIComponent('connection expired, try again') + '#/drive');
  if (ctx.query.error || !ctx.query.code) return to('/?drive=' + encodeURIComponent('Google sign-in was cancelled') + '#/drive');
  try { await drive.handleCallback(ctx.query.code, st); to('/?drive=connected#/drive'); }
  catch (e) { to('/?drive=' + encodeURIComponent(e.message.slice(0, 200)) + '#/drive'); }
});
route('POST', '/api/drive/setup', async ctx => { L.needOwner(ctx.user); return drive.setup(ctx.user.familyId); });
route('POST', '/api/drive/disconnect', async ctx => { L.needOwner(ctx.user); await drive.disconnect(ctx.user.familyId); });
route('POST', '/api/drive/accounts/:id/disconnect', async ctx => { L.needOwner(ctx.user); await drive.disconnectExtra(ctx.user.familyId, ctx.params.id); });

/* ---- Database backups to Drive (owner only) ---- */
route('GET', '/api/drive/backup', ctx => { L.needOwner(ctx.user); return backup.status(ctx.user.familyId); });
route('POST', '/api/drive/backup', async ctx => {
  L.needOwner(ctx.user);
  if (!backup.backupFamily()) throw new HttpError(409, 'Connect Google Drive first.');
  if (backup.backupFamily() !== ctx.user.familyId) throw new HttpError(409, 'Backups are kept in the Drive of the first clan that connected one.');
  const r = await backup.run();
  if (r.skipped) throw new HttpError(409, r.skipped === 'drive-not-connected' ? 'Connect Google Drive first.' : r.skipped === 'busy' ? 'A backup is already running.' : 'Backups are switched off on this server.');
  return r;
});
// Shown once to the owner so it can be pasted into the host's DRIVE_RESTORE_KEY setting. Encrypted with SECRET_KEY (useless without it); password re-entry required.
route('POST', '/api/drive/restore-key', async ctx => {
  L.needOwner(ctx.user);
  const u = q.get('SELECT * FROM users WHERE id=?', ctx.user.id);
  if (!(await L.checkPassword(String(ctx.body.password || ''), u.pass_hash, u.pass_salt))) throw bad('Password is incorrect.');
  if (!backup.backupFamily()) throw new HttpError(409, 'Connect Google Drive first.');
  if (backup.backupFamily() !== ctx.user.familyId) throw new HttpError(409, 'Backups are kept in the Drive of the first clan that connected one.');
  const key = backup.restoreKey(ctx.user.familyId); if (!key) throw new HttpError(409, 'Connect Google Drive first.');
  return { key };
});

/* =============== PUSH =============== */
route('GET', '/api/push/config', () => ({ publicKey: push.publicKey }));
route('POST', '/api/push/subscribe', ctx => {
  const ep = String(ctx.body.endpoint || ''); if (!/^https:\/\//.test(ep) && !(process.env.PUSH_TEST === '1' && /^http:\/\/127\.0\.0\.1[:/]/.test(ep))) throw bad('Invalid subscription');
  q.run('INSERT INTO push_subs(endpoint,user_id,sub) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,sub=excluded.sub', ep, ctx.user.id, JSON.stringify(ctx.body));
});

/* =============== SEARCH & DASHBOARD =============== */
const like = s => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';
route('GET', '/api/search', ctx => {
  const fid = L.needFamily(ctx.user); const term = (ctx.query.q || '').trim();
  if (term.length < 2) return { messages: [], plans: [], events: [], files: [] };
  const lk = like(term);
  const messages = q.all(`SELECT m.id,m.room_id,m.user_id,m.text,m.created_at,r.name,r.type FROM messages m JOIN rooms r ON r.id=m.room_id
    WHERE r.family_id=? AND m.deleted=0 AND m.text LIKE ? ESCAPE '\\' AND (r.type!='dm' OR EXISTS(SELECT 1 FROM room_members x WHERE x.room_id=r.id AND x.user_id=?))
    ORDER BY m.id DESC LIMIT 30`, fid, lk, ctx.user.id).map(m => ({ id: m.id, roomId: m.room_id, userId: m.user_id, text: m.text.slice(0, 160), createdAt: m.created_at, roomName: m.type === 'dm' ? 'Private chat' : m.name }));
  return {
    messages,
    plans: q.all("SELECT id,title FROM plans WHERE family_id=? AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\') LIMIT 15", fid, lk, lk),
    events: q.all("SELECT id,title,starts_at startsAt FROM events WHERE family_id=? AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\') LIMIT 15", fid, lk, lk),
    files: q.all("SELECT * FROM files WHERE family_id=? AND (name LIKE ? ESCAPE '\\' OR caption LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT 40", fid, lk, lk).filter(f => !f.room_id || L.canAccessRoom(ctx.user, f.room_id)).slice(0, 15).map(f => ({ id: f.id, name: f.name })),
  };
});
route('GET', '/api/dashboard', ctx => {
  const fid = L.needFamily(ctx.user); const t = now();
  const messages = q.all(`SELECT m.id,m.room_id,m.user_id,m.text,m.file_id,m.created_at,r.name FROM messages m JOIN rooms r ON r.id=m.room_id
    WHERE r.family_id=? AND r.type!='dm' AND m.deleted=0 ORDER BY m.id DESC LIMIT 5`, fid).map(m => ({ id: m.id, roomId: m.room_id, userId: m.user_id, text: m.text, createdAt: m.created_at, roomName: m.name }));
  const members = L.members(fid);
  const upcoming = [
    ...q.all("SELECT id,title,starts_at,location FROM events WHERE family_id=? AND COALESCE(ends_at,starts_at)>=? ORDER BY starts_at LIMIT 5", fid, t).map(e => ({ kind: 'event', id: e.id, title: e.title, startsAt: e.starts_at, location: e.location })),
    ...q.all("SELECT id,title,starts_at,location FROM plans WHERE family_id=? AND status IN ('upcoming','in_progress') AND starts_at>=? ORDER BY starts_at LIMIT 5", fid, t - 86400000).map(e => ({ kind: 'plan', id: e.id, title: e.title, startsAt: e.starts_at, location: e.location })),
  ].sort((a, b) => a.startsAt - b.startsAt).slice(0, 6);
  return {
    messages, upcoming,
    online: members.filter(m => m.id !== ctx.user.id && ws.isOnline(m.id)).map(m => ({ id: m.id, name: m.name, hasPhoto: m.hasPhoto, photoV: m.photoV })),
    tasks: q.all('SELECT k.id,k.title,k.due_at dueAt,p.title planTitle FROM tasks k JOIN plans p ON p.id=k.plan_id WHERE k.family_id=? AND k.assignee_id=? AND k.done=0 ORDER BY COALESCE(k.due_at,9e15) LIMIT 6', fid, ctx.user.id),
    photos: q.all("SELECT id,name FROM files WHERE family_id=? AND mime LIKE 'image/%' AND category IN ('memories','photos') ORDER BY created_at DESC LIMIT 6", fid),
    announcements: q.all('SELECT title,body FROM announcements WHERE family_id=? AND created_at>? ORDER BY created_at DESC LIMIT 3', fid, t - 30 * 86400000),
  };
});
route('GET', '/api/notifications/unread-count', ctx => ({ count: q.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', ctx.user.id).c }));
route('GET', '/api/notifications', ctx => q.all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 60', ctx.user.id).map(n => ({ id: n.id, title: n.title, body: n.body, url: n.url, read: !!n.read, createdAt: n.created_at })));
route('GET', '/api/notifications/latest', ctx => { const live = push.takePending(ctx.user.id); if (live && Date.now() - live.at < 10 * 60 * 1000) return { title: live.title, body: live.body, url: live.url }; const n = q.get('SELECT title,body,url FROM notifications WHERE user_id=? AND read=0 ORDER BY id DESC LIMIT 1', ctx.user.id); return n || { title: 'HINDU ESPORTS', body: 'New activity in your clan', url: '/' }; });
route('POST', '/api/notifications/read', ctx => { q.run('UPDATE notifications SET read=1 WHERE user_id=?', ctx.user.id); });
