// Always serve the newest deploy of the app's own files (index.html, manifest, icons).
// Every request for them goes to the network with the HTTP cache bypassed, so a code
// change shows up on the next launch without reinstalling the app or clearing data.
// A copy is kept only as a fallback for when the device is offline.
// Requests to other sites (Firebase, Google Maps, Cloud Functions, fonts) are not touched.
const CACHE_NAME = 'ec-dispatch-offline';

self.addEventListener('install', function(event) {
    self.skipWaiting(); // a new sw.js takes over at once instead of waiting for every window to close
});

self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys()
            .then(function(keys) {
                return Promise.all(keys.filter(function(k) { return k !== CACHE_NAME; }).map(function(k) { return caches.delete(k); }));
            })
            .then(function() { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function(event) {
    const req = event.request;
    if (req.method !== 'GET') return;
    if (new URL(req.url).origin !== self.location.origin) return;

    event.respondWith(
        fetch(req, { cache: 'no-store' })
            .then(function(res) {
                if (res && res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then(function(cache) { return cache.put(req, copy); }).catch(function() {});
                }
                return res;
            })
            .catch(function() {
                return caches.match(req, { ignoreSearch: true }).then(function(hit) {
                    return hit || Response.error();
                });
            })
    );
});
