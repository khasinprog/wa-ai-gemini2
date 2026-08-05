const CACHE_NAME = 'wa-ai-v1';
const STATIC_ASSETS = ['/', '/index.html'];

// Install: cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network first, fallback to cache (khusus untuk navigasi halaman)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Cache hanya asset halaman, jangan cache API calls
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Cache response terbaru untuk navigasi
        if (event.request.destination === 'document') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push notification handler
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: 'WA AI', body: event.data.text() }; }

  event.waitUntil(
    self.registration.showNotification(data.title || 'WA AI Assistant', {
      body: data.body || 'Ada pesan baru masuk',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'wa-ai-message',
      renotify: true,
      data: { url: data.url || '/' }
    })
  );
});

// Notification click handler
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus().then(c => c.navigate(target));
      return clients.openWindow(target);
    })
  );
});
