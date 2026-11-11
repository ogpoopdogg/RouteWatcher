const CACHE_NAME = 'ec-dispatch-v2';
const PAGE = 'index.html';

self.addEventListener('install', function(event) {
    self.skipWaiting();
    // Save the page now, so the next open already comes from the saved copy
    event.waitUntil(caches.open(CACHE_NAME).then(function(cache) {
        return cache.add(new Request(PAGE, { cache: 'no-cache' }));
    }).catch(function() {}));
});

self.addEventListener('activate', function(event) {
    event.waitUntil((async function() {
        // The page now comes from the saved copy, so the navigation preload request (used before) is not needed
        if (self.registration.navigationPreload) {
            try { await self.registration.navigationPreload.disable(); } catch (e) {}
        }
        const keys = await caches.keys();
        await Promise.all(keys.filter(function(key) { return key !== CACHE_NAME; }).map(function(key) { return caches.delete(key); }));
        await self.clients.claim();
    })());
});

// Only this site's own files (the page, icons, manifest) go through here. Map tiles, Firebase, the Cloud
// Functions and fonts go straight to the network without a detour through this worker.
//
// Fast open: the saved copy is used at once (no waiting for the network, also with weak or no signal), and a
// fresh copy is downloaded in the background for next time. When the page itself has changed (a new
// version was put live), the open page is told, and it offers a tap to load the new version.
// With nothing saved yet, it waits for the network as before.
self.addEventListener('fetch', function(event) {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    const isPage = request.mode === 'navigate';
    // "/", "/index.html" and "/index.html?voice=1" (the app icon's "Ask" shortcut) are the same page: one saved copy
    const key = isPage ? new URL(url.pathname.endsWith('/') ? url.pathname + PAGE : url.pathname, url.origin).href : request;
    event.respondWith((async function() {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(key, { ignoreVary: true });
        if (!cached) {
            const response = await fetch(request);
            if (response && response.ok && response.type === 'basic' && !response.redirected) {
                const copy = response.clone();
                event.waitUntil(cache.put(key, copy).catch(function() {}));
            }
            return response;
        }
        const before = isPage ? cached.clone().text() : null; // read now: the page uses up the copy it gets
        // In the background: "no-cache" asks the server whether the file changed (a short "not modified"
        // answer when it didn't)
        event.waitUntil((async function() {
            const response = await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' });
            if (!response || !response.ok || response.type !== 'basic' || response.redirected) return;
            if (!isPage) { await cache.put(key, response); return; }
            const after = await response.clone().text();
            if ((await before) === after) return;
            await cache.put(key, response);
            await tellUpdated(event);
        })().catch(function() {}));
        return cached;
    })());
});

// Tell the page that just opened (from the saved copy) that a newer version is ready. Its window may not
// exist yet when the download finishes, so this tries for a few seconds.
async function tellUpdated(event) {
    for (let i = 0; i < 20; i++) {
        const id = event.resultingClientId || event.clientId;
        const client = id ? await self.clients.get(id) : null;
        if (client) { client.postMessage({ type: 'ec-update-ready' }); return; }
        await new Promise(function(r) { setTimeout(r, 500); });
    }
}
