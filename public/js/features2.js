/* Members, invitations, notifications, profile, settings, family settings, Drive, files, search, privacy, help */
const ROLE_LABEL = { owner: 'Family Owner', admin: 'Administrator', member: 'Family Member' };
const SECTIONS = [['general', 'General chat'], ['daily', 'Daily discussion'], ['events', 'Events chat'], ['planning', 'Planning chat'], ['shopping', 'Shopping chat']];
const link = (href, ic, label, sub = '') => `<a href="${href}" class="row" style="text-decoration:none;color:inherit;padding:12px 0"><span class="avatar sm" style="border-radius:12px">${icon(ic, 'width="18" height="18"')}</span><span class="grow"><b>${label}</b>${sub ? `<div class="small muted">${sub}</div>` : ''}</span><span class="muted">›</span></a>`;

/* ---------- PROFILE (hub for everything else) ---------- */
KF.views.profile = async view => {
  const me = KF.state.me, f = KF.state.family, admin = me.role !== 'member';
  view.innerHTML = `<div class="gap fade">
    <div class="card center">${avatar(me, '')}<h2 style="margin-top:8px">${esc(me.name)}</h2><div class="small muted">${esc(me.email)}</div><div style="margin-top:6px"><span class="pill gold">${ROLE_LABEL[me.role]}</span> <span class="pill">${esc(f.name)}</span></div>
      <div class="row" style="justify-content:center;margin-top:12px"><button class="btn small ghost" data-name>Edit name</button><button class="btn small ghost" data-photo>Change photo</button></div></div>
    <div class="card list">
      ${link('#/shopping', 'cart', 'Shopping lists')}${link('#/expenses', 'money', 'Family expenses', 'Private')}${link('#/memories', 'photo', 'Memories & albums')}${link('#/polls', 'poll', 'Polls & voting')}${link('#/events', 'cal', 'Family events')}${link('#/files', 'folder', 'File manager', 'Files stored in Google Drive')}</div>
    <div class="card list">
      ${link('#/members', 'users', 'Family members', `${KF.state.members.length} in ${esc(f.name)}`)}${admin ? link('#/invitations', 'invite', 'Invitations') : ''}${admin ? link('#/family', 'home', 'Family settings') : ''}${me.role === 'owner' ? link('#/drive', 'drive', 'Google Drive connection') : ''}</div>
    <div class="card list">${link('#/settings', 'gear', 'App settings', 'Theme, notifications')}${link('#/privacy', 'lock', 'Privacy & security')}${link('#/help', 'help', 'Help & support')}</div>
    <button class="btn ghost block" data-out>Log out</button>
    <div class="center small muted">KATARIA FAMILY · Together as One ✦</div></div>`;
  $('[data-name]', view).onclick = async () => { const v = await formSheet('Your name', [{ name: 'name', label: 'Display name', value: me.name, required: true }]); if (v) try { const u = await api('/me', { method: 'PATCH', body: v }); Object.assign(KF.state.me, u); await KF.refreshFamily(); route(); } catch (e) { toast(e.message); } };
  $('[data-photo]', view).onclick = async () => { const [file] = await pickFile('image/*'); if (!file) return; const fd = new FormData(); fd.append('file', file); try { const u = await api('/me/photo', { method: 'POST', body: fd }); Object.assign(KF.state.me, u); await KF.refreshFamily(); route(); } catch (e) { toast(e.message); } };
  $('[data-out]', view).onclick = () => KF.logout();
};

/* ---------- MEMBERS ---------- */
KF.views.members = async view => {
  const me = KF.state.me, owner = me.role === 'owner';
  const ms = KF.state.members;
  view.innerHTML = `<div class="gap fade"><div class="card"><div class="list">${ms.map(m => `<div class="row">${avatar(m)}<div class="grow"><b>${esc(m.name)}</b>${m.id === me.id ? ' <span class="small muted">(you)</span>' : ''}<div class="small muted">${ROLE_LABEL[m.role]} · joined ${fmtDate(m.joinedAt)}${KF.state.online.has(m.id) ? ' · 🟢 online' : ''}</div></div>
      ${m.id !== me.id ? `<button class="btn small ghost" data-dm="${m.id}">Chat</button>` : ''}
      ${(owner || (me.role === 'admin' && m.role === 'member')) && m.id !== me.id ? `<button class="icon-btn" data-man="${m.id}">${icon('more')}</button>` : ''}</div>`).join('')}</div></div>
    ${me.role !== 'member' ? '<a class="btn gold block" href="#/invitations" style="text-align:center;text-decoration:none">Invite someone</a>' : ''}
    ${owner ? '' : '<button class="btn ghost block danger" data-leave style="color:var(--danger)">Leave this family</button>'}</div>`;
  $$('[data-dm]', view).forEach(b => b.onclick = async () => { try { const r = await api('/dms', { method: 'POST', body: { userId: b.dataset.dm } }); location.hash = '#/room/' + r.id; } catch (e) { toast(e.message); } });
  $$('[data-man]', view).forEach(b => b.onclick = () => {
    const m = ms.find(x => x.id === b.dataset.man); const p = m.perms || {};
    sheet(`<h2>${esc(m.name)}</h2><div class="gap">
      ${owner ? `<label>Role</label><select data-role><option value="member" ${m.role === 'member' ? 'selected' : ''}>Family Member</option><option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Administrator</option></select>` : ''}
      <label>Permissions</label>
      ${[['plans', 'Create plans'], ['events', 'Add events'], ['expenses', 'View & add expenses'], ['plans_manage', 'Manage any plan'], ['invite', 'Create invitations']].map(([k, l]) => `<label class="row" style="margin:0;color:inherit;font-size:1rem"><input type="checkbox" style="width:22px;height:22px" data-p="${k}" ${p[k] ? 'checked' : ''}>${l}</label>`).join('')}
      <button class="btn gold" data-save>Save</button><button class="btn danger" data-rm>Remove from family</button></div>`, (s, close) => {
      $('[data-save]', s).onclick = async () => { const perms = {}; $$('[data-p]', s).forEach(c => perms[c.dataset.p] = c.checked); try { await api('/members/' + m.id, { method: 'PATCH', body: { perms, role: owner ? $('[data-role]', s).value : undefined } }); close(); await KF.refreshFamily(); route(); } catch (e) { toast(e.message); } };
      $('[data-rm]', s).onclick = async () => { close(); if (await confirmSheet(`Remove ${m.name} from the family?`, 'Remove', true)) try { await api('/members/' + m.id, { method: 'DELETE' }); await KF.refreshFamily(); route(); } catch (e) { toast(e.message); } };
    });
  });
  const lv = $('[data-leave]', view); if (lv) lv.onclick = async () => { if (await confirmSheet('Leave this family? You will lose access to its chats and files.', 'Leave', true)) try { await api('/family/leave', { method: 'POST' }); KF.boot(); location.hash = ''; } catch (e) { toast(e.message); } };
};

/* ---------- INVITATIONS ---------- */
KF.views.invitations = async view => {
  const inv = await api('/invites');
  const url = c => `${location.origin}/?invite=${encodeURIComponent(c)}`;
  view.innerHTML = `<div class="gap fade"><button class="btn gold block" data-new>Create invitation</button>
    ${inv.length ? inv.map(i => `<div class="card"><div class="row"><h2 class="grow" style="letter-spacing:2px">${esc(i.code)}</h2><span class="pill">${i.role}</span></div><div class="small muted">Used ${i.uses}/${i.maxUses} · expires ${fmtDate(i.expiresAt)}</div>
      <div class="row wrap" style="margin-top:8px"><button class="btn small" data-share="${i.code}">Share link</button><button class="btn small ghost" data-copy="${i.code}">Copy code</button><button class="btn small danger" data-rev="${i.id}">Revoke</button></div></div>`).join('') : '<div class="empty"><div class="big">✉️</div>No active invitations.</div>'}
    <p class="small muted">Invitation links only work for people who then register or log in. You can revoke a code at any time.</p></div>`;
  $('[data-new]', view).onclick = async () => {
    const v = await formSheet('New invitation', [{ name: 'role', label: 'Joins as', type: 'select', options: [{ value: 'member', label: 'Family Member' }, ...(KF.state.me.role === 'owner' ? [{ value: 'admin', label: 'Administrator' }] : [])] }, { name: 'maxUses', label: 'Maximum uses', type: 'number', value: 1 }, { name: 'days', label: 'Valid for (days)', type: 'number', value: 7 }], 'Create');
    if (v) try { await api('/invites', { method: 'POST', body: { role: v.role, maxUses: +v.maxUses, days: +v.days } }); route(); } catch (e) { toast(e.message); }
  };
  $$('[data-share]', view).forEach(b => b.onclick = async () => { const t = `Join our family on KATARIA FAMILY ✦ Together as One\n${url(b.dataset.share)}\nInvitation code: ${b.dataset.share}`; if (navigator.share) { try { await navigator.share({ title: 'KATARIA FAMILY invitation', text: t }); } catch (_) {} } else { navigator.clipboard?.writeText(t); toast('Invitation copied'); } });
  $$('[data-copy]', view).forEach(b => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.copy); toast('Code copied'); });
  $$('[data-rev]', view).forEach(b => b.onclick = async () => { try { await api('/invites/' + b.dataset.rev, { method: 'DELETE' }); route(); } catch (e) { toast(e.message); } });
};

/* ---------- NOTIFICATIONS ---------- */
KF.views.notifications = async view => {
  const list = await api('/notifications');
  await api('/notifications/read', { method: 'POST' }).catch(() => {}); KF.state.notifUnread = 0; $('[data-nb]')?.classList.add('hidden');
  view.innerHTML = `<div class="gap fade">${list.length ? `<div class="card list">${list.map(n => `<a href="${esc(n.url || '#/home')}" style="text-decoration:none;color:inherit;display:block;${n.read ? 'opacity:.6' : ''}"><b>${esc(n.title)}</b><div class="small">${esc(n.body || '')}</div><div class="small muted">${fmtDT(n.createdAt)}</div></a>`).join('')}</div>` : '<div class="empty"><div class="big">🔔</div>You are all caught up.</div>'}</div>`;
};

/* ---------- APP SETTINGS ---------- */
KF.views.settings = async view => {
  const me = KF.state.me, pr = me.prefs || {};
  const notifState = 'Notification' in window ? Notification.permission : 'unsupported';
  view.innerHTML = `<div class="gap fade">
    <div class="card"><h3>Appearance</h3><div class="chips">${[['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button class="chip ${(pr.theme || 'auto') === k ? 'on' : ''}" data-theme="${k}">${l}</button>`).join('')}</div></div>
    <div class="card"><h3>Notifications</h3>
      ${[['n_messages', 'New messages'], ['n_private', 'Private messages'], ['n_mentions', 'Replies & mentions'], ['n_plans', 'New plans'], ['n_events', 'Event changes'], ['n_reminders', 'Reminders'], ['n_polls', 'Poll results'], ['n_tasks', 'Assigned tasks'], ['n_announce', 'Announcements']].map(([k, l]) => `<label class="row" style="margin:0;padding:6px 0;color:inherit;font-size:1rem"><input type="checkbox" style="width:22px;height:22px" data-pref="${k}" ${pr[k] === false ? '' : 'checked'}><span class="grow">${l}</span></label>`).join('')}
      <p class="small muted">Mute single chats from inside each chat (🔔 button).</p>
      <button class="btn small ghost" data-push>${notifState === 'granted' ? 'Phone notifications enabled ✓' : notifState === 'denied' ? 'Blocked in browser settings' : 'Enable phone notifications'}</button>
      <p class="small muted">Push notifications need the server to have push keys configured (see the README). Without it you still get in-app alerts and unread badges.</p></div>
    <div class="card"><h3>Install on your phone</h3><p class="small">Open this site in Chrome, tap the ⋮ menu, then <b>Install app</b> / <b>Add to Home screen</b>.</p><button class="btn small gold" data-install>Install KATARIA FAMILY</button></div>
    <div class="card"><h3>Chat background</h3><div class="chips">${[['', 'Default'], ['#e8eefc', 'Sky'], ['#f7f0dc', 'Sand'], ['#0b1233', 'Midnight'], ['#101010', 'Black']].map(([c, l]) => `<button class="chip ${(pr.chatBg || '') === c ? 'on' : ''}" data-bg="${c}">${l}</button>`).join('')}</div></div></div>`;
  const savePref = async patch => { try { const u = await api('/me/prefs', { method: 'PATCH', body: patch }); KF.state.me.prefs = u.prefs; applyTheme(); applyChatBg(); } catch (e) { toast(e.message); } };
  $$('[data-theme]', view).forEach(b => b.onclick = async () => { localStorage.setItem('kf_theme', b.dataset.theme); await savePref({ theme: b.dataset.theme }); route(); });
  $$('[data-pref]', view).forEach(c => c.onchange = () => savePref({ [c.dataset.pref]: c.checked }));
  $$('[data-bg]', view).forEach(b => b.onclick = async () => { await savePref({ chatBg: b.dataset.bg }); route(); });
  $('[data-push]', view).onclick = async () => { if (!('Notification' in window)) return toast('Not supported in this browser'); const r = await Notification.requestPermission(); if (r === 'granted') { await KF.setupPush(); toast('Notifications enabled'); } route(); };
  $('[data-install]', view).onclick = async () => { if (KF.installEvt) { KF.installEvt.prompt(); } else toast('Use Chrome menu ⋮ → Install app / Add to Home screen'); };
};
function applyChatBg() { const bg = KF.state.me?.prefs?.chatBg; if (bg) document.documentElement.style.setProperty('--chat-bg', bg); else document.documentElement.style.removeProperty('--chat-bg'); }
KF.applyChatBg = applyChatBg;

/* ---------- FAMILY SETTINGS (owner/admin) ---------- */
KF.views.family = async view => {
  const f = KF.state.family, owner = KF.state.me.role === 'owner';
  if (KF.state.me.role === 'member') { view.innerHTML = '<div class="empty"><div class="big">🔒</div>Only the family owner or administrators can change family settings.</div>'; return; }
  const secs = f.sections || SECTIONS.map(s => s[0]);
  view.innerHTML = `<div class="gap fade">
    <div class="card"><h3>Family</h3><label>Family name</label><input data-name value="${esc(f.name)}" maxlength="60"><label>Currency symbol</label><input data-cur value="${esc(f.currency || '₹')}" maxlength="3">
      <label>Accent colour</label><div class="row">${['#1f46d6', '#0b7a75', '#7a2fd6', '#c2410c', '#be123c'].map(c => `<button class="chip ${f.accent === c || (!f.accent && c === '#1f46d6') ? 'on' : ''}" data-ac="${c}" style="background:${c};width:38px;height:38px;border-radius:50%;padding:0"></button>`).join('')}</div>
      <label>Family logo</label><div class="row"><button class="btn small ghost" data-logo>Upload logo</button><span class="small muted">The installed phone icon stays KATARIA FAMILY — it can only change by reinstalling a rebuilt app.</span></div>
      <button class="btn gold block" data-save style="margin-top:12px">Save</button></div>
    <div class="card"><h3>Chat sections</h3>${SECTIONS.map(([k, l]) => `<label class="row" style="margin:0;padding:6px 0;color:inherit;font-size:1rem"><input type="checkbox" style="width:22px;height:22px" data-sec="${k}" ${secs.includes(k) ? 'checked' : ''} ${k === 'general' ? 'disabled' : ''}>${l}</label>`).join('')}</div>
    <div class="card"><h3>Post an announcement</h3><label>Title</label><input data-at><label>Message</label><textarea data-ab rows="2"></textarea><button class="btn small block" data-ann style="margin-top:8px">Post to dashboard &amp; notify everyone</button></div>
    ${owner ? `<div class="card"><h3>Danger zone</h3><button class="btn danger block" data-delfam>Delete this family and all its data</button></div>` : ''}</div>`;
  let accent = f.accent;
  $$('[data-ac]', view).forEach(b => b.onclick = () => { accent = b.dataset.ac; $$('[data-ac]', view).forEach(x => x.classList.toggle('on', x === b)); });
  $('[data-save]', view).onclick = async () => { try { await api('/family', { method: 'PATCH', body: { name: $('[data-name]', view).value, currency: $('[data-cur]', view).value, accent, sections: ['general', ...$$('[data-sec]', view).filter(c => c.checked && c.dataset.sec !== 'general').map(c => c.dataset.sec)] } }); await KF.refreshFamily(); await KF.loadRooms(); toast('Saved'); route(); } catch (e) { toast(e.message); } };
  $('[data-logo]', view).onclick = async () => { const [file] = await pickFile('image/*'); if (!file) return; const fd = new FormData(); fd.append('file', file); try { await api('/family/logo', { method: 'POST', body: fd }); toast('Logo updated'); } catch (e) { toast(e.message); } };
  $('[data-ann]', view).onclick = async () => { const title = $('[data-at]', view).value.trim(); if (!title) return toast('Add a title'); try { await api('/announcements', { method: 'POST', body: { title, body: $('[data-ab]', view).value } }); toast('Posted'); $('[data-at]', view).value = ''; $('[data-ab]', view).value = ''; } catch (e) { toast(e.message); } };
  const df = $('[data-delfam]', view); if (df) df.onclick = async () => { const v = await formSheet('Delete family', [{ name: 'password', label: 'Enter your password to confirm', type: 'password', required: true }], 'Delete forever'); if (v) try { await api('/family', { method: 'DELETE', body: v }); location.hash = ''; KF.boot(); } catch (e) { toast(e.message); } };
};

/* ---------- GOOGLE DRIVE ---------- */
KF.views.drive = async view => {
  if (KF.state.me.role !== 'owner') { view.innerHTML = '<div class="empty"><div class="big">🔒</div>Only the family owner can manage the Google Drive connection.</div>'; return; }
  const s = await api('/drive/status');
  const bk = s.connected ? await api('/drive/backup').catch(() => null) : null;
  const q = new URLSearchParams(location.search);
  const backupCard = !bk ? '' : `<div class="card"><h3>Database backup</h3>
    <p class="small">Chats, plans and expenses are saved as an <b>encrypted</b> backup in your Drive folder. This protects your data on free hosts that erase their disk when they restart.</p>
    ${!bk.enabled ? '<p class="small" style="color:var(--danger)">Backups are switched off on this server.</p>' : !bk.thisFamilyHoldsBackups ? '<p class="small muted">Backups are kept in the Drive of the first family connected to this server.</p>' : `
      <p class="small">${bk.lastAt ? `Last backup: <b>${esc(fmtDT(bk.lastAt))}</b>${bk.lastSize ? ' · ' + fmtSize(bk.lastSize) : ''}` : 'No backup made yet.'}</p>
      ${bk.lastError ? `<p class="small" style="color:var(--danger)">Last error: ${esc(bk.lastError)}</p>` : ''}
      ${!bk.persistentSecret ? '<p class="small" style="color:var(--danger)"><b>SECRET_KEY is not set on the server.</b> Without it, backups cannot be restored after a restart. Add it in your host settings.</p>' : ''}
      ${!bk.restoreKeySet ? '<p class="small" style="color:var(--danger)"><b>Restore key not saved on your host yet.</b> Tap “Show restore key” and add it as <code>DRIVE_RESTORE_KEY</code> in your host’s environment settings, otherwise a restart can lose your data.</p>' : bk.restoreKeyCurrent ? '<p class="small" style="color:var(--ok)">Restore key is set on your host ✓</p>' : '<p class="small" style="color:var(--danger)">The restore key on your host is out of date (Drive was reconnected). Show the key again and update <code>DRIVE_RESTORE_KEY</code>.</p>'}
      <div class="row wrap" style="margin-top:10px"><button class="btn small gold" data-bk>Back up now</button><button class="btn small ghost" data-rk>Show restore key</button></div>`}</div>`;
  const pct = (u, l) => l ? Math.min(100, Math.round(u / l * 100)) : 0;
  const bar = (u, l) => `<div style="height:8px;border-radius:99px;background:rgba(127,127,127,.25);overflow:hidden;margin:6px 0"><div style="height:100%;width:${pct(u, l)}%;background:var(--gold,#e8b84a)"></div></div>`;
  const poolCard = !s.connected ? '' : `<div class="card"><h3>Combined storage</h3>
    ${s.pool ? `<p class="small"><b>${fmtSize(s.pool.used)}</b> used of <b>${s.pool.limit ? fmtSize(s.pool.limit) : 'unlimited'}</b> across ${s.pool.accounts} Google account${s.pool.accounts === 1 ? '' : 's'}</p>${bar(s.pool.used, s.pool.limit)}` : ''}
    <div class="small" style="margin-top:8px"><b>Main</b> · ${esc(s.account || 'account')} ${s.quota ? `<span class="muted">· ${fmtSize(s.quota.used)} / ${s.quota.limit ? fmtSize(s.quota.limit) : 'unlimited'}</span>` : ''}</div>
    ${(s.accounts || []).map(a => { const bad = a.status === 'expired' || !a.folderOk; return `<div class="row" style="justify-content:space-between;align-items:center;margin-top:8px;gap:8px"><div class="small" style="min-width:0;word-break:break-all"><b>${esc(a.account || 'Google account')}</b><br><span class="${bad ? '' : 'muted'}" style="${bad ? 'color:var(--danger)' : ''}">${a.status === 'expired' ? 'Expired — use “Add another Google account” to sign in with it again' : a.folderOk ? `${fmtSize(a.used)} / ${a.limit ? fmtSize(a.limit) : 'unlimited'}` : esc(a.message)}</span></div><button class="btn small danger" data-rmacct="${esc(a.id)}">Remove</button></div>`; }).join('')}
    <p class="small muted" style="margin-top:10px">New photos and files are saved to whichever account has the most free space, and the app shows them all as one library. Use only your own Google accounts, each one once.</p>
    <div class="row wrap" style="margin-top:10px"><a class="btn gold" href="/api/drive/connect?add=1" style="text-decoration:none">Add another Google account</a></div></div>`;
  view.innerHTML = `<div class="gap fade"><div class="card"><h3>Storage status</h3>
    <div class="row"><span class="pill ${s.connected && s.folderOk ? 'completed' : s.configured ? 'in_progress' : 'cancelled'}">${s.connected && s.folderOk ? 'Connected' : s.connected ? 'Folder problem' : s.configured ? 'Not connected' : 'Not configured'}</span></div>
    <p class="small">Root folder ID:<br><code style="word-break:break-all">${esc(s.rootFolderId)}</code></p>
    ${s.account ? `<p class="small">Google account: <b>${esc(s.account)}</b></p>` : ''}
    ${s.message ? `<p class="small" style="color:${s.folderOk ? 'var(--ok)' : 'var(--danger)'}">${esc(s.message)}</p>` : ''}
    ${s.quota ? `<p class="small muted">Drive storage used: ${fmtSize(s.quota.used)} of ${s.quota.limit ? fmtSize(s.quota.limit) : 'unlimited'}</p>` : ''}
    ${s.folders && s.folders.length ? `<div class="small muted">Folders: ${s.folders.map(esc).join(' · ')}</div>` : ''}
    <div class="row wrap" style="margin-top:12px">
      ${s.configured && !s.connected ? '<a class="btn gold" href="/api/drive/connect" style="text-decoration:none">Connect Google Drive</a>' : ''}
      ${s.connected ? '<button class="btn small ghost" data-verify>Re-check folder</button><button class="btn small danger" data-disc>Disconnect</button>' : ''}</div></div>
    ${!s.configured ? `<div class="card"><h3>One-time setup needed</h3><p class="small">The server owner must add Google OAuth credentials (free). Step by step instructions are in <b>README.md → “Connect Google Drive”</b>. Until then, uploads are refused with a clear error — nothing is stored anywhere else.</p></div>` : ''}
    ${poolCard}
    ${backupCard}
    <div class="card small muted"><b>How access works:</b> your family never gets direct access to your Drive. Files are uploaded and downloaded through this app's server using your connected account, and the app checks each person's family membership before every download. The Drive folder is never made public.</div></div>`;
  if (q.get('drive')) { toast(q.get('drive') === 'connected' ? 'Google Drive connected' : 'Drive: ' + q.get('drive')); history.replaceState(null, '', '/#/drive'); }
  const v = $('[data-verify]', view); if (v) v.onclick = async () => { try { await api('/drive/setup', { method: 'POST' }); route(); } catch (e) { toast(e.message); } };
  const bb = $('[data-bk]', view); if (bb) bb.onclick = async () => { bb.disabled = true; toast('Backing up…'); try { await api('/drive/backup', { method: 'POST' }); toast('Backup saved to Drive'); route(); } catch (e) { toast(e.message); bb.disabled = false; } };
  const rk = $('[data-rk]', view); if (rk) rk.onclick = async () => {
    const f = await formSheet('Confirm your password', [{ name: 'password', label: 'Password', type: 'password', required: true }], 'Show key'); if (!f) return;
    try {
      const { key } = await api('/drive/restore-key', { method: 'POST', body: { password: f.password } });
      sheet(`<h2>Restore key</h2><p class="small">Copy this and add it in your host’s environment settings as <b>DRIVE_RESTORE_KEY</b>, then redeploy. It only works together with your server’s <b>SECRET_KEY</b>. Keep it private.</p><textarea readonly rows="5" data-key style="word-break:break-all;font-size:.8rem">${esc(key)}</textarea><div class="row" style="margin-top:10px"><button class="btn ghost grow" data-x>Close</button><button class="btn gold grow" data-cp>Copy</button></div>`, (el, close) => {
        $('[data-x]', el).onclick = close;
        $('[data-cp]', el).onclick = async () => { try { await navigator.clipboard.writeText(key); toast('Copied'); } catch (_) { const t = $('[data-key]', el); t.select(); t.setSelectionRange(0, key.length); toast('Select and copy the text'); } };
      });
    } catch (e) { toast(e.message); }
  };
  $$('[data-rmacct]', view).forEach(b => b.onclick = async () => { if (await confirmSheet('Remove this Google account from the storage pool? This only works when no files are stored in it.', 'Remove', true)) try { await api('/drive/accounts/' + encodeURIComponent(b.dataset.rmacct) + '/disconnect', { method: 'POST' }); toast('Account removed'); route(); } catch (e) { toast(e.message); } });
  const d = $('[data-disc]', view); if (d) d.onclick = async () => { if (await confirmSheet('Disconnect Google Drive? Existing files stay in Drive but become unavailable in the app until you reconnect.', 'Disconnect', true)) try { await api('/drive/disconnect', { method: 'POST' }); route(); } catch (e) { toast(e.message); } };
};

/* ---------- FILE MANAGER ---------- */
const FILE_CATS = [['all', 'All'], ['chat', 'Chat media'], ['photos', 'Photos & videos'], ['plans', 'Plans'], ['events', 'Events'], ['memories', 'Memories'], ['documents', 'Documents'], ['shopping', 'Shopping & other']];
KF.views.files = async view => {
  let cat = 'all';
  async function draw() {
    const files = await api('/files' + (cat === 'all' ? '' : '?category=' + cat));
    view.innerHTML = `<div class="gap fade"><div class="chips">${FILE_CATS.map(([k, l]) => `<button class="chip ${k === cat ? 'on' : ''}" data-c="${k}">${l}</button>`).join('')}</div>
      <button class="btn gold block" data-up>Upload file</button>
      ${files.length ? `<div class="card list">${files.map(f => `<div class="row" data-f="${f.id}" style="cursor:pointer"><span class="avatar" style="border-radius:12px;font-size:1.2rem">${f.mime.startsWith('image/') ? '🖼️' : f.mime.startsWith('video/') ? '🎬' : f.mime.startsWith('audio/') ? '🎙️' : '📄'}</span><div class="grow"><b style="word-break:break-all">${esc(f.name)}</b><div class="small muted">${fmtSize(f.size)} · ${fmtDate(f.createdAt)} · ${esc(member(f.uploadedBy)?.name.split(' ')[0] || '?')}</div></div></div>`).join('')}</div>` : '<div class="empty"><div class="big">📁</div>No files here yet.</div>'}</div>`;
    $$('[data-c]', view).forEach(b => b.onclick = () => { cat = b.dataset.c; draw(); });
    $$('[data-f]', view).forEach(r => r.onclick = () => previewFile(files.find(f => f.id === r.dataset.f)));
    $('[data-up]', view).onclick = async () => { const [f] = await pickFile(); if (!f) return; toast('Uploading…'); try { await uploadFile(f, cat === 'all' || cat === 'chat' ? 'documents' : cat); draw(); } catch (e) { toast(e.message); } };
  }
  await draw();
};

/* ---------- SEARCH ---------- */
KF.views.search = async view => {
  view.innerHTML = `<div class="gap fade"><input data-q placeholder="Search messages, plans, events, files…" autofocus><div data-res></div></div>`;
  const res = $('[data-res]', view); let t;
  $('[data-q]', view).oninput = e => { clearTimeout(t); const q = e.target.value.trim(); if (q.length < 2) { res.innerHTML = ''; return; }
    t = setTimeout(async () => { try { const r = await api('/search?q=' + encodeURIComponent(q));
      const sec = (title, rows) => rows.length ? `<h3 style="margin:14px 0 6px">${title}</h3><div class="card list">${rows.join('')}</div>` : '';
      res.innerHTML = sec('Messages', r.messages.map(m => `<a href="#/room/${m.roomId}" style="text-decoration:none;color:inherit;display:block"><div class="small muted">${esc(m.roomName)} · ${esc(member(m.userId)?.name || '')} · ${fmtDT(m.createdAt)}</div>${esc(m.text)}</a>`)) +
        sec('Plans', r.plans.map(p => `<a href="#/plan/${p.id}" style="text-decoration:none;color:inherit;display:block"><b>${esc(p.title)}</b></a>`)) +
        sec('Events', r.events.map(p => `<a href="#/events" style="text-decoration:none;color:inherit;display:block"><b>${esc(p.title)}</b><div class="small muted">${fmtDT(p.startsAt)}</div></a>`)) +
        sec('Files', r.files.map(f => `<a href="/api/files/${f.id}/content" download="${esc(f.name)}" style="text-decoration:none;color:inherit;display:block">📎 ${esc(f.name)}</a>`));
      if (!res.innerHTML) res.innerHTML = '<div class="empty"><div class="big">🔍</div>No results.</div>'; } catch (x) { res.innerHTML = `<div class="empty">${esc(x.message)}</div>`; } }, 300); };
};

/* ---------- PRIVACY & SECURITY ---------- */
KF.views.privacy = async view => {
  view.innerHTML = `<div class="gap fade">
    <div class="card"><h3>Change password</h3><label>Current password</label><input type="password" data-cp autocomplete="current-password"><label>New password (min 8)</label><input type="password" data-np autocomplete="new-password"><button class="btn gold block" data-pw style="margin-top:10px">Update password</button></div>
    <div class="card"><h3>Your data</h3><p class="small">Download everything we hold about you in this family (messages, plans, expenses you are part of).</p><button class="btn small ghost" data-export>Download my data</button></div>
    <div class="card"><h3>Delete my account</h3><p class="small">Removes your profile and your private chats. Messages you posted in family chats are replaced with “Message deleted”. Files you uploaded stay in the family's Drive unless you delete them first. The family owner must transfer or delete the family first.</p><button class="btn danger block" data-del>Delete my account</button></div>
    <div class="card small muted"><b>About privacy:</b> data is protected by login, HTTPS and permission checks on the server. Messages are <b>not</b> end-to-end encrypted — the server administrator can technically read the database. Private chats are hidden from other family members but not from whoever hosts the server.</div></div>`;
  $('[data-pw]', view).onclick = async () => { try { await api('/me/password', { method: 'POST', body: { current: $('[data-cp]', view).value, next: $('[data-np]', view).value } }); toast('Password updated'); $('[data-cp]', view).value = $('[data-np]', view).value = ''; } catch (e) { toast(e.message); } };
  $('[data-export]', view).onclick = async () => { try { const d = await api('/me/export'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); a.download = 'kataria-family-my-data.json'; a.click(); } catch (e) { toast(e.message); } };
  $('[data-del]', view).onclick = async () => { const v = await formSheet('Delete account', [{ name: 'password', label: 'Enter your password to confirm', type: 'password', required: true }], 'Delete forever'); if (v) try { await api('/me', { method: 'DELETE', body: v }); KF.state.me = null; KF.showAuth('welcome'); } catch (e) { toast(e.message); } };
};

/* ---------- HELP ---------- */
KF.views.help = async view => {
  const faq = [['How do I install the app?', 'Open the site in Chrome on Android → ⋮ menu → Install app (or Add to Home screen).'], ['How do I invite family?', 'Profile → Invitations → Create invitation → Share link. They register, and are added automatically.'], ['Who can see my private chats?', 'Only you and the other person. They are not shown to the family or admins in the app.'], ['Where are photos and files stored?', 'In the family owner\'s Google Drive folder, uploaded through this app. Nothing is made public.'], ['Why do notifications not pop up?', 'Enable them in App Settings. Phone push also needs server push keys (see README). Otherwise you see badges and in-app alerts.'], ['I forgot my password', 'On the login screen tap “Forgot password?”. The code appears in the server log for whoever hosts the app (no email service is used).']];
  view.innerHTML = `<div class="gap fade"><div class="card"><h3>Frequently asked</h3>${faq.map(([q, a]) => `<details style="padding:8px 0;border-bottom:1px solid var(--line)"><summary><b>${q}</b></summary><p class="small">${a}</p></details>`).join('')}</div>
    <div class="card"><h3>Contact</h3><p class="small">Ask your Family Owner for help, or open an issue wherever this app's code is hosted.</p></div>
    <div class="center small muted">KATARIA FAMILY v1.0 · Together as One ✦</div></div>`;
};
