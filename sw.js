const CACHE_NAME = 'ec-dispatch-v2';

self.addEventListener('install', function(event) {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil((async function() {
        // Navigation preload: the page itself starts downloading while this worker is still starting up
        if (self.registration.navigationPreload) {
            try { await self.registration.navigationPreload.enable(); } catch (e) {}
        }
        const keys = await caches.keys();
        await Promise.all(keys.filter(function(key) { return key !== CACHE_NAME; }).map(function(key) { return caches.delete(key); }));
        await self.clients.claim();
    })());
});

// Only this site's own files (the page, icons, manifest) go through here: network first, with the last
// good copy kept for when the network is down. Map tiles, Firebase, the Cloud Functions and fonts go
// straight to the network without a detour through this worker.
self.addEventListener('fetch', function(event) {
    const request = event.request;
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith((async function() {
        try {
            const response = (await event.preloadResponse) || await fetch(request);
            if (response && response.ok && response.type === 'basic') {
                const copy = response.clone();
                event.waitUntil(caches.open(CACHE_NAME).then(function(cache) { return cache.put(request, copy); }).catch(function() {}));
            }
            return response;
        } catch (err) {
            const cached = await caches.match(request);
            if (cached) return cached;
            throw err;
        }
    })());
});
