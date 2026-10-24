// API: plans, tasks, polls, events, calendar, shopping, expenses, albums, announcements
const { route, bad, forbidden, notFound } = require('./http');
const { q, uid, tx, now, json } = require('./db');
const L = require('./lib');
const ws = require('./ws');
const drive = require('./drive');

const PLAN_STATUS = ['upcoming', 'in_progress', 'completed', 'cancelled'];
const CATS = ['Scrim', 'Tournament', 'Ranked grind', 'Practice', 'Clan meeting', 'Team bonding', 'Streaming', 'Other'];
const REMINDERS = [0, 60, 1440, 10080];
const mins = v => { const n = Math.round(+v || 0); return REMINDERS.includes(n) ? n : 0; };
const canManagePlan = (u, p) => p.created_by === u.id || L.isAdmin(u) || !!u.perms.plans_manage;

/* =============== PLANS =============== */
function planDto(p) {
  const going = q.get("SELECT COUNT(*) c FROM plan_participants WHERE plan_id=? AND rsvp='yes'", p.id).c;
  const openTasks = q.get('SELECT COUNT(*) c FROM tasks WHERE plan_id=? AND done=0', p.id).c;
  return { id: p.id, title: p.title, description: p.description || '', category: p.category, startsAt: p.starts_at, location: p.location || '', budget: p.budget, status: p.status, reminderMins: p.reminder_mins, roomId: p.room_id, createdBy: p.created_by, createdAt: p.created_at, going, openTasks };
}
route('POST', '/api/plans', ctx => {
  L.needPerm(ctx.user, 'plans', 'You do not have permission to create plans.');
  const b = ctx.body, fid = ctx.user.familyId;
  const title = L.str(b.title, { name: 'Title', required: true, max: 120 });
  const category = CATS.includes(b.category) ? b.category : 'Other';
  const startsAt = L.ts(b.startsAt, { name: 'Date & time', required: true });
  const id = uid(), roomId = uid();
  const memberIds = L.familyMemberIds(fid);
  const invited = Array.isArray(b.participants) ? b.participants.filter(x => memberIds.includes(x)) : memberIds;
  tx(() => {
    q.run("INSERT INTO rooms(id,family_id,type,name,plan_id,created_at) VALUES(?,?,'plan',?,?,?)", roomId, fid, title, id, now());
    q.run('INSERT INTO plans(id,family_id,title,description,category,starts_at,location,budget,reminder_mins,room_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      id, fid, title, L.str(b.description, { max: 2000 }), category, startsAt, L.str(b.location, { max: 200 }), L.num(b.budget, { name: 'Budget', min: 0, max: 1e9 }), mins(b.reminderMins), roomId, ctx.user.id, now());
    for (const m of new Set([...invited, ctx.user.id])) q.run('INSERT INTO plan_participants(plan_id,user_id,rsvp) VALUES(?,?,?)', id, m, m === ctx.user.id ? 'yes' : null);
  });
  L.notify(invited.filter(x => x !== ctx.user.id), { title: `New plan: ${title}`, body: `${ctx.user.name} planned this for ${new Date(startsAt).toLocaleDateString()}`, url: '#/plan/' + id, kind: 'plan' });
  L.bump(fid, 'plans', ctx.user.id);
  return planDto(q.get('SELECT * FROM plans WHERE id=?', id));
});
route('GET', '/api/plans', ctx => {
  const fid = L.needFamily(ctx.user); const s = ctx.query.status;
  const rows = PLAN_STATUS.includes(s) ? q.all('SELECT * FROM plans WHERE family_id=? AND status=? ORDER BY starts_at', fid, s) : q.all('SELECT * FROM plans WHERE family_id=? ORDER BY starts_at', fid);
  return rows.map(planDto);
});
route('GET', '/api/plans/:id', ctx => {
  const p = L.owned('plans', ctx.params.id, ctx.user);
  return {
    plan: planDto(p),
    participants: q.all('SELECT user_id userId, rsvp FROM plan_participants WHERE plan_id=?', p.id),
    tasks: q.all('SELECT id,title,assignee_id assigneeId,due_at dueAt,done FROM tasks WHERE plan_id=? ORDER BY done, created_at', p.id).map(t => ({ ...t, done: !!t.done })),
    polls: q.all('SELECT * FROM polls WHERE plan_id=? ORDER BY created_at DESC', p.id).map(pollDto),
    files: q.all('SELECT * FROM files WHERE plan_id=? ORDER BY created_at DESC', p.id).map(f => L.fileDto(f, ctx.user)),
  };
});
route('PATCH', '/api/plans/:id', ctx => {
  const p = L.owned('plans', ctx.params.id, ctx.user);
  if (!canManagePlan(ctx.user, p)) throw forbidden('Only the plan creator or an administrator can edit this plan.');
  const b = ctx.body; const set = {};
  if (b.title !== undefined) set.title = L.str(b.title, { name: 'Title', required: true, max: 120 });
  if (b.description !== undefined) set.description = L.str(b.description, { max: 2000 });
  if (b.category !== undefined) set.category = CATS.includes(b.category) ? b.category : 'Other';
  if (b.startsAt !== undefined) { set.starts_at = L.ts(b.startsAt, { required: true }); set.reminded = 0; }
  if (b.location !== undefined) set.location = L.str(b.location, { max: 200 });
  if (b.budget !== undefined) set.budget = L.num(b.budget, { name: 'Budget', min: 0, max: 1e9 });
  if (b.status !== undefined) { if (!PLAN_STATUS.includes(b.status)) throw bad('Invalid status'); set.status = b.status; }
  const keys = Object.keys(set); if (!keys.length) return planDto(p);
  q.run(`UPDATE plans SET ${keys.map(k => k + '=?').join(',')} WHERE id=?`, ...keys.map(k => set[k]), p.id);
  if (set.title) q.run('UPDATE rooms SET name=? WHERE id=?', set.title, p.room_id);
  const parts = q.all('SELECT user_id FROM plan_participants WHERE plan_id=?', p.id).map(r => r.user_id).filter(x => x !== ctx.user.id);
  const cancelled = set.status === 'cancelled';
  L.notify(parts, { title: cancelled ? `Plan cancelled: ${p.title}` : `Plan updated: ${set.title || p.title}`, body: set.status ? `Status: ${set.status.replace('_', ' ')}` : 'Details changed', url: '#/plan/' + p.id, kind: 'plan' });
  L.bump(p.family_id, 'plan', ctx.user.id);
  return planDto(q.get('SELECT * FROM plans WHERE id=?', p.id));
});
route('DELETE', '/api/plans/:id', async ctx => {
  const p = L.owned('plans', ctx.params.id, ctx.user);
  if (!canManagePlan(ctx.user, p)) throw forbidden('Only the plan creator or an administrator can delete this plan.');
  q.run('UPDATE files SET plan_id=NULL WHERE plan_id=?', p.id);
  tx(() => { q.run('DELETE FROM rooms WHERE id=?', p.room_id); q.run('DELETE FROM plans WHERE id=?', p.id); });
  L.bump(p.family_id, 'plans', ctx.user.id);
});
route('POST', '/api/plans/:id/rsvp', ctx => {
  const p = L.owned('plans', ctx.params.id, ctx.user);
  if (!['yes', 'maybe', 'no'].includes(ctx.body.rsvp)) throw bad('Invalid response');
  q.run('INSERT INTO plan_participants(plan_id,user_id,rsvp) VALUES(?,?,?) ON CONFLICT(plan_id,user_id) DO UPDATE SET rsvp=excluded.rsvp', p.id, ctx.user.id, ctx.body.rsvp);
  L.bump(p.family_id, 'plan', ctx.user.id);
});
route('POST', '/api/plans/:id/remind', ctx => {
  const p = L.owned('plans', ctx.params.id, ctx.user);
  if (!canManagePlan(ctx.user, p)) throw forbidden();
  const ids = q.all("SELECT user_id FROM plan_participants WHERE plan_id=? AND COALESCE(rsvp,'')!='no'", p.id).map(r => r.user_id);
  L.notify(ids, { title: `Reminder: ${p.title}`, body: `${new Date(p.starts_at).toLocaleString()}${p.location ? ' · ' + p.location : ''}`, url: '#/plan/' + p.id, kind: 'reminder' });
});

/* ---- tasks ---- */
route('POST', '/api/plans/:id/tasks', ctx => {
  const p = L.owned('plans', ctx.params.id, ctx.user);
  const title = L.str(ctx.body.title, { name: 'Task', required: true, max: 200 });
  let assignee = ctx.body.assigneeId || null; if (assignee && !L.sameFamily(ctx.user, assignee)) throw bad('Assignee must be a clan member.');
  const id = uid();
  q.run('INSERT INTO tasks(id,plan_id,family_id,title,assignee_id,due_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', id, p.id, p.family_id, title, assignee, L.ts(ctx.body.dueAt), ctx.user.id, now());
  if (assignee && assignee !== ctx.user.id) L.notify([assignee], { title: `Task for you: ${title}`, body: `In plan "${p.title}"`, url: '#/plan/' + p.id, kind: 'task' });
  L.bump(p.family_id, 'plan', ctx.user.id);
  return { id };
});
route('PATCH', '/api/tasks/:id', ctx => {
  const t = L.owned('tasks', ctx.params.id, ctx.user);
  q.run('UPDATE tasks SET done=? WHERE id=?', ctx.body.done ? 1 : 0, t.id);
  L.bump(t.family_id, 'plan', ctx.user.id);
});

/* =============== POLLS =============== */
function pollDto(p) {
  const opts = json(p.options, []); const votes = q.all('SELECT user_id,opt FROM votes WHERE poll_id=?', p.id);
  return { id: p.id, question: p.question, planId: p.plan_id, closed: !!p.closed, createdBy: p.created_by, options: opts.map((text, i) => ({ text, votes: votes.filter(v => v.opt === i).map(v => v.user_id) })) };
}
route('GET', '/api/polls', ctx => q.all('SELECT * FROM polls WHERE family_id=? ORDER BY created_at DESC LIMIT 100', L.needFamily(ctx.user)).map(pollDto));
route('POST', '/api/polls', ctx => {
  const fid = L.needFamily(ctx.user);
  const question = L.str(ctx.body.question, { name: 'Question', required: true, max: 200 });
  const options = (Array.isArray(ctx.body.options) ? ctx.body.options : []).map(o => L.str(o, { name: 'Option', max: 100 })).filter(Boolean);
  if (options.length < 2 || options.length > 8) throw bad('A poll needs between 2 and 8 options.');
  let planId = null; if (ctx.body.planId) planId = L.owned('plans', ctx.body.planId, ctx.user).id;
  const id = uid();
  q.run('INSERT INTO polls(id,family_id,plan_id,question,options,created_by,created_at) VALUES(?,?,?,?,?,?,?)', id, fid, planId, question, JSON.stringify(options), ctx.user.id, now());
  L.notify(L.familyMemberIds(fid).filter(x => x !== ctx.user.id), { title: `New poll: ${question}`, url: planId ? '#/plan/' + planId : '#/polls', kind: 'poll' });
  L.bump(fid, planId ? 'plan' : 'polls', ctx.user.id);
  return { id };
});
route('POST', '/api/polls/:id/vote', ctx => {
  const p = L.owned('polls', ctx.params.id, ctx.user); if (p.closed) throw bad('This poll is closed.');
  const opt = Math.round(+ctx.body.option); const n = json(p.options, []).length;
  if (!(opt >= 0 && opt < n)) throw bad('Invalid option');
  const prev = q.get('SELECT opt FROM votes WHERE poll_id=? AND user_id=?', p.id, ctx.user.id);
  if (prev && prev.opt === opt) q.run('DELETE FROM votes WHERE poll_id=? AND user_id=?', p.id, ctx.user.id); // tap again to un-vote
  else q.run('INSERT INTO votes(poll_id,user_id,opt) VALUES(?,?,?) ON CONFLICT(poll_id,user_id) DO UPDATE SET opt=excluded.opt', p.id, ctx.user.id, opt);
  L.bump(p.family_id, p.plan_id ? 'plan' : 'polls', ctx.user.id);
});
route('POST', '/api/polls/:id/close', ctx => {
  const p = L.owned('polls', ctx.params.id, ctx.user);
  if (p.created_by !== ctx.user.id && !L.isAdmin(ctx.user)) throw forbidden('Only the poll creator or an administrator can close it.');
  q.run('UPDATE polls SET closed=1 WHERE id=?', p.id);
  const d = pollDto(p); const top = [...d.options].sort((a, b) => b.votes.length - a.votes.length)[0];
  L.notify(L.familyMemberIds(p.family_id), { title: `Poll result: ${p.question}`, body: top && top.votes.length ? `Winner: ${top.text} (${top.votes.length} votes)` : 'No votes were cast', url: p.plan_id ? '#/plan/' + p.plan_id : '#/polls', kind: 'poll' });
  L.bump(p.family_id, p.plan_id ? 'plan' : 'polls', ctx.user.id);
});

/* =============== EVENTS & CALENDAR =============== */
const eventDto = (e, u) => ({ id: e.id, title: e.title, description: e.description || '', startsAt: e.starts_at, endsAt: e.ends_at, location: e.location || '', canEdit: e.created_by === u.id || L.isAdmin(u) });
route('GET', '/api/events', ctx => q.all('SELECT * FROM events WHERE family_id=? ORDER BY starts_at', L.needFamily(ctx.user)).map(e => eventDto(e, ctx.user)));
route('POST', '/api/events', ctx => {
  L.needPerm(ctx.user, 'events', 'You do not have permission to add events.');
  const b = ctx.body, fid = ctx.user.familyId; const id = uid();
  const title = L.str(b.title, { name: 'Title', required: true, max: 120 });
  const startsAt = L.ts(b.startsAt, { name: 'Start', required: true }), endsAt = L.ts(b.endsAt);
  if (endsAt && endsAt < startsAt) throw bad('The end must be after the start.');
  q.run('INSERT INTO events(id,family_id,title,description,starts_at,ends_at,location,reminder_mins,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, fid, title, L.str(b.description, { max: 2000 }), startsAt, endsAt, L.str(b.location, { max: 200 }), mins(b.reminderMins), ctx.user.id, now());
  L.notify(L.familyMemberIds(fid).filter(x => x !== ctx.user.id), { title: `New event: ${title}`, body: new Date(startsAt).toLocaleString(), url: '#/events', kind: 'event' });
  L.bump(fid, 'events', ctx.user.id); L.bump(fid, 'calendar', ctx.user.id);
  return { id };
});
route('PATCH', '/api/events/:id', ctx => {
  const e = L.owned('events', ctx.params.id, ctx.user);
  if (e.created_by !== ctx.user.id && !L.isAdmin(ctx.user)) throw forbidden();
  const b = ctx.body;
  q.run('UPDATE events SET title=?,description=?,starts_at=?,ends_at=?,location=?,reminded=0 WHERE id=?', b.title !== undefined ? L.str(b.title, { required: true, max: 120 }) : e.title, b.description !== undefined ? L.str(b.description, { max: 2000 }) : e.description, b.startsAt !== undefined ? L.ts(b.startsAt, { required: true }) : e.starts_at, b.endsAt !== undefined ? L.ts(b.endsAt) : e.ends_at, b.location !== undefined ? L.str(b.location, { max: 200 }) : e.location, e.id);
  L.notify(L.familyMemberIds(e.family_id).filter(x => x !== ctx.user.id), { title: `Event changed: ${e.title}`, url: '#/events', kind: 'event' });
  L.bump(e.family_id, 'events', ctx.user.id);
});
route('DELETE', '/api/events/:id', ctx => {
  const e = L.owned('events', ctx.params.id, ctx.user);
  if (e.created_by !== ctx.user.id && !L.isAdmin(ctx.user)) throw forbidden('Only the creator or an administrator can delete this event.');
  q.run('DELETE FROM events WHERE id=?', e.id);
  L.notify(L.familyMemberIds(e.family_id).filter(x => x !== ctx.user.id), { title: `Event cancelled: ${e.title}`, url: '#/events', kind: 'event' });
  L.bump(e.family_id, 'events', ctx.user.id);
});
route('GET', '/api/calendar', ctx => {
  const fid = L.needFamily(ctx.user); const from = L.ts(ctx.query.from, { required: true }), to = L.ts(ctx.query.to, { required: true });
  return [
    ...q.all('SELECT id,title,starts_at,location FROM events WHERE family_id=? AND starts_at>=? AND starts_at<? ORDER BY starts_at', fid, from, to).map(e => ({ kind: 'event', id: e.id, title: e.title, startsAt: e.starts_at, location: e.location })),
    ...q.all("SELECT id,title,starts_at,location FROM plans WHERE family_id=? AND status!='cancelled' AND starts_at>=? AND starts_at<? ORDER BY starts_at", fid, from, to).map(e => ({ kind: 'plan', id: e.id, title: e.title, startsAt: e.starts_at, location: e.location })),
  ].sort((a, b) => a.startsAt - b.startsAt);
});

/* =============== SHOPPING =============== */
route('GET', '/api/shopping', ctx => q.all('SELECT * FROM shopping_lists WHERE family_id=? ORDER BY created_at DESC', L.needFamily(ctx.user)).map(l => ({
  id: l.id, name: l.name,
  items: q.all('SELECT id,name,qty,price,assignee_id assigneeId,link,status FROM shopping_items WHERE list_id=? ORDER BY status DESC, created_at', l.id).sort((a, b) => (a.status === 'bought') - (b.status === 'bought')) })));
route('POST', '/api/shopping', ctx => {
  const fid = L.needFamily(ctx.user); const id = uid();
  q.run('INSERT INTO shopping_lists(id,family_id,name,created_by,created_at) VALUES(?,?,?,?,?)', id, fid, L.str(ctx.body.name, { name: 'List name', required: true, max: 80 }), ctx.user.id, now());
  L.bump(fid, 'shopping', ctx.user.id); return { id };
});
route('DELETE', '/api/shopping/:id', ctx => { const l = L.owned('shopping_lists', ctx.params.id, ctx.user); q.run('DELETE FROM shopping_lists WHERE id=?', l.id); L.bump(l.family_id, 'shopping', ctx.user.id); });
route('POST', '/api/shopping/:id/items', ctx => {
  const l = L.owned('shopping_lists', ctx.params.id, ctx.user); const b = ctx.body;
  let link = L.str(b.link, { max: 500 }); if (link && !/^https?:\/\//i.test(link)) throw bad('Product link must start with http:// or https://');
  let assignee = b.assigneeId || null; if (assignee && !L.sameFamily(ctx.user, assignee)) throw bad('Assignee must be a clan member.');
  const id = uid();
  q.run('INSERT INTO shopping_items(id,list_id,name,qty,price,assignee_id,link,created_at) VALUES(?,?,?,?,?,?,?,?)', id, l.id, L.str(b.name, { name: 'Product', required: true, max: 120 }), L.num(b.qty, { name: 'Quantity', min: 0.01, max: 100000 }) || 1, L.num(b.price, { name: 'Price', min: 0, max: 1e9 }), assignee, link || null, now());
  if (assignee && assignee !== ctx.user.id) L.notify([assignee], { title: `Please buy: ${b.name}`, body: `On list "${l.name}"`, url: '#/shopping', kind: 'task' });
  L.bump(l.family_id, 'shopping', ctx.user.id); return { id };
});
function itemFor(ctx) {
  const it = q.get('SELECT i.*, l.family_id FROM shopping_items i JOIN shopping_lists l ON l.id=i.list_id WHERE i.id=? AND l.family_id=?', ctx.params.id, L.needFamily(ctx.user)); if (!it) throw notFound(); return it;
}
route('PATCH', '/api/shopping/items/:id', ctx => { const it = itemFor(ctx); if (!['pending', 'bought'].includes(ctx.body.status)) throw bad('Invalid status'); q.run('UPDATE shopping_items SET status=? WHERE id=?', ctx.body.status, it.id); L.bump(it.family_id, 'shopping', ctx.user.id); });
route('DELETE', '/api/shopping/items/:id', ctx => { const it = itemFor(ctx); q.run('DELETE FROM shopping_items WHERE id=?', it.id); L.bump(it.family_id, 'shopping', ctx.user.id); });

/* =============== EXPENSES (private: needs the 'expenses' permission) =============== */
route('GET', '/api/expenses', ctx => {
  L.needPerm(ctx.user, 'expenses', 'Clan funds are private. Ask the clan leader for access.');
  const fid = ctx.user.familyId; const month = /^\d{4}-\d{2}$/.test(ctx.query.month || '') ? ctx.query.month : new Date().toISOString().slice(0, 7);
  const rows = q.all("SELECT * FROM expenses WHERE family_id=? AND date LIKE ? ORDER BY date DESC, created_at DESC", fid, month + '%');
  const items = rows.map(e => ({ id: e.id, title: e.title, amount: e.amount, date: e.date, category: e.category || 'Other', paidBy: e.paid_by, split: q.all('SELECT user_id FROM expense_splits WHERE expense_id=?', e.id).map(s => s.user_id), canDelete: e.created_by === ctx.user.id || L.isAdmin(ctx.user) }));
  const bal = {}; // positive = is owed money
  for (const e of items) { bal[e.paidBy] = (bal[e.paidBy] || 0) + e.amount; const share = e.amount / (e.split.length || 1); e.split.forEach(u => bal[u] = (bal[u] || 0) - share); }
  const debtors = Object.entries(bal).filter(([, v]) => v < -0.005).map(([id, v]) => [id, -v]).sort((a, b) => b[1] - a[1]);
  const creditors = Object.entries(bal).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
  const settlements = []; let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) { const amt = Math.min(debtors[i][1], creditors[j][1]); settlements.push({ from: debtors[i][0], to: creditors[j][0], amount: Math.round(amt * 100) / 100 }); debtors[i][1] -= amt; creditors[j][1] -= amt; if (debtors[i][1] < 0.005) i++; if (creditors[j][1] < 0.005) j++; }
  return { items, total: Math.round(items.reduce((a, e) => a + e.amount, 0) * 100) / 100, settlements };
});
route('POST', '/api/expenses', ctx => {
  L.needPerm(ctx.user, 'expenses', 'Clan funds are private. Ask the clan leader for access.');
  const b = ctx.body, fid = ctx.user.familyId;
  const title = L.str(b.title, { name: 'Title', required: true, max: 120 });
  const amount = L.num(b.amount, { name: 'Amount', min: 0.01, max: 1e9, required: true });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) throw bad('Date is invalid');
  const ids = L.familyMemberIds(fid);
  if (!ids.includes(b.paidBy)) throw bad('Choose who paid.');
  const split = [...new Set(Array.isArray(b.split) ? b.split.filter(x => ids.includes(x)) : [])]; if (!split.length) throw bad('Select who shares this cost.');
  const id = uid();
  tx(() => { q.run('INSERT INTO expenses(id,family_id,title,amount,date,category,paid_by,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, fid, title, amount, b.date, L.str(b.category, { max: 40 }) || 'Other', b.paidBy, ctx.user.id, now()); split.forEach(u => q.run('INSERT INTO expense_splits(expense_id,user_id) VALUES(?,?)', id, u)); });
  L.bump(fid, 'expenses', ctx.user.id); return { id };
});
route('DELETE', '/api/expenses/:id', ctx => {
  L.needPerm(ctx.user, 'expenses');
  const e = L.owned('expenses', ctx.params.id, ctx.user);
  if (e.created_by !== ctx.user.id && !L.isAdmin(ctx.user)) throw forbidden();
  q.run('DELETE FROM expenses WHERE id=?', e.id); L.bump(e.family_id, 'expenses', ctx.user.id);
});

/* =============== ALBUMS / MEMORIES =============== */
const photoRows = (fid, where = '', ...p) => q.all(`SELECT * FROM files WHERE family_id=? AND category IN ('memories','photos') AND (mime LIKE 'image/%' OR mime LIKE 'video/%') ${where} ORDER BY created_at DESC LIMIT 300`, fid, ...p);
route('GET', '/api/albums', ctx => {
  const fid = L.needFamily(ctx.user);
  const albums = q.all('SELECT * FROM albums WHERE family_id=? ORDER BY created_at DESC', fid).map(a => {
    const fs = q.all("SELECT id,mime FROM files WHERE album_id=? ORDER BY created_at DESC", a.id);
    return { id: a.id, name: a.name, count: fs.length, coverId: fs.find(f => f.mime.startsWith('image/'))?.id || null };
  });
  return { albums, photos: photoRows(fid).map(f => L.fileDto(f, ctx.user)) };
});
route('POST', '/api/albums', ctx => {
  const fid = L.needFamily(ctx.user); const id = uid();
  q.run('INSERT INTO albums(id,family_id,name,description,created_by,created_at) VALUES(?,?,?,?,?,?)', id, fid, L.str(ctx.body.name, { name: 'Album name', required: true, max: 80 }), L.str(ctx.body.description, { max: 300 }), ctx.user.id, now());
  L.bump(fid, 'memories', ctx.user.id); return { id };
});
route('GET', '/api/albums/:id', ctx => {
  const a = L.owned('albums', ctx.params.id, ctx.user);
  return { album: { id: a.id, name: a.name, description: a.description }, photos: photoRows(a.family_id, 'AND album_id=?', a.id).map(f => L.fileDto(f, ctx.user)), canEdit: a.created_by === ctx.user.id || L.isAdmin(ctx.user) };
});
route('DELETE', '/api/albums/:id', ctx => {
  const a = L.owned('albums', ctx.params.id, ctx.user);
  if (a.created_by !== ctx.user.id && !L.isAdmin(ctx.user)) throw forbidden();
  q.run('UPDATE files SET album_id=NULL WHERE album_id=?', a.id); q.run('DELETE FROM albums WHERE id=?', a.id); L.bump(a.family_id, 'memories', ctx.user.id);
});

/* =============== ANNOUNCEMENTS =============== */
route('POST', '/api/announcements', ctx => {
  const fid = L.needAdmin(ctx.user) || ctx.user.familyId;
  const title = L.str(ctx.body.title, { name: 'Title', required: true, max: 120 }), body = L.str(ctx.body.body, { max: 1000 });
  q.run('INSERT INTO announcements(id,family_id,title,body,created_by,created_at) VALUES(?,?,?,?,?,?)', uid(), fid, title, body, ctx.user.id, now());
  L.notify(L.familyMemberIds(fid).filter(x => x !== ctx.user.id), { title: '📢 ' + title, body, url: '#/home', kind: 'announce' });
  L.bump(fid, 'home', ctx.user.id);
});

/* =============== REMINDER SCHEDULER (runs every minute) =============== */
function runReminders() {
  const t = now();
  for (const p of q.all("SELECT * FROM plans WHERE reminder_mins>0 AND reminded=0 AND status IN ('upcoming','in_progress') AND starts_at-reminder_mins*60000<=? AND starts_at>?", t, t - 3600000)) {
    q.run('UPDATE plans SET reminded=1 WHERE id=?', p.id);
    L.notify(q.all("SELECT user_id FROM plan_participants WHERE plan_id=? AND COALESCE(rsvp,'')!='no'", p.id).map(r => r.user_id), { title: `⏰ Coming up: ${p.title}`, body: new Date(p.starts_at).toLocaleString(), url: '#/plan/' + p.id, kind: 'reminder' });
  }
  for (const e of q.all('SELECT * FROM events WHERE reminder_mins>0 AND reminded=0 AND starts_at-reminder_mins*60000<=? AND starts_at>?', t, t - 3600000)) {
    q.run('UPDATE events SET reminded=1 WHERE id=?', e.id);
    L.notify(L.familyMemberIds(e.family_id), { title: `⏰ Coming up: ${e.title}`, body: new Date(e.starts_at).toLocaleString(), url: '#/events', kind: 'reminder' });
  }
  // housekeeping: expired sessions
  q.run('DELETE FROM sessions WHERE expires_at<?', t);
}
module.exports = { runReminders };
