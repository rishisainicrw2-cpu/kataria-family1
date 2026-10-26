/* Router, navigation shell and boot sequence */
const TABS = [['home', 'Home', 'home'], ['chats', 'Chats', 'chat'], ['plans', 'Matches', 'plans'], ['calendar', 'Calendar', 'cal'], ['profile', 'Profile', 'user']];
const TAB_OF = { room: 'chats', search: 'chats', plan: 'plans', events: 'calendar', members: 'profile', invitations: 'profile', notifications: 'home', settings: 'profile', family: 'profile', drive: 'profile', files: 'profile', privacy: 'profile', help: 'profile', polls: 'plans', shopping: 'home', expenses: 'home', memories: 'home' };
const TITLES = { home: 'HINDU ESPORTS', chats: 'Chats', plans: 'Match Plans', calendar: 'Calendar', profile: 'Profile', events: 'Clan Events', shopping: 'Gear Lists', expenses: 'Clan Funds', memories: 'Highlights', polls: 'Polls & Voting', members: 'Clan Members', invitations: 'Invitations', notifications: 'Notifications', settings: 'App Settings', family: 'Clan Settings', drive: 'Google Drive', files: 'File Manager', search: 'Search', privacy: 'Privacy & Security', help: 'Help & Support', plan: 'Plan' };

KF.setTitle = (t, opts = {}) => {
  const tb = $('#topbar');
  tb.innerHTML = `${opts.back ? `<button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>` : ''}
    <h1>${t === 'HINDU ESPORTS' ? 'HINDU <span class="gold">ESPORTS</span> ✦' : esc(t)}</h1>
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
  KF.setTitle(TITLES[name] || 'HINDU ESPORTS', { back: sub ? true : false });
  view.innerHTML = '<div class="center" style="padding:40px"><div class="spinner" style="margin:auto;border-color:var(--line);border-top-color:var(--gold)"></div></div>';
  try { await fn(view, params.map(decodeURIComponent)); }
  catch (e) { view.classList.remove('chatmode'); view.innerHTML = `<div class="empty"><div class="big">⚠️</div>${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">Try again</button></div>`; }
}
window.addEventListener('hashchange', route);
KF.route = route;

async function refreshFamily() {
  const f = await api('/family');
  KF.state.family = f.family; KF.state.members = f.members;
  KF.state.me = { ...KF.state.me, role: f.me.role, elite: f.me.elite, perms: f.me.perms };
  KF.state.online = new Set(f.online);
  applyTheme();
}
KF.refreshFamily = refreshFamily;

async function boot() {
  try {
    const me = await api('/me');
    KF.state.canCreateClan = !!me.canCreateClan;
    KF.state.me = me.user;
    if (!me.family) { applyTheme(); KF.showAuth('family'); return; }
    await refreshFamily();
    const n = await api('/notifications/unread-count').catch(() => ({ count: 0 })); KF.state.notifUnread = n.count;
    $('#auth').classList.add('hidden'); $('#boot').classList.add('hidden'); $('#app').classList.remove('hidden');
    KF.connectWS();
    loadRooms().catch(() => {});
    if (!location.hash) location.hash = '#/home'; else route();
    setupPush();
    setTimeout(askAlerts, 1800);
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
// While the app is in the background the live connection is closed, so the server knows to send a phone notification instead.
let wsSleep = 0;
document.addEventListener('visibilitychange', () => {
  clearTimeout(wsSleep);
  if (document.visibilityState === 'visible') { KF.wsPaused = false; if (KF.state.me) KF.connectWS(); }
  else wsSleep = setTimeout(() => { KF.wsPaused = true; try { KF.ws && KF.ws.close(); } catch (_) {} }, 15000);
});

/* Web Push (optional): only if the server has VAPID keys configured */
async function setupPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const cfg = await api('/push/config'); if (!cfg.publicKey) return;
    const reg = await navigator.serviceWorker.ready;
    if (Notification.permission === 'default') return; // asked from Settings, never automatically
    if (Notification.permission !== 'granted') return;
    const key = Uint8Array.from(atob(cfg.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    let sub = await reg.pushManager.getSubscription();
    // a subscription made with different server keys can never receive anything: replace it
    if (sub && sub.options && sub.options.applicationServerKey && Array.from(new Uint8Array(sub.options.applicationServerKey)).join() !== Array.from(key).join()) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
  } catch (_) {}
}
KF.setupPush = setupPush;

/* Right after login: ask the person once to allow phone alerts (browsers only show their own permission box after a tap, so we show our own first) */
const store = { get: k => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} } };
function askAlerts() {
  if (!KF.state.me || document.querySelector('.sheet-bg')) return;
  const snooze = +store.get('kf_alerts_snooze') || 0; if (Date.now() < snooze) return;
  const later = () => store.set('kf_alerts_snooze', String(Date.now() + 2 * 86400000));
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  if (ios) { // iPhone only allows alerts for apps added to the Home Screen
    if (store.get('kf_ios_hint')) return; store.set('kf_ios_hint', '1');
    return sheet(`<div class="center"><div style="font-size:2.4rem">🔔</div><h2>Get phone alerts</h2><p class="muted">On iPhone, first add this app to your Home Screen:<br><b>Share</b> button → <b>Add to Home Screen</b>.<br>Then open it from there and allow alerts.</p><button class="btn gold block" data-ok>OK</button></div>`, (s, close) => { $('[data-ok]', s).onclick = close; });
  }
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'default') return;
  sheet(`<div class="center"><div style="font-size:2.4rem">🔔</div><h2>Allow phone alerts?</h2>
    <p class="muted">Get a notification when your clan messages you, plans a match or posts news, even when the app is closed.</p>
    <button class="btn gold block" data-allow>Allow alerts</button>
    <button class="btn ghost block" data-later style="margin-top:8px">Not now</button></div>`, (s, close) => {
    $('[data-allow]', s).onclick = async () => { close(); try { const r = await Notification.requestPermission(); if (r === 'granted') { await setupPush(); toast('Phone alerts are on 🔔'); if (location.hash.startsWith('#/home')) route(); } else later(); } catch (_) { later(); } };
    $('[data-later]', s).onclick = () => { later(); close(); };
  });
}
KF.askAlerts = askAlerts;

/* PWA install prompt (Android Chrome) */
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); KF.installEvt = e; });
// The Android app (APK) opens this site inside Chrome without a browser bar and tells the page where it came from.
try { if ((document.referrer || '').startsWith('android-app://')) sessionStorage.setItem('kf_in_app', '1'); } catch (_) {}
KF.inAndroidApp = () => { try { return sessionStorage.getItem('kf_in_app') === '1'; } catch (_) { return false; } };
KF.isInstalled = () => !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || KF.inAndroidApp());
window.addEventListener('appinstalled', () => { KF.installEvt = null; toast('App installed ✓ Open it from your home screen', 5000); document.querySelectorAll('[data-install],[data-apk]').forEach(b => b.classList.add('hidden')); });

/* Invitation code: kept for 3 days on this phone, so it is still there after the app has been installed and opened. */
KF.inviteGet = () => {
  try { const [c, t] = (localStorage.getItem('kf_invite') || '').split('|'); if (c && Date.now() - Number(t) < 3 * 864e5) return c; } catch (_) {}
  try { return sessionStorage.getItem('kf_invite') || ''; } catch (_) { return ''; }
};
KF.inviteSet = c => { try { sessionStorage.setItem('kf_invite', c); } catch (_) {} try { localStorage.setItem('kf_invite', c + '|' + Date.now()); } catch (_) {} };
KF.inviteClear = () => { try { sessionStorage.removeItem('kf_invite'); } catch (_) {} try { localStorage.removeItem('kf_invite'); } catch (_) {} };

/* Android app file (APK). Android phones get "Download Android app" first, then "add to home screen"; iPhones and computers get the normal install button. */
KF.isAndroid = /Android/i.test(navigator.userAgent);
KF.APK_URL = '/hindu-esports.apk';
KF.installHtml = big => {
  if (KF.isInstalled()) return '';
  const note = t => big ? `<div class="small center" style="margin:-4px 0 2px;color:#ffd9bf;opacity:.85">${t}</div>` : '';
  if (!KF.isAndroid) return `<button type="button" class="btn install block${big ? ' big' : ''}" data-install>📲 Install app</button>${note('Install first: opens like a real app and gives phone alerts')}`;
  return `<a class="btn install block${big ? ' big' : ''}" href="${KF.APK_URL}" download="HinduEsports.apk" data-apk>⬇️ Download Android app</a>${note('Free app file · opens full screen like a real app · phone alerts')}`
    + '<button type="button" class="btn ghost block" style="color:#fff;border-color:rgba(255,255,255,.3)" data-install>📲 Or add to home screen</button>';
};
KF.wireInstall = el => {
  $$('[data-install]', el).forEach(b => b.onclick = () => KF.installApp());
  // the download itself starts normally; the help sheet only explains what to tap when it has finished
  $$('[data-apk]', el).forEach(a => a.addEventListener('click', () => setTimeout(KF.apkSteps, 600)));
};
KF.apkSteps = () => sheet(`<div class="center"><div style="font-size:2.4rem">🤖</div><h2>Install the Android app</h2>
  <p class="muted" style="text-align:left">1. If Chrome says <i>"This type of file can harm your device"</i>, tap <b>Download anyway</b> (it is this clan's own app). When it finishes, tap <b>Open</b> (or open it from <b>Files → Downloads</b>)<br>
  2. If Android says it can't install unknown apps, tap <b>Settings</b>, switch on <b>Allow from this source</b>, then press Back<br>
  3. Tap <b>Install</b> (if Play Protect asks, tap <b>More details → Install anyway</b>)<br>
  4. Tap <b>Open</b>, then log in and allow phone alerts</p>
  <p class="small muted">The app is just this website in full screen, so your chats stay in sync with the web version.</p>
  <button class="btn gold block" data-ok>OK</button></div>`, (s, close) => { $('[data-ok]', s).onclick = close; });
// Install the app: Android Chrome installs it as a real app (own icon, full screen, no browser bar). iPhone and other browsers get the steps.
KF.installApp = async () => {
  if (KF.installEvt) { const ev = KF.installEvt; KF.installEvt = null; try { await ev.prompt(); } catch (_) {} return; }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  sheet(`<div class="center"><div style="font-size:2.4rem">📲</div><h2>Install Hindu Esports</h2>
    ${ios ? '<p class="muted">1. Tap the <b>Share</b> button (square with an arrow)<br>2. Tap <b>Add to Home Screen</b><br>3. Tap <b>Add</b></p>'
          : '<p class="muted">1. Tap the <b>⋮</b> menu in Chrome (top right)<br>2. Tap <b>Install app</b> (or <b>Add to Home screen</b>)<br>3. Tap <b>Install</b></p>'}
    <p class="small muted">Then open <b>Hindu Esports</b> from your home screen.</p><button class="btn gold block" data-ok>OK</button></div>`, (s, close) => { $('[data-ok]', s).onclick = close; });
};
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
boot();
