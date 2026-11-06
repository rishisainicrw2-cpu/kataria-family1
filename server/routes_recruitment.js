// API: Player Recruitment — a fully public application module, plus admin review.
//
// Applicants never get a login: they fill in the form and get back a one-time "Application ID" (an
// unguessable code, same shape as a scrims invite code). That code is the only way to look the application
// back up later — there is no list-all-applications endpoint reachable without being a clan admin.
//
// Admin review is gated by the existing permission system: any clan admin/owner, or a regular member granted
// the 'recruitment' permission (see PERM_KEYS in routes_core.js), can list, view and act on applications.
// Nothing here creates clan accounts — approving an applicant is a decision, not an auto-join; the clan leader
// still sends them a normal invite code afterwards, same as any other new member.
const crypto = require('crypto');
const { route, bad, notFound, rateLimit } = require('./http');
const { q, uid, now } = require('./db');
const L = require('./lib');

const CODE_ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const makeCode = () => { const b = crypto.randomBytes(8); let s = ''; for (let i = 0; i < 8; i++) s += CODE_ALPHA[b[i] % CODE_ALPHA.length]; return s.slice(0, 4) + '-' + s.slice(4); };

const ROLES = ['IGL', 'Assaulter', 'Support', 'Scout', 'Sniper'];
const TEAMS = ['alpha', 'bravo', 'charlie', 'any'];
const TEAM_LABEL = { alpha: 'Team Alpha', bravo: 'Team Bravo', charlie: 'Team Charlie', any: 'Any available team' };
const STATUS_LABEL = { pending: 'Pending', under_review: 'Under Review', trial_invited: 'Trial Invited', approved: 'Approved', rejected: 'Rejected' };
// Statuses that count as "already in the pipeline" for the duplicate-application check below.
const OPEN_STATUSES = ['pending', 'under_review', 'trial_invited'];

function appPublicDto(a) {
  return {
    id: a.id, status: a.status, statusLabel: STATUS_LABEL[a.status],
    fullName: a.full_name, ign: a.ign, role: a.role, preferredTeam: a.preferred_team, preferredTeamLabel: TEAM_LABEL[a.preferred_team],
    submittedAt: a.created_at, updatedAt: a.updated_at,
  };
}

route('POST', '/api/recruitment/apply', ctx => {
  const b = ctx.body;
  const fullName = L.str(b.fullName, { name: 'Full name', required: true, max: 80 });
  const ign = L.str(b.ign, { name: 'BGMI in-game name', required: true, max: 40 });
  const bgmiUid = L.gameId(b.bgmiUid, 'BGMI UID');
  if (!bgmiUid) throw bad('BGMI UID is required.');
  const age = L.num(b.age, { name: 'Age', min: 10, max: 60 });
  const role = L.str(b.role, { name: 'Primary role', required: true });
  if (!ROLES.includes(role)) throw bad('Choose a valid primary role.');
  const experience = L.str(b.experience, { name: 'Competitive experience', max: 1000 });
  const previousTeam = L.str(b.previousTeam, { name: 'Previous team experience', max: 300 });
  const preferredTeam = L.str(b.preferredTeam, { name: 'Preferred team', required: true });
  if (!TEAMS.includes(preferredTeam)) throw bad('Choose a valid preferred team.');
  const device = L.str(b.device, { name: 'Device model', max: 100 });
  const hours = L.str(b.hours, { name: 'Available playing hours', max: 200 });
  const contact = L.str(b.contact, { name: 'Contact details', required: true, min: 5, max: 150 });
  const socialLink = L.str(b.socialLink, { name: 'Social media / profile link', max: 300 });
  if (socialLink && !/^https?:\/\//i.test(socialLink)) throw bad('Social media link should start with http:// or https://');
  if (!b.consent) throw bad('Please confirm the consent checkbox before submitting.');

  rateLimit('recruitapply:' + ctx.ip, 8, 60000);

  // Prevent duplicate applications: one open (non-rejected, non-approved) application per BGMI UID at a time.
  // A previously rejected applicant, or one who was approved and wants to reapply for a different slot, is fine.
  const existing = q.get(`SELECT id FROM recruitment_applications WHERE bgmi_uid=? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`, bgmiUid, ...OPEN_STATUSES);
  if (existing) throw bad('There is already an open application for this BGMI UID. Use "Check status" to track it.', 'duplicate');

  const id = uid(), code = makeCode(), t = now();
  q.run(`INSERT INTO recruitment_applications
    (id,code,full_name,ign,bgmi_uid,age,role,experience,previous_team,preferred_team,device,hours,contact,social_link,status,consent_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
    id, code, fullName, ign, bgmiUid, age, role, experience, previousTeam, preferredTeam, device, hours, contact, socialLink || null, t, t, t);

  return { applicationId: code };
}, { auth: false });

route('GET', '/api/recruitment/status/:code', ctx => {
  rateLimit('recruitstatus:' + ctx.ip, 20, 60000);
  const code = String(ctx.params.code || '').trim().toUpperCase();
  const a = q.get('SELECT * FROM recruitment_applications WHERE code=?', code);
  if (!a) throw notFound('No application found with that ID. Double-check the code from your confirmation.');
  return appPublicDto(a);
}, { auth: false });

/* =============== ADMIN REVIEW =============== */
const STATUSES = Object.keys(STATUS_LABEL);

function appAdminDto(a) {
  return {
    id: a.id, code: a.code, status: a.status, statusLabel: STATUS_LABEL[a.status],
    fullName: a.full_name, ign: a.ign, bgmiUid: a.bgmi_uid, age: a.age, role: a.role,
    experience: a.experience || '', previousTeam: a.previous_team || '', preferredTeam: a.preferred_team, preferredTeamLabel: TEAM_LABEL[a.preferred_team],
    device: a.device || '', hours: a.hours || '', contact: a.contact, socialLink: a.social_link || '',
    adminNotes: a.admin_notes || '', reviewedBy: a.reviewed_by, reviewedAt: a.reviewed_at,
    submittedAt: a.created_at, updatedAt: a.updated_at,
  };
}
function requireReviewer(u) { L.needPerm(u, 'recruitment', 'You do not have permission to review player applications. Ask the clan leader.'); }

// List + search + filter. Admin only (or a member granted the 'recruitment' permission).
route('GET', '/api/recruitment/applications', ctx => {
  requireReviewer(ctx.user);
  const where = [], params = [];
  if (ctx.query.status && STATUSES.includes(ctx.query.status)) { where.push('status=?'); params.push(ctx.query.status); }
  if (ctx.query.role && ROLES.includes(ctx.query.role)) { where.push('role=?'); params.push(ctx.query.role); }
  if (ctx.query.team && TEAMS.includes(ctx.query.team)) { where.push('preferred_team=?'); params.push(ctx.query.team); }
  const qstr = L.str(ctx.query.q, { max: 80 });
  if (qstr) { where.push('(ign LIKE ? OR bgmi_uid LIKE ? OR code LIKE ? OR full_name LIKE ?)'); const like = `%${qstr}%`; params.push(like, like, like, like); }
  const sql = `SELECT * FROM recruitment_applications${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 500`;
  const rows = q.all(sql, ...params);
  const counts = q.get(`SELECT COUNT(*) total, SUM(status='pending') pending, SUM(status='under_review') underReview, SUM(status='trial_invited') trialInvited, SUM(status='approved') approved, SUM(status='rejected') rejected FROM recruitment_applications`);
  return { applications: rows.map(appAdminDto), counts };
});

route('GET', '/api/recruitment/applications/:id', ctx => {
  requireReviewer(ctx.user);
  const a = q.get('SELECT * FROM recruitment_applications WHERE id=?', ctx.params.id);
  if (!a) throw notFound();
  const history = q.all('SELECT * FROM recruitment_audit WHERE application_id=? ORDER BY id DESC', a.id)
    .map(h => ({ id: h.id, adminId: h.admin_id, fromStatus: h.from_status, toStatus: h.to_status, note: h.note || '', createdAt: h.created_at }));
  return { ...appAdminDto(a), history };
});

route('PATCH', '/api/recruitment/applications/:id', ctx => {
  requireReviewer(ctx.user);
  const a = q.get('SELECT * FROM recruitment_applications WHERE id=?', ctx.params.id);
  if (!a) throw notFound();
  const b = ctx.body;
  const status = b.status !== undefined ? L.str(b.status, { name: 'Status', required: true }) : a.status;
  if (!STATUSES.includes(status)) throw bad('Invalid status.');
  const adminNotes = b.adminNotes !== undefined ? L.str(b.adminNotes, { name: 'Notes', max: 2000 }) : a.admin_notes;
  const t = now();
  q.run('UPDATE recruitment_applications SET status=?, admin_notes=?, reviewed_by=?, reviewed_at=?, updated_at=? WHERE id=?',
    status, adminNotes, ctx.user.id, t, t, a.id);
  if (status !== a.status) q.run('INSERT INTO recruitment_audit(application_id,admin_id,from_status,to_status,note,created_at) VALUES(?,?,?,?,?,?)',
    a.id, ctx.user.id, a.status, status, L.str(b.note, { max: 300 }), t);
  L.bump(ctx.user.familyId, 'recruitment', ctx.user.id);
  return appAdminDto({ ...a, status, admin_notes: adminNotes, reviewed_by: ctx.user.id, reviewed_at: t, updated_at: t });
});
