'use strict';

/**
 * Offline shell for the installable page.
 *
 * The rule that matters: this file caches the *shell*, never the clinic's live facts.
 * `clinic.json` carries the published name and phone, and a stale copy would show a
 * guardian a phone number the clinic has already changed — so it is excluded twice, from
 * the shell list and at fetch time. Nothing from another origin is touched either.
 */

const CACHE = 'celia-kids-shell-v1';
const SHELL = [
  './', './index.html', './privacy.html',
  './app.css?v=2026', './app.js?v=2026',
  './brand.svg', './manifest.webmanifest',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png',
  './assets/fonts/almarai-400-arabic.woff2', './assets/fonts/almarai-700-arabic.woff2',
  './assets/fonts/almarai-800-arabic.woff2',
  './assets/fonts/plex-arabic-400.woff2', './assets/fonts/plex-arabic-500.woff2',
  './assets/fonts/plex-arabic-600.woff2', './assets/fonts/plex-arabic-700.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One missing file must not fail the install: the shell is an enhancement.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (error) { return; }
  if (url.origin !== self.location.origin) return;
  // Live clinic facts and the backend bridge are never served from cache.
  if (url.pathname.endsWith('/clinic.json')) return;

  if (request.mode === 'navigate') {
    // Network first: a guardian must never get yesterday's page while online.
    event.respondWith(fetch(request).catch(() => caches.match('./index.html')));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const refresh = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => cached);
      return cached || refresh;
    })
  );
});
