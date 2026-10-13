const CACHE_VERSION = 'buyfast-topup-v15';
const STATIC_CACHE = 'buyfast-static-v15';
const IMAGE_CACHE = 'buyfast-images-v15';

const PRECACHE_URLS = [
  '/manifest.json',
  '/offline.html',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/icon-192x192.jpg',
  '/icons/icon-96x96.jpg'
];

const CACHEABLE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.ico', '.avif'];
const CACHEABLE_FONT_EXTENSIONS = ['.woff', '.woff2', '.ttf', '.otf', '.eot'];

const NO_CACHE_PATTERNS = [
  '/assets/',
  '/@vite/',
  '/@react-refresh',
  '/src/',
  '/api/',
  '.hot-update.'
];

const MAX_IMAGE_CACHE_SIZE = 100;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch((error) => console.error('[SW] Install failed:', error))
  );
});

self.addEventListener('activate', (event) => {
  const validCaches = [STATIC_CACHE, IMAGE_CACHE];
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((name) => !validCaches.includes(name))
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

function shouldNotCache(url) {
  return NO_CACHE_PATTERNS.some(pattern => url.includes(pattern));
}

function isImageRequest(url) {
  return CACHEABLE_IMAGE_EXTENSIONS.some(ext => url.toLowerCase().includes(ext));
}

function isFontRequest(url) {
  return CACHEABLE_FONT_EXTENSIONS.some(ext => url.toLowerCase().includes(ext));
}

async function trimCache(cacheName, maxSize) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxSize) {
    for (let i = 0; i < keys.length - maxSize; i++) {
      await cache.delete(keys[i]);
    }
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.startsWith('chrome-extension://')) return;

  const url = event.request.url;

  if (shouldNotCache(url)) {
    event.respondWith(
      fetch(event.request).catch(() => {
        if (event.request.destination === 'document') {
          return caches.match('/offline.html');
        }
        return new Response('Network error', { status: 503 });
      })
    );
    return;
  }

  if (isImageRequest(url) || isFontRequest(url)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(IMAGE_CACHE).then((cache) => {
              cache.put(event.request, clone);
              trimCache(IMAGE_CACHE, MAX_IMAGE_CACHE_SIZE);
            });
          }
          return response;
        }).catch(() => new Response('', { status: 404 }));
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.status === 200 && !url.includes('.js') && !url.includes('.ts')) {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          if (event.request.destination === 'document') {
            return caches.match('/offline.html');
          }
          return new Response('Resource not available offline', { status: 503 });
        });
      })
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'background-sync') {
    event.waitUntil(Promise.resolve());
  }
});

self.addEventListener('push', (event) => {
  // Use dynamic origin so icons load correctly in dev AND production
  const origin = self.location.origin;
  let title    = 'BuyFast TopUp';
  let body     = 'Ou gen yon nouvo notifikasyon BuyFast';
  let icon     = origin + '/icons/icon-192x192.png';
  let badge    = origin + '/icons/icon-96x96.png';
  let image;
  let clickUrl = origin + '/dashboard';

  try {
    if (event.data) {
      const payload = event.data.json();
      const n = payload.notification || {};
      const d = payload.data         || {};
      title    = d.title      || n.title  || title;
      body     = d.body       || n.body   || body;
      icon     = d.icon       || n.icon   || icon;
      badge    = d.badge      || badge;
      image    = d.image      || n.image  || undefined;
      const rawClick = d.clickAction || d.url || n.click_action || clickUrl;
      // Always store an absolute URL so clients.openWindow / client.navigate work in all browsers
      clickUrl = rawClick.startsWith('http')
        ? rawClick
        : self.location.origin + (rawClick.startsWith('/') ? rawClick : '/' + rawClick);
    }
  } catch (_) {
    body = 'Ou gen yon nouvo notifikasyon BuyFast';
  }

  if (!body) body = 'Ou gen yon nouvo notifikasyon BuyFast';

  const uniqueTag = 'buyfast-' + Date.now();
  const notifOptions = { body, icon, badge, renotify: true, requireInteraction: true, vibrate: [200, 100, 200], data: { clickUrl }, tag: uniqueTag };
  if (image) notifOptions.image = image;

  event.waitUntil(
    self.registration.showNotification(title, notifOptions).catch((err) => {
      console.error('[SW] showNotification failed:', err);
      return self.registration.showNotification('BuyFast TopUp', { body, icon, badge });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'FORCE_CLEAR_CACHE') {
    caches.keys().then((cacheNames) => {
      return Promise.all(cacheNames.map((name) => caches.delete(name)));
    }).then(() => {
      self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'CACHE_CLEARED' }));
      });
    });
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Resolve absolute URL (clickUrl stored at push time is already absolute)
  let clickUrl = (event.notification.data && event.notification.data.clickUrl) || '/';
  if (!clickUrl.startsWith('http')) {
    clickUrl = self.location.origin + (clickUrl.startsWith('/') ? clickUrl : '/' + clickUrl);
  }

  if (event.action === 'close') return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If app is already open → navigate that window to the target page
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.navigate(clickUrl).then(() => client.focus()).catch(() => client.focus());
        }
      }
      // App not open → open a new window
      return clients.openWindow(clickUrl);
    })
  );
});
