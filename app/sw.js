/* Pharaon Mobile — service worker: full offline support.
   Cache-first for the app shell and the Python runtime; once installed,
   the app runs with no network at all (data lives in IndexedDB). */
'use strict';

const CACHE = 'pharaon-mobile-v2';

const SHELL = [
  /* Python runtime — precached at install so the very first offline launch
     works even if the boot raced the service worker's activation. */
  './pyodide/pyodide.js',
  './pyodide/pyodide.asm.js',
  './pyodide/pyodide.asm.wasm',
  './pyodide/python_stdlib.zip',
  './pyodide/pyodide-lock.json',
  './pyodide/sqlite3-1.0.0.zip',
  './',
  './index.html',
  './styles.css',
  './mobile.css',
  './app.js',
  './bridge.js',
  './mobile.js',
  './manifest.webmanifest',
  './assets/logo.png',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable.png',
  './assets/apple-touch-icon.png',
  './assets/fonts/dm-sans.css',
  './assets/fonts/dm-sans-1.woff2',
  './assets/fonts/dm-sans-2.woff2',
  './assets/fonts/dm-sans-3.woff2',
  './assets/fonts/dm-sans-4.woff2',
  './backend/__init__.py',
  './backend/version.py',
  './backend/autostart.py',
  './backend/memory.py',
  './backend/database.py',
  './backend/optimizer.py',
  './backend/scheduler.py',
  './backend/api.py',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Cache-first; anything fetched at runtime (the Pyodide runtime files,
   the sqlite wheel) is cached on first use so later launches are offline. */
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(resp => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      });
    })
  );
});
