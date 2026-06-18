const CACHE = 'illiberis-v3';
const OFFLINE_URLS = ['/menage', '/mobile', '/manifest-menage.json', '/icon-menage-192.png', '/icon-menage-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(OFFLINE_URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => clients.claim()));
});
self.addEventListener('fetch', e => {
  if(e.request.url.includes('/all-reservations')||e.request.url.includes('/subscribe')||e.request.url.includes('/vapid-key')) return;
  e.respondWith(fetch(e.request).then(res => {
    if(res.ok&&(e.request.url.includes('/menage')||e.request.url.includes('/mobile'))){
      const clone=res.clone();caches.open(CACHE).then(c=>c.put(e.request,clone));
    }
    return res;
  }).catch(()=>caches.match(e.request)));
});
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(self.registration.showNotification(data.title||'🧹 Illiberis Ménage', {
    body: data.body||'Nouvelle notification',
    icon: '/icon-menage-192.png',
    badge: '/icon-menage-192.png',
    tag: data.tag||'illiberis',
    data: {url: data.url||'/menage'},
    requireInteraction: true,
    vibrate: [200,100,200]
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'/menage';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    const m=cs.find(c=>c.url.includes('hostex-proxy.onrender.com'));
    if(m) return m.focus();
    return clients.openWindow(url);
  }));
});
