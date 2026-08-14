/*!
 * sw.js — service worker for TS→M4A download synthesis.
 *
 * Answers requests for *.m4a URLs by remuxing the site's HLS segments
 * (ts2m4a, loaded relative to this script). Response carries
 * Content-Disposition: attachment, so clicking a download link, or pasting
 * a copied link into the address bar, downloads the file — no .m4a is ever
 * stored in the repo.
 *
 * Registration (in index.html, after the docsify config):
 *   if ('serviceWorker' in navigator) {
 *     navigator.serviceWorker.register(
 *       (window.$docsify && window.$docsify.basePath || '/') + 'sw.js'
 *     ).then(function (r) { r.update(); });
 *   }
 *
 * Layout expected by this file (adjust importScripts for your site):
 *   sw.js
 *   vendor/ts2m4a/ts2m4a.js
 *
 * Route mapping handled by ts2m4a.handleM4aRequest:
 *   local:  …/{stem}.m4a  →  …/{stem}.m3u8 (same directory)
 *   remote: /remote/codeberg.org/{owner}/{repo}/…  →  https://{owner}.codeberg.page/{repo}/…
 */
importScripts('vendor/ts2m4a/ts2m4a.js');

var cacheName = 'ts2m4a-' + self.ts2m4a.VERSION;

self.addEventListener('install', function () {
  self.skipWaiting();
  caches.keys().then(function (keys) {
    return Promise.all(keys
      .filter(function (k) { return k.indexOf('ts2m4a-') === 0 && k !== cacheName; })
      .map(function (k) { return caches.delete(k); }));
  });
});

self.addEventListener('activate', function () {
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (!/\.m4a$/i.test(url.pathname)) return;
  e.respondWith(self.ts2m4a.handleM4aRequest(url, {
    fetchImpl: self.fetch.bind(self),
    cacheImpl: {
      match: function (key) {
        return caches.open(cacheName).then(function (c) { return c.match(key); });
      },
      put: function (key, resp) {
        return caches.open(cacheName).then(function (c) { return c.put(key, resp); });
      },
    },
  }));
});
