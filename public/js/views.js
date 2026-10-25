/* Welcome, login, registration, create/join clan, and the Home dashboard */
const authEl = () => $('#auth');
const brand = '<img class="logo" src="/assets/icon-512.png" alt="Hindu Esports"><h1 class="sr">HINDU ESPORTS</h1><div class="tag">Together as One ✦</div>';

KF.showAuth = (mode = 'welcome', note = '') => {
  $('#boot').classList.add('hidden'); $('#app').classList.add('hidden');
  const el = authEl(); el.classList.remove('hidden');
  const params = new URLSearchParams(location.search);
  const inviteCode = params.get('invite') || sessionStorage.getItem('kf_invite') || '';
  if (params.get('invite')) sessionStorage.setItem('kf_invite', inviteCode);
  if (mode === 'welcome') {
    el.innerHTML = `${brand}<div class="panel gap">
      <p class="center" style="margin:0;color:#ffd9bf">A private space for your clan to chat, plan matches and share highlights.</p>
      ${KF.isInstalled() ? '' : '<button class="btn install block" data-install>📲 Install app</button>'}
      <button class="btn gold block" data-m="register">Create account</button>
      <button class="btn ghost block" style="color:#fff;border-color:rgba(255,255,255,.3)" data-m="login">I already have an account</button>
      ${inviteCode ? `<p class="small center" style="color:var(--gold-l);margin:0">You were invited with code <b>${esc(inviteCode)}</b>. Register or log in to join.</p>` : ''}</div>`;
    $$('[data-m]', el).forEach(b => b.onclick = () => KF.showAuth(b.dataset.m));
    const ib = $('[data-install]', el); if (ib) ib.onclick = () => KF.installApp();
  } else if (mode === 'login' || mode === 'register') {
    const reg = mode === 'register';
    el.innerHTML = `${brand}<form class="panel" novalidate>
      ${reg ? '<label>Your name</label><input name="name" autocomplete="name" required maxlength="60">' : ''}
      ${reg ? '<label>BGMI UID <span style="opacity:.7">(optional)</span></label><input name="bgmiUid" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="e.g. 5123456789"><label>Free Fire ID <span style="opacity:.7">(optional)</span></label><input name="ffUid" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="e.g. 1234567890">' : ''}
      <label>Email</label><input name="email" type="email" autocomplete="email" required>
      <label>Password ${reg ? '(min 8 characters)' : ''}</label><input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="8">
      <div class="err" role="alert">${esc(note)}</div>
      <button class="btn gold block" style="margin-top:10px">${reg ? 'Create account' : 'Log in'}</button>
      <p class="center small" style="margin:14px 0 0">
        ${reg ? 'Have an account? <a href="#" data-m="login">Log in</a>' : '<a href="#" data-m="reset">Forgot password?</a> · <a href="#" data-m="register">Create account</a>'}
        · <a href="#" data-m="welcome">Back</a></p></form>`;
    $$('[data-m]', el).forEach(b => b.onclick = e => { e.preventDefault(); KF.showAuth(b.dataset.m); });
    const form = $('form', el);
    form.onsubmit = async e => {
      e.preventDefault();
      const btn = $('button.btn', form), err = $('.err', form);
      const body = Object.fromEntries(new FormData(form));
      if (!body.email || !body.password || (reg && !body.name)) { err.textContent = 'Please fill in every field.'; return; }
      if (reg && body.password.length < 8) { err.textContent = 'Password must be at least 8 characters.'; return; }
      btn.disabled = true; err.textContent = '';
      try { await api(reg ? '/auth/register' : '/auth/login', { method: 'POST', body }); await KF.boot(); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    };
  } else if (mode === 'reset') {
    el.innerHTML = `${brand}<form class="panel" novalidate>
      <p class="small" style="margin-top:0;color:#ffd9bf">Enter your email. If your clan leader runs the server, they will receive a one-time reset code you can ask them for (no email service is required).</p>
      <label>Email</label><input name="email" type="email" required>
      <div class="err"></div>
      <button class="btn gold block" style="margin-top:8px">Request reset code</button>
      <div data-step2 class="hidden"><label>Reset code</label><input name="token" autocomplete="off"><label>New password</label><input name="password" type="password" minlength="8" autocomplete="new-password">
      <button class="btn gold block" data-do style="margin-top:10px" type="button">Set new password</button></div>
      <p class="center small"><a href="#" data-m="login">Back to login</a></p></form>`;
    $('[data-m]', el).onclick = e => { e.preventDefault(); KF.showAuth('login'); };
    const form = $('form', el), err = $('.err', form);
    form.onsubmit = async e => {
      e.preventDefault();
      try { await api('/auth/reset-request', { method: 'POST', body: { email: form.email.value } }); err.style.color = '#b6f2d2'; err.textContent = 'If that account exists, a reset code was created. Get it from your clan leader (server console), then enter it below.'; $('[data-step2]', form).classList.remove('hidden'); }
      catch (ex) { err.textContent = ex.message; }
    };
    $('[data-do]', form).onclick = async () => {
      try { await api('/auth/reset', { method: 'POST', body: { email: form.email.value, token: form.token.value.trim(), password: form.password.value } }); KF.showAuth('login', 'Password updated. Please log in.'); }
      catch (ex) { err.style.color = '#ffb3bd'; err.textContent = ex.message; }
    };
  } else if (mode === 'family') {
    const code = inviteCode;
    el.innerHTML = `${brand}<div class="panel gap">
      <h2 style="color:#fff">Welcome, ${esc(KF.state.me.name.split(' ')[0])}</h2>
      <form data-join><label>Join with an invitation code</label><input name="code" value="${esc(code)}" placeholder="e.g. K7M2-QX9P" autocapitalize="characters" required>
        <button class="btn gold block" style="margin-top:8px">Join clan</button></form>
      ${KF.state.canCreateClan ? `      <div class="center small">— or —</div>
      <form data-create><label>Create a new clan space</label><input name="name" placeholder="e.g. Hindu Esports" maxlength="60" required>
        <button class="btn block" style="margin-top:8px;background:var(--blue)">Create clan</button></form>
` : ''}
      <div class="err"></div>
      <p class="center small"><a href="#" data-out>Log out</a></p></div>`;
    const err = $('.err', el);
    $('[data-join]', el).onsubmit = async e => { e.preventDefault(); err.textContent = '';
      try { await api('/family/join', { method: 'POST', body: { code: e.target.code.value } }); sessionStorage.removeItem('kf_invite'); history.replaceState(null, '', '/'); await KF.boot(); } catch (ex) { err.textContent = ex.message; } };
    if ($('[data-create]', el)) $('[data-create]', el).onsubmit = async e => { e.preventDefault(); err.textContent = '';
      try { await api('/family', { method: 'POST', body: { name: e.target.name.value } }); await KF.boot(); } catch (ex) { err.textContent = ex.message; } };
    $('[data-out]', el).onclick = async e => { e.preventDefault(); await KF.logout(); };
  }
};

KF.logout = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch (_) {} KF.state.me = null; KF.ws && KF.ws.close(); KF.showAuth('welcome'); };

/* HOME DASHBOARD */
KF.views.home = async (view) => {
  const [d, ann] = await Promise.all([api('/dashboard'), Promise.resolve(null)]);
  const f = KF.state.family, me = KF.state.me;
  const hr = new Date().getHours(), greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  const quick = [['chat', 'Start a Chat', '#/chats'], ['plans', 'Match Plan', 'plan:new'], ['cal', 'Add Event', 'event:new'],
    ['photo', 'Upload Photo', 'photo:new'], ['cart', 'Gear List', '#/shopping'], ['money', 'Add Expense', 'expense:new']];
  const pushOffer = 'Notification' in window && 'serviceWorker' in navigator && Notification.permission === 'default' ? `<div class="card row" style="gap:12px"><div class="grow"><b>Get phone alerts</b><div class="small muted">Know when your clan messages you, even when the app is closed.</div></div><button class="btn small gold" data-pushon>Turn on</button></div>` : '';
  view.innerHTML = `<div class="gap fade">
    <div class="card" style="background:linear-gradient(135deg,var(--blue),var(--blue-d) 60%,var(--ink));color:#fff;border:0">
      <div class="row"><img src="/assets/icon-192.png" width="56" height="56" style="border-radius:14px" alt="">
        <div class="grow"><div style="opacity:.8;font-size:.85rem">${greet}, ${esc(me.name.split(' ')[0])} ✦</div>
        <h2 style="color:#fff">${esc(f.name)}</h2><div class="small" style="color:var(--gold-l)">Together as One ✦</div></div></div></div>
    ${pushOffer}
    ${d.announcements.length ? `<div class="card" style="border-color:var(--gold)"><h3>📢 Announcements</h3>${d.announcements.map(a => `<div class="small" style="padding:4px 0"><b>${esc(a.title)}</b><div class="muted">${esc(a.body)}</div></div>`).join('')}</div>` : ''}
    <div class="grid2" style="grid-template-columns:repeat(3,1fr)">${quick.map(q => `<button class="quick" data-q="${q[2]}"><span class="q">${icon(q[0])}</span>${q[1]}</button>`).join('')}</div>
    <div class="card"><h3>Online now</h3>${d.online.length ? `<div class="row wrap">${d.online.map(u => `<div class="center small" style="width:62px">${avatar(u)}<div class="small" style="margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.name.split(' ')[0])}</div></div>`).join('')}</div>` : '<div class="muted small">No one else is online right now.</div>'}</div>
    <div class="card"><h3>Recent messages</h3>${d.messages.length ? `<div class="list">${d.messages.map(m => `<a href="#/room/${m.roomId}" style="text-decoration:none;color:inherit;display:flex;gap:10px">${avatar(member(m.userId), 'sm')}<div class="grow"><div class="small muted">${esc(m.roomName)} · ${fmtDT(m.createdAt)}</div><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>${esc(member(m.userId)?.name.split(' ')[0] || '')}:</b> ${esc(m.text || '📎 attachment')}</div></div></a>`).join('')}</div>` : '<div class="empty"><div class="big">💬</div>No messages yet. Say hello to your clan!</div>'}</div>
    <div class="card"><h3>Upcoming events &amp; plans</h3>${d.upcoming.length ? `<div class="list">${d.upcoming.map(u => `<a href="#/${u.kind === 'plan' ? 'plan' : 'events'}/${u.id}" style="text-decoration:none;color:inherit;display:flex;justify-content:space-between;gap:8px"><div><b>${esc(u.title)}</b><div class="small muted">${fmtDT(u.startsAt)}${u.location ? ' · ' + esc(u.location) : ''}</div></div><span class="pill ${u.kind === 'plan' ? 'gold' : ''}">${u.kind}</span></a>`).join('')}</div>` : '<div class="empty"><div class="big">📅</div>Nothing scheduled. Add an event or plan.</div>'}</div>
    <div class="card"><h3>My pending tasks</h3>${d.tasks.length ? `<div class="list">${d.tasks.map(t => `<div class="row"><span class="grow">${esc(t.title)}<div class="small muted">${esc(t.planTitle || '')}${t.dueAt ? ' · due ' + fmtDate(t.dueAt) : ''}</div></span></div>`).join('')}</div>` : '<div class="muted small">You have no pending tasks 🎉</div>'}</div>
    <div class="card"><div class="row"><h3 class="grow" style="margin:0">Recent highlights</h3><a href="#/memories" class="small">See all</a></div>
      ${d.photos.length ? `<div class="gallery" style="margin-top:10px">${d.photos.map(p => `<div class="ph" onclick="location.hash='#/memories'"><img loading="lazy" src="/api/files/${p.id}/thumb" alt="${esc(p.name)}"></div>`).join('')}</div>` : '<div class="empty"><div class="big">📷</div>Upload your first clan highlight.</div>'}</div>
  </div>`;
  const pb = $('[data-pushon]', view); if (pb) pb.onclick = async () => { try { const r = await Notification.requestPermission(); if (r === 'granted') { await KF.setupPush(); toast('Phone alerts are on 🔔'); } else toast('Alerts not allowed. You can change this in your phone settings.', 5000); } catch (e) { toast('This phone or browser cannot show alerts here.'); } route(); };
  $$('[data-q]', view).forEach(b => b.onclick = () => {
    const q = b.dataset.q;
    if (q.startsWith('#')) location.hash = q;
    else if (q === 'plan:new') KF.actions.newPlan(); else if (q === 'event:new') KF.actions.newEvent();
    else if (q === 'photo:new') KF.actions.uploadPhoto(); else if (q === 'expense:new') KF.actions.newExpense();
  });
};
