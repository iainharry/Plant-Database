// PlantDB Service Worker v4
const CACHE = 'plantdb-v4';
const ASSETS = [
  './',
  './index.html',
  './plantdatabase.html',
  './manifest.json',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@300;400;500&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always fetch live from Google Apps Script (sync endpoint)
  if (url.hostname === 'script.google.com' ||
      url.hostname === 'script.googleusercontent.com') {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network-first for plantdatabase.html so updates are always picked up
  if (url.pathname.endsWith('plantdatabase.html') ||
      url.pathname.endsWith('index.html') ||
      url.pathname === '/' ||
      url.pathname.endsWith('/')) {
    e.respondWith(
      fetch(e.request).then(r => {
        const c = r.clone();
        caches.open(CACHE).then(ca => ca.put(e.request, c));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Network-first with cache fallback for Google Fonts / CDN assets
  if (url.hostname.includes('googleapis.com') ||
      url.hostname.includes('gstatic.com') ||
      url.hostname.includes('cdnjs.cloudflare.com')) {
    e.respondWith(
      fetch(e.request).then(r => {
        const c = r.clone();
        caches.open(CACHE).then(ca => ca.put(e.request, c));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for everything else (icons, manifest, etc.)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        if (r && r.status === 200 && r.type === 'basic') {
          const c = r.clone();
          caches.open(CACHE).then(ca => ca.put(e.request, c));
        }
        return r;
      });
    })
  );
});

self.addEventListener('sync', e => {
  if (e.tag === 'sync-plants') {
    e.waitUntil(
      self.clients.matchAll().then(cs =>
        cs.forEach(c => c.postMessage({ type: 'TRIGGER_SYNC' }))
      )
    );
  }
});
