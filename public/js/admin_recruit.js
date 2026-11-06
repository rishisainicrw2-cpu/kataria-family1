/* ---------- PLAYER RECRUITMENT (admin review) ---------- */
const RECRUIT_STATUSES = [
  ['pending', 'Pending'], ['under_review', 'Under Review'], ['trial_invited', 'Trial Invited'], ['approved', 'Approved'], ['rejected', 'Rejected'],
];
const RECRUIT_STATUS_COLOR = { pending: '', under_review: '', trial_invited: 'gold', approved: 'completed', rejected: 'cancelled' };

KF.views.recruitment = async view => {
  if (!can('recruitment')) { view.innerHTML = '<div class="empty"><div class="big">🔒</div>You do not have permission to review player applications.</div>'; return; }
  const state = KF.state.recruitFilter || (KF.state.recruitFilter = { status: '', q: '' });
  const r = await api('/recruitment/applications' + qstr({ status: state.status, q: state.q }));
  const c = r.counts || {};
  view.innerHTML = `<div class="gap fade">
    <div class="grid2" style="grid-template-columns:repeat(5,1fr);gap:8px">
      ${[['Total', c.total], ['Pending', c.pending], ['Review', c.underReview], ['Trial', c.trialInvited], ['Approved', c.approved]].map(([l, n]) => `<div class="card center" style="padding:10px 4px"><div style="font-size:1.3rem;font-weight:800">${n || 0}</div><div class="small muted">${l}</div></div>`).join('')}
    </div>
    <div class="card">
      <input type="text" data-search placeholder="Search by IGN, BGMI UID or Application ID" value="${esc(state.q)}" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--chat-bg);color:var(--text)">
      <div class="chips" style="margin-top:10px">
        <button class="chip ${!state.status ? 'on' : ''}" data-status="">All</button>
        ${RECRUIT_STATUSES.map(([k, l]) => `<button class="chip ${state.status === k ? 'on' : ''}" data-status="${k}">${l}</button>`).join('')}
      </div>
    </div>
    ${r.applications.length ? `<div class="card list">${r.applications.map(a => `<a href="#" data-open="${a.id}" class="row" style="text-decoration:none;color:inherit;padding:12px 0">
        <span class="avatar sm" style="border-radius:12px">🎮</span>
        <span class="grow"><b>${esc(a.fullName)}</b> <span class="small muted">· ${esc(a.ign)}</span><div class="small muted">${esc(a.role)} · ${esc(a.preferredTeamLabel)} · ${fmtDate(a.submittedAt)}</div></span>
        <span class="pill ${RECRUIT_STATUS_COLOR[a.status]}">${esc(a.statusLabel)}</span></a>`).join('')}</div>`
      : '<div class="empty"><div class="big">🎮</div>No applications match this filter.</div>'}
    <p class="small muted">Share <b>${esc(location.origin)}/recruit</b> to collect new applications.</p>
  </div>`;
  $('[data-search]', view).addEventListener('change', e => { state.q = e.target.value.trim(); route(); });
  $$('[data-status]', view).forEach(b => b.onclick = () => { state.status = b.dataset.status; route(); });
  $$('[data-open]', view).forEach(a => a.onclick = e => { e.preventDefault(); openApplication(a.dataset.open); });
};

function qstr(obj) {
  const p = new URLSearchParams(); for (const k in obj) if (obj[k]) p.set(k, obj[k]);
  const s = p.toString(); return s ? '?' + s : '';
}

async function openApplication(id) {
  const a = await api('/recruitment/applications/' + id);
  const row = (l, v) => v ? `<div class="statusrow" style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:.92rem"><span class="muted">${esc(l)}</span><b style="text-align:right">${esc(v)}</b></div>` : '';
  const close = sheet(`<h2>${esc(a.fullName)}</h2><div class="small muted" style="margin-bottom:10px">Application ${esc(a.code)} · submitted ${fmtDate(a.submittedAt)}</div>
    <div style="margin-bottom:14px">
      ${row('IGN', a.ign)}${row('BGMI UID', a.bgmiUid)}${row('Age', a.age)}${row('Role', a.role)}
      ${row('Preferred team', a.preferredTeamLabel)}${row('Device', a.device)}${row('Available hours', a.hours)}
      ${row('Contact', a.contact)}${a.socialLink ? row('Social link', '') : ''}
      ${a.socialLink ? `<div class="small"><a href="${esc(a.socialLink)}" target="_blank" rel="noopener">${esc(a.socialLink)}</a></div>` : ''}
      ${a.experience ? `<div style="margin-top:10px"><div class="small muted">Experience</div><div class="small">${esc(a.experience)}</div></div>` : ''}
      ${a.previousTeam ? `<div style="margin-top:10px"><div class="small muted">Previous team</div><div class="small">${esc(a.previousTeam)}</div></div>` : ''}
    </div>
    <label>Status</label>
    <select data-status>${RECRUIT_STATUSES.map(([k, l]) => `<option value="${k}" ${a.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label>Private admin notes</label>
    <textarea data-notes rows="3" placeholder="Visible only to admins">${esc(a.adminNotes)}</textarea>
    <div class="err small" style="color:var(--danger);min-height:1.2em" data-err></div>
    <div class="row" style="margin-top:10px"><button class="btn ghost grow" data-close>Close</button><button class="btn grow gold" data-save>Save</button></div>
    ${a.history && a.history.length ? `<div style="margin-top:16px"><div class="small muted" style="margin-bottom:6px">History</div>${a.history.map(h => `<div class="small muted">${fmtDate(h.createdAt)} — ${esc(h.fromStatus)} → ${esc(h.toStatus)}${h.note ? ': ' + esc(h.note) : ''}</div>`).join('')}</div>` : ''}`,
    (el, closeFn) => {
      $('[data-close]', el).onclick = () => closeFn();
      $('[data-save]', el).onclick = async () => {
        try {
          await api('/recruitment/applications/' + id, { method: 'PATCH', body: { status: $('[data-status]', el).value, adminNotes: $('[data-notes]', el).value } });
          closeFn(); toast('Application updated'); route();
        } catch (e) { $('[data-err]', el).textContent = e.message; }
      };
    });
}
