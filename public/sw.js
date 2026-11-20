/**
 * BillSynix service worker (Phase 9): lets the POS page open in the browser without a
 * connection. It caches only the app itself — pages and their scripts/styles — never API calls
 * (business data offline lives in the POS's own IndexedDB on registered counters).
 *
 *  - /_next/static/* (content-hashed): cache first.
 *  - pages: network first, the last good copy when offline (or the POS page as a fallback).
 *  - other same-origin files (icons, images): cached copy at once, refreshed in the background.
 */
const VERSION = 'kirana-pos-v1';
const SHELL = ['/pos', '/login'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) =>
        Promise.allSettled(
          SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

const put = async (req, res) => {
  if (res.ok && res.type === 'basic')
    await (await caches.open(VERSION)).put(req, res.clone());
  return res;
};

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (
    req.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches
        .match(req)
        .then((hit) => hit ?? fetch(req).then((res) => put(req, res)))
    );
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => put(req, res))
        .catch(
          async () =>
            (await caches.match(req, { ignoreSearch: true })) ??
            (await caches.match('/pos')) ??
            Response.error()
        )
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(req)
        .then((res) => put(req, res))
        .catch(() => hit ?? Response.error());
      return hit ?? fresh;
    })
  );
});
