/* Router, navigation shell and boot sequence */
const TABS = [['home', 'Home', 'home'], ['chats', 'Chats', 'chat'], ['plans', 'Plans', 'plans'], ['calendar', 'Calendar', 'cal'], ['profile', 'Profile', 'user']];
const TAB_OF = { room: 'chats', search: 'chats', plan: 'plans', events: 'calendar', members: 'profile', invitations: 'profile', notifications: 'home', settings: 'profile', family: 'profile', drive: 'profile', files: 'profile', privacy: 'profile', help: 'profile', polls: 'plans', shopping: 'home', expenses: 'home', memories: 'home' };
const TITLES = { home: 'KATARIA FAMILY', chats: 'Chats', plans: 'Family Plans', calendar: 'Calendar', profile: 'Profile', events: 'Family Events', shopping: 'Shopping Lists', expenses: 'Family Expenses', memories: 'Memories', polls: 'Polls & Voting', members: 'Family Members', invitations: 'Invitations', notifications: 'Notifications', settings: 'App Settings', family: 'Family Settings', drive: 'Google Drive', files: 'File Manager', search: 'Search', privacy: 'Privacy & Security', help: 'Help & Support', plan: 'Plan' };

KF.setTitle = (t, opts = {}) => {
  const tb = $('#topbar');
  tb.innerHTML = `${opts.back ? `<button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>` : ''}
    <h1>${t === 'KATARIA FAMILY' ? 'KATARIA <span class="gold">FAMILY</span> ✦' : esc(t)}</h1>
    <a class="icon-btn" href="#/search" aria-label="Search" style="color:#fff">${icon('search')}</a>
    <a class="icon-btn" href="#/notifications" aria-label="Notifications" style="color:#fff;position:relative">${icon('bell')}<span class="badge ${KF.state.notifUnread ? '' : 'hidden'}" data-nb style="position:absolute;top:2px;right:0">${KF.state.notifUnread || ''}</span></a>`;
  const b = $('[data-back]', tb); if (b) b.onclick = () => { opts.back === true ? history.back() : (location.hash = opts.back); };
};
function buildNav(active) {
  $('#nav .inner').innerHTML = TABS.map(([k, label, ic]) => `<a href="#/${k}" data-tab="${k}" class="${k === active ? 'active' : ''}" ${k === active ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${k === 'chats' ? '<span class="badge hidden"></span>' : ''}</a>`).join('');
  KF.updateBadges && KF.updateBadges();
}

async function route() {
  if (!KF.state.me || !KF.state.family) return;
  KF.cleanup && (KF.cleanup(), KF.cleanup = null);
  const [name = 'home', ...params] = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
  const view = $('#view'); view.classList.remove('chatmode'); view.scrollTop = 0;
  const fn = KF.views[name] || KF.views.home;
  const tab = TAB_OF[name] || (TABS.some(t => t[0] === name) ? name : 'home');
  buildNav(tab);
  const sub = !TABS.some(t => t[0] === name);
  KF.setTitle(TITLES[name] || 'KATARIA FAMILY', { back: sub ? true : false });
  view.innerHTML = '<div class="center" style="padding:40px"><div class="spinner" style="margin:auto;border-color:var(--line);border-top-color:var(--gold)"></div></div>';
  try { await fn(view, params.map(decodeURIComponent)); }
  catch (e) { view.classList.remove('chatmode'); view.innerHTML = `<div class="empty"><div class="big">⚠️</div>${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">Try again</button></div>`; }
}
window.addEventListener('hashchange', route);
KF.route = route;

async function refreshFamily() {
  const f = await api('/family');
  KF.state.family = f.family; KF.state.members = f.members;
  KF.state.me = { ...KF.state.me, role: f.me.role, perms: f.me.perms };
  KF.state.online = new Set(f.online);
  applyTheme();
}
KF.refreshFamily = refreshFamily;

async function boot() {
  try {
    const me = await api('/me');
    KF.state.me = me.user;
    if (!me.family) { applyTheme(); KF.showAuth('family'); return; }
    await refreshFamily();
    const n = await api('/notifications/unread-count').catch(() => ({ count: 0 })); KF.state.notifUnread = n.count;
    $('#auth').classList.add('hidden'); $('#boot').classList.add('hidden'); $('#app').classList.remove('hidden');
    KF.connectWS();
    loadRooms().catch(() => {});
    if (!location.hash) location.hash = '#/home'; else route();
    setupPush();
  } catch (e) {
    if (e.status === 401) { applyTheme(); KF.showAuth('welcome'); }
    else { $('#boot').innerHTML += `<p class="center" style="color:#ffb3bd">${esc(e.message)}<br><button class="btn gold" onclick="location.reload()" style="margin-top:12px">Retry</button></p>`; $('#boot .spinner')?.remove(); }
  }
}
KF.boot = boot;

/* realtime presence / badges / notifications */
KF.on('presence', ev => { ev.online ? KF.state.online.add(ev.userId) : KF.state.online.delete(ev.userId); });
KF.on('message.new', ev => {
  const m = ev.message, r = KF.state.rooms.find(x => x.id === m.roomId);
  if (r) { r.lastText = m.text || '📎 attachment'; r.lastAt = m.createdAt; const inRoom = location.hash === '#/room/' + m.roomId; if (m.userId !== KF.state.me.id && !inRoom) r.unread = (r.unread || 0) + 1; KF.updateBadges(); }
  else loadRooms().catch(() => {});
  if (location.hash === '#/chats' || location.hash === '#/home') route();
});
KF.on('notification', ev => {
  KF.state.notifUnread = (KF.state.notifUnread || 0) + 1;
  const b = $('[data-nb]'); if (b) { b.textContent = KF.state.notifUnread; b.classList.remove('hidden'); }
  if (document.visibilityState === 'visible') toast('🔔 ' + ev.title);
});
KF.on('family.changed', async () => { await refreshFamily().catch(() => {}); });
KF.on('data.changed', ev => { if (ev.scope && location.hash.startsWith('#/' + ev.scope)) route(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && KF.state.me) KF.connectWS(); });

/* Web Push (optional): only if the server has VAPID keys configured */
async function setupPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const cfg = await api('/push/config'); if (!cfg.publicKey) return;
    const reg = await navigator.serviceWorker.ready;
    if (Notification.permission === 'default') return; // asked from Settings, never automatically
    if (Notification.permission !== 'granted') return;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(cfg.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) });
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  } catch (_) {}
}
KF.setupPush = setupPush;

/* PWA install prompt (Android Chrome) */
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); KF.installEvt = e; });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
boot();
