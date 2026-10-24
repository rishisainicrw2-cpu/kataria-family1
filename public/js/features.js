/* Plans, calendar, events, polls, shopping, expenses, memories */
KF.actions = {};
const PLAN_CATS = ['Scrim', 'Tournament', 'Ranked grind', 'Practice', 'Clan meeting', 'Team bonding', 'Streaming', 'Other'];
const EXP_CATS = ['Groceries', 'Food & dining', 'Travel', 'Bills', 'Shopping', 'Health', 'Education', 'Celebration', 'Other'];
const can = p => { const me = KF.state.me; return me.role === 'owner' || me.role === 'admin' || (me.perms && me.perms[p]); };
KF.can = can;
const memberOptions = (sel) => KF.state.members.map(m => ({ value: m.id, label: m.name }));
const done = (scope) => { KF.send({ type: 'changed', scope }); };

/* ---------- PLANS ---------- */
KF.actions.newPlan = async () => {
  if (!can('plans')) return toast('You do not have permission to create plans. Ask the clan leader.');
  const v = await formSheet('New match plan', [
    { name: 'title', label: 'Title', required: true, placeholder: 'Goa trip, Diwali dinner…' },
    { name: 'category', label: 'Category', type: 'select', options: PLAN_CATS },
    { name: 'description', label: 'Description', type: 'textarea' },
    { name: 'startsAt', label: 'Date & time', type: 'datetime-local', value: localISO(new Date(Date.now() + 86400000)), required: true },
    { name: 'location', label: 'Location' },
    { name: 'budget', label: `Estimated budget`, type: 'number', step: '0.01' },
    { name: 'reminderMins', label: 'Remind me', type: 'select', options: [{ value: 0, label: 'No reminder' }, { value: 60, label: '1 hour before' }, { value: 1440, label: '1 day before' }, { value: 10080, label: '1 week before' }], value: 1440 },
  ], 'Create plan');
  if (!v) return;
  try { const p = await api('/plans', { method: 'POST', body: { ...v, startsAt: new Date(v.startsAt).toISOString(), participants: KF.state.members.map(m => m.id) } }); toast('Plan created'); location.hash = '#/plan/' + p.id; } catch (e) { toast(e.message); }
};

KF.views.plans = async view => {
  let status = 'all';
  const draw = async () => {
    const plans = await api('/plans' + (status === 'all' ? '' : '?status=' + status));
    $('#plan-list', view).innerHTML = plans.length ? plans.map(p => `<a href="#/plan/${p.id}" class="card" style="text-decoration:none;color:inherit;display:block">
      <div class="row"><b class="grow">${esc(p.title)}</b><span class="pill ${p.status}">${p.status.replace('_', ' ')}</span></div>
      <div class="small muted" style="margin-top:4px">${esc(p.category)} · ${fmtDT(p.startsAt)}${p.location ? ' · 📍 ' + esc(p.location) : ''}</div>
      <div class="small" style="margin-top:6px">👥 ${p.going || 0} going${p.budget ? ' · 💰 ' + money(p.budget) : ''}${p.openTasks ? ' · ☑️ ' + p.openTasks + ' open tasks' : ''}</div></a>`).join('')
      : `<div class="empty"><div class="big">🧭</div>No plans here yet.<br>Tap + to plan something together.</div>`;
  };
  view.innerHTML = `<div class="gap fade"><div class="chips">${[['all', 'All'], ['upcoming', 'Upcoming'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['cancelled', 'Cancelled']].map(([k, l]) => `<button class="chip ${k === status ? 'on' : ''}" data-st="${k}">${l}</button>`).join('')}</div>
    <div class="row wrap"><a class="btn small ghost" href="#/polls">🗳️ Polls</a><a class="btn small ghost" href="#/events">🎉 Events</a>${KF.state.rooms.find(r => r.type === 'planning') ? `<a class="btn small ghost" href="#/room/${KF.state.rooms.find(r => r.type === 'planning').id}">💬 Planning chat</a>` : ''}</div>
    <div id="plan-list" class="gap"></div></div><button class="fab" aria-label="New plan">+</button>`;
  $$('[data-st]', view).forEach(b => b.onclick = () => { status = b.dataset.st; $$('[data-st]', view).forEach(x => x.classList.toggle('on', x === b)); draw(); });
  $('.fab', view).onclick = KF.actions.newPlan;
  await draw();
};

KF.views.plan = async (view, [id]) => {
  const d = await api('/plans/' + id), p = d.plan, me = KF.state.me;
  const mine = d.participants.find(x => x.userId === me.id);
  const canEdit = p.createdBy === me.id || me.role !== 'member' || can('plans_manage');
  KF.setTitle(p.title, { back: '#/plans' });
  view.innerHTML = `<div class="gap fade">
    <div class="card"><div class="row"><span class="pill ${p.status}">${p.status.replace('_', ' ')}</span><span class="pill">${esc(p.category)}</span></div>
      <h2 style="margin:8px 0">${esc(p.title)}</h2>
      <div class="small muted">🗓 ${fmtDT(p.startsAt)}${p.location ? '<br>📍 ' + esc(p.location) : ''}${p.budget ? '<br>💰 Budget ' + money(p.budget) : ''}${p.reminderMins ? '<br>⏰ Reminder ' + (p.reminderMins >= 1440 ? p.reminderMins / 1440 + ' day(s)' : p.reminderMins + ' min') + ' before' : ''}<br>Created ${fmtDate(p.createdAt)} by ${esc(member(p.createdBy)?.name || 'a former member')}</div>
      ${p.description ? `<p>${esc(p.description).replace(/\n/g, '<br>')}</p>` : ''}
      <div class="row wrap" style="margin-top:10px">
        ${['yes', 'maybe', 'no'].map(r => `<button class="btn small ${mine?.rsvp === r ? 'gold' : 'ghost'}" data-rsvp="${r}">${{ yes: '✅ Going', maybe: '🤔 Maybe', no: '❌ Can\'t' }[r]}</button>`).join('')}
        <a class="btn small ghost" href="#/room/${p.roomId}" style="text-decoration:none">💬 Discussion</a></div></div>
    <div class="card"><h3>Who's coming</h3><div class="list">${d.participants.map(x => `<div class="row">${avatar(member(x.userId), 'sm')}<span class="grow">${esc(member(x.userId)?.name || 'Former member')}</span><span class="pill">${x.rsvp || 'invited'}</span></div>`).join('')}</div></div>
    <div class="card"><div class="row"><h3 class="grow" style="margin:0">Tasks &amp; checklist</h3><button class="btn small ghost" data-addtask>+ Add</button></div>
      ${d.tasks.length ? `<div class="list">${d.tasks.map(t => `<label class="row" style="margin:0;color:inherit;font-size:1rem"><input type="checkbox" style="width:22px;height:22px" data-task="${t.id}" ${t.done ? 'checked' : ''}><span class="grow ${t.done ? 'muted' : ''}" style="${t.done ? 'text-decoration:line-through' : ''}">${esc(t.title)}<div class="small muted">${t.assigneeId ? '👤 ' + esc(member(t.assigneeId)?.name || '') : 'Unassigned'}${t.dueAt ? ' · due ' + fmtDate(t.dueAt) : ''}</div></span></label>`).join('')}</div>` : '<div class="muted small" style="margin-top:6px">No tasks yet. Assign responsibilities to clan members.</div>'}</div>
    <div class="card"><div class="row"><h3 class="grow" style="margin:0">Polls</h3><button class="btn small ghost" data-addpoll>+ Poll</button></div>
      ${d.polls.length ? d.polls.map(pollHTML).join('') : '<div class="muted small" style="margin-top:6px">Ask the clan to vote on options (dates, places…).</div>'}</div>
    <div class="card"><div class="row"><h3 class="grow" style="margin:0">Attachments</h3><button class="btn small ghost" data-attach>+ File</button></div>
      ${d.files.length ? `<div class="list">${d.files.map(f => `<a href="/api/files/${f.id}/content" download="${esc(f.name)}" style="color:inherit;text-decoration:none" class="row">📎 <span class="grow">${esc(f.name)}</span><span class="small muted">${fmtSize(f.size)}</span></a>`).join('')}</div>` : '<div class="muted small" style="margin-top:6px">Tickets, photos, documents — stored in your Google Drive.</div>'}</div>
    ${canEdit ? `<div class="card"><h3>Manage plan</h3><div class="row wrap">
      <select data-status style="width:auto">${['upcoming', 'in_progress', 'completed', 'cancelled'].map(s => `<option ${s === p.status ? 'selected' : ''} value="${s}">${s.replace('_', ' ')}</option>`).join('')}</select>
      <button class="btn small ghost" data-edit>Edit</button><button class="btn small ghost" data-remind>⏰ Remind everyone</button><button class="btn small danger" data-del>Delete</button></div></div>` : ''}
  </div>`;
  $$('[data-rsvp]', view).forEach(b => b.onclick = async () => { try { await api(`/plans/${id}/rsvp`, { method: 'POST', body: { rsvp: b.dataset.rsvp } }); route(); } catch (e) { toast(e.message); } });
  $$('[data-task]', view).forEach(c => c.onchange = async () => { try { await api('/tasks/' + c.dataset.task, { method: 'PATCH', body: { done: c.checked } }); route(); } catch (e) { toast(e.message); c.checked = !c.checked; } });
  $('[data-addtask]', view).onclick = async () => {
    const v = await formSheet('Add task', [{ name: 'title', label: 'Task', required: true }, { name: 'assigneeId', label: 'Assign to', type: 'select', options: [{ value: '', label: 'Anyone' }, ...memberOptions()] }, { name: 'dueAt', label: 'Due date (optional)', type: 'date' }]);
    if (v) try { await api(`/plans/${id}/tasks`, { method: 'POST', body: v }); route(); } catch (e) { toast(e.message); }
  };
  $('[data-addpoll]', view).onclick = () => KF.actions.newPoll(id);
  wirePolls(view);
  $('[data-attach]', view).onclick = async () => { const [f] = await pickFile(); if (!f) return; toast('Uploading…'); try { await uploadFile(f, 'plans', { planId: id }); route(); } catch (e) { toast(e.message); } };
  const st = $('[data-status]', view); if (st) st.onchange = async () => { try { await api('/plans/' + id, { method: 'PATCH', body: { status: st.value } }); toast('Status updated'); route(); } catch (e) { toast(e.message); } };
  const ed = $('[data-edit]', view); if (ed) ed.onclick = async () => {
    const v = await formSheet('Edit plan', [{ name: 'title', label: 'Title', value: p.title, required: true }, { name: 'category', label: 'Category', type: 'select', options: PLAN_CATS, value: p.category }, { name: 'description', label: 'Description', type: 'textarea', value: p.description }, { name: 'startsAt', label: 'Date & time', type: 'datetime-local', value: localISO(new Date(p.startsAt)) }, { name: 'location', label: 'Location', value: p.location }, { name: 'budget', label: 'Budget', type: 'number', step: '0.01', value: p.budget || '' }]);
    if (v) try { await api('/plans/' + id, { method: 'PATCH', body: { ...v, startsAt: new Date(v.startsAt).toISOString() } }); route(); } catch (e) { toast(e.message); }
  };
  const rm = $('[data-remind]', view); if (rm) rm.onclick = async () => { try { await api(`/plans/${id}/remind`, { method: 'POST' }); toast('Reminder sent to participants'); } catch (e) { toast(e.message); } };
  const dl = $('[data-del]', view); if (dl) dl.onclick = async () => { if (await confirmSheet('Delete this plan and its discussion?', 'Delete', true)) try { await api('/plans/' + id, { method: 'DELETE' }); location.hash = '#/plans'; } catch (e) { toast(e.message); } };
};

/* ---------- POLLS ---------- */
function pollHTML(po) {
  const total = po.options.reduce((a, o) => a + o.votes.length, 0), me = KF.state.me.id;
  return `<div style="margin-top:12px" data-poll="${po.id}"><b>${esc(po.question)}</b> ${po.closed ? '<span class="pill">closed</span>' : ''}
    ${po.options.map((o, i) => `<div style="margin:8px 0;cursor:${po.closed ? 'default' : 'pointer'}" data-opt="${i}"><div class="row small"><span class="grow">${o.votes.includes(me) ? '✅ ' : ''}${esc(o.text)}</span><span>${o.votes.length}</span></div><div class="bar"><i style="width:${total ? Math.round(100 * o.votes.length / total) : 0}%"></i></div></div>`).join('')}
    <div class="small muted">${total} vote${total === 1 ? '' : 's'}${!po.closed && (po.createdBy === me || KF.state.me.role !== 'member') ? ' · <a href="#" data-closepoll>Close poll</a>' : ''}</div></div>`;
}
function wirePolls(root) {
  $$('[data-poll]', root).forEach(el => {
    const id = el.dataset.poll;
    $$('[data-opt]', el).forEach(o => o.onclick = async () => { try { await api(`/polls/${id}/vote`, { method: 'POST', body: { option: +o.dataset.opt } }); route(); } catch (e) { toast(e.message); } });
    const c = $('[data-closepoll]', el); if (c) c.onclick = async e => { e.preventDefault(); try { await api(`/polls/${id}/close`, { method: 'POST' }); route(); } catch (x) { toast(x.message); } };
  });
}
KF.actions.newPoll = async (planId) => {
  const v = await formSheet('New poll', [{ name: 'question', label: 'Question', required: true, placeholder: 'Which weekend works?' }, { name: 'options', label: 'Options (one per line, 2–8)', type: 'textarea', required: true }], 'Create poll');
  if (!v) return;
  const options = v.options.split('\n').map(s => s.trim()).filter(Boolean);
  if (options.length < 2) return toast('Add at least two options');
  try { await api('/polls', { method: 'POST', body: { question: v.question, options, planId: planId || null } }); route(); } catch (e) { toast(e.message); }
};
KF.views.polls = async view => {
  const polls = await api('/polls');
  view.innerHTML = `<div class="gap fade">${polls.length ? polls.map(p => `<div class="card">${pollHTML(p)}${p.planId ? `<a class="small" href="#/plan/${p.planId}">View plan</a>` : ''}</div>`).join('') : '<div class="empty"><div class="big">🗳️</div>No polls yet. Create one to decide together.</div>'}</div><button class="fab" aria-label="New poll">+</button>`;
  wirePolls(view); $('.fab', view).onclick = () => KF.actions.newPoll();
};

/* ---------- EVENTS ---------- */
KF.actions.newEvent = async (prefDate) => {
  if (!can('events')) return toast('You do not have permission to add events.');
  const v = await formSheet('Add clan event', [{ name: 'title', label: 'Event title', required: true }, { name: 'startsAt', label: 'Starts', type: 'datetime-local', value: prefDate || localISO(new Date(Date.now() + 86400000)), required: true }, { name: 'endsAt', label: 'Ends (optional)', type: 'datetime-local' }, { name: 'location', label: 'Location' }, { name: 'description', label: 'Details', type: 'textarea' }, { name: 'reminderMins', label: 'Remind', type: 'select', options: [{ value: 0, label: 'No reminder' }, { value: 60, label: '1 hour before' }, { value: 1440, label: '1 day before' }], value: 60 }], 'Add event');
  if (!v) return;
  try { await api('/events', { method: 'POST', body: { ...v, startsAt: new Date(v.startsAt).toISOString(), endsAt: v.endsAt ? new Date(v.endsAt).toISOString() : null } }); toast('Event added'); route(); } catch (e) { toast(e.message); }
};
KF.views.events = async view => {
  const evs = await api('/events');
  const evRoom = KF.state.rooms.find(r => r.type === 'events');
  const up = evs.filter(e => new Date(e.endsAt || e.startsAt) >= new Date()), past = evs.filter(e => !up.includes(e));
  const card = e => `<div class="card"><div class="row"><b class="grow">${esc(e.title)}</b>${e.canEdit ? `<button class="icon-btn" data-evdel="${e.id}">🗑</button>` : ''}</div><div class="small muted">🗓 ${fmtDT(e.startsAt)}${e.location ? '<br>📍 ' + esc(e.location) : ''}</div>${e.description ? `<p class="small">${esc(e.description)}</p>` : ''}</div>`;
  view.innerHTML = `<div class="gap fade">${evRoom ? `<a class="btn ghost block" style="text-align:center;text-decoration:none" href="#/room/${evRoom.id}">💬 Events chat</a>` : ''}
    <h3>Upcoming</h3>${up.length ? up.map(card).join('') : '<div class="empty"><div class="big">🎉</div>No upcoming events.</div>'}
    ${past.length ? `<h3>Past</h3>${past.slice(0, 10).map(card).join('')}` : ''}</div><button class="fab" aria-label="Add event">+</button>`;
  $('.fab', view).onclick = () => KF.actions.newEvent();
  $$('[data-evdel]', view).forEach(b => b.onclick = async () => { if (await confirmSheet('Delete this event?', 'Delete', true)) try { await api('/events/' + b.dataset.evdel, { method: 'DELETE' }); route(); } catch (e) { toast(e.message); } });
};

/* ---------- CALENDAR (month / week / day) ---------- */
KF.views.calendar = async view => {
  let mode = 'month', cur = new Date(); cur.setHours(0, 0, 0, 0); let sel = new Date(cur);
  const same = (a, b) => a.toDateString() === b.toDateString();
  async function draw() {
    let from, to;
    if (mode === 'month') { from = new Date(cur.getFullYear(), cur.getMonth(), 1); to = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); from.setDate(from.getDate() - from.getDay()); to.setDate(to.getDate() + 7); }
    else if (mode === 'week') { from = new Date(cur); from.setDate(from.getDate() - from.getDay()); to = new Date(from); to.setDate(to.getDate() + 7); }
    else { from = new Date(cur); to = new Date(cur); to.setDate(to.getDate() + 1); }
    let items = [];
    try { items = await api(`/calendar?from=${from.toISOString()}&to=${to.toISOString()}`); } catch (e) { toast(e.message); }
    const on = d => items.filter(i => same(new Date(i.startsAt), d));
    const item = i => `<a href="#/${i.kind === 'plan' ? 'plan/' + i.id : 'events'}" class="row" style="text-decoration:none;color:inherit;padding:8px 0"><span class="pill ${i.kind === 'plan' ? 'gold' : ''}">${i.kind}</span><span class="grow"><b>${esc(i.title)}</b><div class="small muted">${fmtTime(i.startsAt)}${i.location ? ' · ' + esc(i.location) : ''}</div></span></a>`;
    let html = `<div class="row"><button class="icon-btn" data-nav="-1">${icon('back')}</button><h3 class="grow center">${mode === 'day' ? cur.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }) : mode === 'week' ? 'Week of ' + from.toLocaleDateString([], { day: 'numeric', month: 'short' }) : cur.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h3><button class="icon-btn" data-nav="1" style="transform:scaleX(-1)">${icon('back')}</button></div>
      <div class="chips" style="justify-content:center">${['month', 'week', 'day'].map(m => `<button class="chip ${m === mode ? 'on' : ''}" data-mode="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}<button class="chip" data-today>Today</button></div>`;
    if (mode === 'month') {
      html += `<div class="card"><div class="cal">${'SMTWTFS'.split('').map(c => `<div class="h">${c}</div>`).join('')}`;
      const d = new Date(from);
      while (d < to && d <= new Date(cur.getFullYear(), cur.getMonth() + 1, 7)) {
        const dd = new Date(d), inM = dd.getMonth() === cur.getMonth();
        html += `<div class="d ${same(dd, new Date()) ? 'today' : ''} ${same(dd, sel) ? 'sel' : ''}" data-day="${dd.toISOString()}" style="${inM ? '' : 'opacity:.35'}">${dd.getDate()}${on(dd).length ? '<i class="ev"></i>' : ''}</div>`;
        d.setDate(d.getDate() + 1);
      }
      html += `</div></div><div class="card"><h3>${sel.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}</h3>${on(sel).map(item).join('') || '<div class="muted small">Nothing scheduled.</div>'}</div>`;
    } else if (mode === 'week') {
      html += '<div class="gap">'; const d = new Date(from);
      for (let i = 0; i < 7; i++) { html += `<div class="card"><h3>${d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}${same(d, new Date()) ? ' · Today' : ''}</h3>${on(d).map(item).join('') || '<div class="muted small">—</div>'}</div>`; d.setDate(d.getDate() + 1); }
      html += '</div>';
    } else html += `<div class="card">${on(cur).map(item).join('') || '<div class="empty"><div class="big">🌤️</div>Free day. Add an event with +</div>'}</div>`;
    view.innerHTML = `<div class="gap fade">${html}</div><button class="fab" aria-label="Add event">+</button>`;
    $$('[data-nav]', view).forEach(b => b.onclick = () => { const n = +b.dataset.nav; if (mode === 'month') cur.setMonth(cur.getMonth() + n); else cur.setDate(cur.getDate() + n * (mode === 'week' ? 7 : 1)); sel = new Date(cur); draw(); });
    $$('[data-mode]', view).forEach(b => b.onclick = () => { mode = b.dataset.mode; draw(); });
    $('[data-today]', view).onclick = () => { cur = new Date(); cur.setHours(0, 0, 0, 0); sel = new Date(cur); draw(); };
    $$('[data-day]', view).forEach(b => b.onclick = () => { sel = new Date(b.dataset.day); draw(); });
    $('.fab', view).onclick = () => { const d = new Date(sel); d.setHours(10, 0, 0, 0); KF.actions.newEvent(localISO(d)); };
  }
  await draw();
};

/* ---------- SHOPPING ---------- */
KF.views.shopping = async view => {
  const lists = await api('/shopping');
  const shopRoom = KF.state.rooms.find(r => r.type === 'shopping');
  view.innerHTML = `<div class="gap fade">${shopRoom ? `<a class="btn ghost block" style="text-align:center;text-decoration:none" href="#/room/${shopRoom.id}">💬 Shopping chat</a>` : ''}
    ${lists.length ? lists.map(l => { const est = l.items.reduce((a, i) => a + (i.price || 0) * (i.qty || 1), 0); return `<div class="card"><div class="row"><h3 class="grow" style="margin:0">${esc(l.name)}</h3><span class="small muted">${l.items.filter(i => i.status === 'bought').length}/${l.items.length} bought${est ? ' · ~' + money(est) : ''}</span><button class="icon-btn" data-ldel="${l.id}" aria-label="Delete list">🗑</button></div>
      <div class="list">${l.items.map(i => `<label class="row" style="margin:0;color:inherit;font-size:1rem"><input type="checkbox" style="width:22px;height:22px" data-item="${i.id}" ${i.status === 'bought' ? 'checked' : ''}><span class="grow" style="${i.status === 'bought' ? 'text-decoration:line-through;opacity:.55' : ''}">${esc(i.name)} <span class="muted small">×${i.qty}${i.price ? ' · ' + money(i.price) : ''}</span>${i.link ? ` <a href="${esc(i.link)}" target="_blank" rel="noopener noreferrer" class="small">link</a>` : ''}<div class="small muted">${i.assigneeId ? '👤 ' + esc(member(i.assigneeId)?.name.split(' ')[0] || '') : ''}</div></span><button class="icon-btn" data-idel="${i.id}" aria-label="Remove item">✕</button></label>`).join('') || '<div class="muted small">No items yet.</div>'}</div>
      <button class="btn small ghost" data-add="${l.id}" style="margin-top:8px">+ Add item</button></div>`; }).join('') : '<div class="empty"><div class="big">🛒</div>No shopping lists yet.</div>'}</div><button class="fab" aria-label="New list">+</button>`;
  $('.fab', view).onclick = async () => { const v = await formSheet('New shopping list', [{ name: 'name', label: 'List name', required: true, placeholder: 'Weekend groceries' }], 'Create'); if (v) try { await api('/shopping', { method: 'POST', body: v }); route(); } catch (e) { toast(e.message); } };
  $$('[data-add]', view).forEach(b => b.onclick = async () => {
    const v = await formSheet('Add item', [{ name: 'name', label: 'Product', required: true }, { name: 'qty', label: 'Quantity', type: 'number', value: 1 }, { name: 'price', label: 'Estimated price (each)', type: 'number', step: '0.01' }, { name: 'assigneeId', label: 'Who will buy it', type: 'select', options: [{ value: '', label: 'Anyone' }, ...memberOptions()] }, { name: 'link', label: 'Product link (optional)', type: 'url' }], 'Add');
    if (v) try { await api(`/shopping/${b.dataset.add}/items`, { method: 'POST', body: v }); route(); } catch (e) { toast(e.message); }
  });
  $$('[data-item]', view).forEach(c => c.onchange = async () => { try { await api('/shopping/items/' + c.dataset.item, { method: 'PATCH', body: { status: c.checked ? 'bought' : 'pending' } }); route(); } catch (e) { toast(e.message); } });
  $$('[data-idel]', view).forEach(b => b.onclick = async e => { e.preventDefault(); try { await api('/shopping/items/' + b.dataset.idel, { method: 'DELETE' }); route(); } catch (x) { toast(x.message); } });
  $$('[data-ldel]', view).forEach(b => b.onclick = async () => { if (await confirmSheet('Delete this list?', 'Delete', true)) try { await api('/shopping/' + b.dataset.ldel, { method: 'DELETE' }); route(); } catch (e) { toast(e.message); } });
};

/* ---------- EXPENSES ---------- */
KF.actions.newExpense = async () => {
  if (!can('expenses')) return toast('Expenses are private. Ask the clan leader for access.');
  const v = await formSheet('Add clan expense', [{ name: 'title', label: 'What was it for?', required: true }, { name: 'amount', label: 'Amount', type: 'number', step: '0.01', required: true }, { name: 'date', label: 'Date', type: 'date', value: localISO().slice(0, 10), required: true }, { name: 'category', label: 'Category', type: 'select', options: EXP_CATS }, { name: 'paidBy', label: 'Paid by', type: 'select', options: memberOptions(), value: KF.state.me.id }], 'Next: split');
  if (!v) return;
  const split = await new Promise(res => sheet(`<h2>Split between</h2><div class="gap">${KF.state.members.map(m => `<label class="row" style="margin:0;color:inherit;font-size:1rem"><input type="checkbox" style="width:22px;height:22px" value="${m.id}" checked>${esc(m.name)}</label>`).join('')}</div><div class="row" style="margin-top:12px"><button class="btn ghost grow" data-n>Cancel</button><button class="btn gold grow" data-y>Save expense</button></div>`, (s, close) => {
    $('[data-n]', s).onclick = () => { close(); res(null); };
    $('[data-y]', s).onclick = () => { const ids = $$('input:checked', s).map(i => i.value); if (!ids.length) return toast('Select at least one person'); close(); res(ids); };
  }));
  if (!split) return;
  try { await api('/expenses', { method: 'POST', body: { ...v, amount: +v.amount, split } }); toast('Expense saved'); route(); } catch (e) { toast(e.message); }
};
KF.views.expenses = async view => {
  if (!can('expenses')) { view.innerHTML = '<div class="empty"><div class="big">🔒</div>Clan funds are private. Ask the clan leader to grant you access.</div>'; return; }
  let month = localISO().slice(0, 7);
  async function draw() {
    const d = await api('/expenses?month=' + month);
    const byCat = {}; d.items.forEach(e => byCat[e.category] = (byCat[e.category] || 0) + e.amount);
    view.innerHTML = `<div class="gap fade">
      <div class="row"><input type="month" value="${month}" data-m></div>
      <div class="card" style="background:linear-gradient(135deg,var(--blue),var(--blue-d));color:#fff;border:0"><div class="small" style="opacity:.8">Total this month</div><h2 style="color:var(--gold-l);font-size:2rem">${money(d.total)}</h2><div class="small">${d.items.length} expense${d.items.length === 1 ? '' : 's'}</div></div>
      ${Object.keys(byCat).length ? `<div class="card"><h3>By category</h3>${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div class="small row"><span class="grow">${esc(c)}</span><span>${money(v)}</span></div><div class="bar" style="margin:3px 0 8px"><i style="width:${Math.round(100 * v / d.total)}%"></i></div>`).join('')}</div>` : ''}
      <div class="card"><h3>Who owes whom</h3>${d.settlements.length ? d.settlements.map(s => `<div class="small" style="padding:4px 0"><b>${esc(member(s.from)?.name || '?')}</b> owes <b>${esc(member(s.to)?.name || '?')}</b> ${money(s.amount)}</div>`).join('') : '<div class="muted small">All settled up ✨</div>'}<div class="small muted" style="margin-top:6px">This only tracks shares. No payments are made by the app.</div></div>
      <div class="card"><h3>History</h3>${d.items.length ? `<div class="list">${d.items.map(e => `<div class="row"><div class="grow"><b>${esc(e.title)}</b><div class="small muted">${fmtDate(e.date)} · ${esc(e.category)} · paid by ${esc(member(e.paidBy)?.name.split(' ')[0] || '?')} · split ${e.split.length}</div></div><b>${money(e.amount)}</b>${e.canDelete ? `<button class="icon-btn" data-del="${e.id}">🗑</button>` : ''}</div>`).join('')}</div>` : '<div class="empty"><div class="big">💸</div>No expenses this month.</div>'}</div></div><button class="fab" aria-label="Add expense">+</button>`;
    $('[data-m]', view).onchange = e => { month = e.target.value || month; draw(); };
    $('.fab', view).onclick = KF.actions.newExpense;
    $$('[data-del]', view).forEach(b => b.onclick = async () => { if (await confirmSheet('Delete this expense?', 'Delete', true)) try { await api('/expenses/' + b.dataset.del, { method: 'DELETE' }); draw(); } catch (e) { toast(e.message); } });
  }
  await draw();
};

/* ---------- MEMORIES ---------- */
KF.actions.uploadPhoto = async (albumId) => {
  const files = await pickFile('image/*,video/*', true); if (!files.length) return;
  const caption = files.length === 1 ? (await formSheet('Add caption', [{ name: 'caption', label: 'Caption (optional)' }], 'Upload'))?.caption : '';
  if (caption === undefined && files.length === 1) return;
  let ok = 0;
  for (const f of files) { toast(`Uploading ${ok + 1}/${files.length}…`); try { await uploadFile(f, 'memories', { caption: caption || '', albumId: albumId || '' }); ok++; } catch (e) { toast(e.message); break; } }
  if (ok) { toast(`${ok} uploaded`); route(); }
};
KF.views.memories = async (view, [albumId]) => {
  const d = await api('/albums' + (albumId ? '/' + albumId : ''));
  if (!albumId) {
    view.innerHTML = `<div class="gap fade"><div class="row"><button class="btn small gold" data-up>📷 Upload photos</button><button class="btn small ghost" data-newalbum>＋ Album</button><a class="btn small ghost" href="#/files" style="text-decoration:none">📁 Files</a></div>
      ${d.albums.length ? `<div class="grid2">${d.albums.map(a => `<a href="#/memories/${a.id}" class="card" style="text-decoration:none;color:inherit;padding:0;overflow:hidden"><div class="ph" style="height:110px;background:var(--line);display:flex;align-items:center;justify-content:center;font-size:2.4rem">${a.coverId ? `<img src="/api/files/${a.coverId}/thumb" style="width:100%;height:110px;object-fit:cover" alt="">` : '🖼️'}</div><div style="padding:10px"><b>${esc(a.name)}</b><div class="small muted">${a.count} item${a.count === 1 ? '' : 's'}</div></div></a>`).join('')}</div>` : ''}
      <h3>All memories</h3>${galleryHTML(d.photos)}</div>`;
    $('[data-newalbum]', view).onclick = async () => { const v = await formSheet('New album', [{ name: 'name', label: 'Album name', required: true, placeholder: 'Goa 2026, Diwali…' }, { name: 'description', label: 'Description' }], 'Create'); if (v) try { await api('/albums', { method: 'POST', body: v }); route(); } catch (e) { toast(e.message); } };
  } else {
    KF.setTitle(d.album.name, { back: '#/memories' });
    view.innerHTML = `<div class="gap fade"><div class="row"><button class="btn small gold" data-up>📷 Add to album</button>${d.canEdit ? '<button class="btn small danger" data-adel>Delete album</button>' : ''}</div><p class="muted small">${esc(d.album.description || '')}</p>${galleryHTML(d.photos)}</div>`;
    const ad = $('[data-adel]', view); if (ad) ad.onclick = async () => { if (await confirmSheet('Delete this album? Photos stay in Drive but leave the album.', 'Delete', true)) try { await api('/albums/' + albumId, { method: 'DELETE' }); location.hash = '#/memories'; } catch (e) { toast(e.message); } };
  }
  $('[data-up]', view).onclick = () => KF.actions.uploadPhoto(albumId);
  $$('[data-ph]', view).forEach(p => p.onclick = () => { const f = d.photos.find(x => x.id === p.dataset.ph); previewFile(f); });
};
const galleryHTML = ph => ph.length ? `<div class="gallery">${ph.map(p => `<div class="ph" data-ph="${p.id}">${p.mime.startsWith('video/') ? '🎬' : `<img loading="lazy" src="/api/files/${p.id}/thumb" alt="${esc(p.caption || p.name)}">`}</div>`).join('')}</div>` : '<div class="empty"><div class="big">📷</div>No photos yet. Upload your first memory.</div>';
function previewFile(f) {
  sheet(`<div class="center">${f.mime.startsWith('video/') ? `<video controls style="max-width:100%;border-radius:12px" src="/api/files/${f.id}/content"></video>` : f.mime.startsWith('image/') ? `<img style="max-width:100%;border-radius:12px" src="/api/files/${f.id}/content" alt="${esc(f.name)}">` : `<div style="font-size:3rem">📄</div>`}
    <h3 style="margin-top:10px">${esc(f.caption || f.name)}</h3><div class="small muted">${esc(f.name)} · ${fmtSize(f.size)} · ${fmtDate(f.createdAt)} · by ${esc(member(f.uploadedBy)?.name || 'a former member')}</div>
    <div class="row" style="margin-top:12px"><a class="btn grow" href="/api/files/${f.id}/content?download=1" download="${esc(f.name)}" style="text-decoration:none;text-align:center">Download</a>${f.canDelete ? '<button class="btn danger grow" data-del>Delete</button>' : ''}</div></div>`, (s, close) => {
    const d = $('[data-del]', s); if (d) d.onclick = async () => { if (await confirmSheet('Delete this file from Google Drive?', 'Delete', true)) try { await api('/files/' + f.id, { method: 'DELETE' }); close(); route(); } catch (e) { toast(e.message); } };
  });
}
KF.previewFile = previewFile;
