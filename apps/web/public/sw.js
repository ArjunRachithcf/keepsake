// Keepsake's service worker (ADR 0010): the offline shell and Web Push. Nothing of the household is ever cached:
// /api is never touched here (every answer goes to the network, as the person, and is never kept), only the page and
// the build's files are. A push shows one fixed text and nothing from the push itself (its payload is always the
// same, {"v":1}); what is new is read from the API once Keepsake is open.
/* global self, caches, clients, fetch, Response */
const SHELL = 'keepsake-shell-v1';
const PRECACHE = ['/', '/site.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

/** The build's files a page names (/assets/…, hashed, never changing). */
const assetsOf = (html) => [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1]);

/** The page and the files it names, kept for offline; build files the page no longer names are dropped. */
async function keepShell(cache, html) {
  const wanted = new Set(assetsOf(html));
  await Promise.all([...wanted].map(async (a) => { if (!(await cache.match(a))) await cache.add(a).catch(() => undefined); }));
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/') && !wanted.has(path)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(PRECACHE);
    const page = await cache.match('/');
    if (page) await keepShell(cache, await page.text());
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only this origin's GETs; never the API, never the guest page's own requests (they are /api too).
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // The page: from the network (so a new build shows at once), the kept one when offline.
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      try {
        const res = await fetch(req);
        if (res.ok && res.headers.get('content-type')?.startsWith('text/html')) {
          // Kept as it came, its security headers (the CSP) with it.
          const [kept, read] = [res.clone(), res.clone()];
          event.waitUntil((async () => { await cache.put('/', kept); await keepShell(cache, await read.text()); })());
        }
        return res;
      } catch {
        return (await cache.match('/')) ?? Response.error();
      }
    })());
    return;
  }
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) {
    event.respondWith((async () => (await caches.match(req)) ?? fetch(req))());
  }
});

// A push: always the same words, whatever it carried. The tag keeps one notification, never a stack.
self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Keepsake', {
    body: 'Something new in Keepsake', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'keepsake', renotify: true,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const here = open.find((c) => new URL(c.url).origin === self.location.origin);
    if (here) { await here.focus(); return here.navigate('/').catch(() => undefined); }
    return clients.openWindow('/');
  })());
});
