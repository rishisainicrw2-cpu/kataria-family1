// KATARIA FAMILY service worker: caches the app shell only. API/WebSocket/Drive files are never cached,
// so private family data is not stored by the service worker.
const CACHE = 'kataria-shell-v1';
const SHELL = ['/', '/styles.css', '/js/core.js', '/js/views.js', '/js/chat.js', '/js/features.js', '/js/features2.js', '/js/app.js',
  '/assets/icon-192.png', '/assets/icon-512.png', '/assets/logo.svg', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api') || u.pathname === '/ws') return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
// Pushes carry no payload (keeps private text off third-party push servers); we fetch the latest unread item ourselves.
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let d = { title: 'KATARIA FAMILY', body: 'New activity in your family', url: '/' };
    try { const r = await fetch('/api/notifications/latest', { credentials: 'same-origin' }); if (r.ok) d = await r.json(); } catch (_) {}
    await self.registration.showNotification(d.title || 'KATARIA FAMILY', {
      body: d.body || '', icon: '/assets/icon-192.png', badge: '/assets/favicon-48.png', data: '/' + (d.url && d.url.startsWith('#') ? d.url : '')
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window' }).then(l => l.length ? l[0].focus() : clients.openWindow(e.notification.data || '/')));
});
