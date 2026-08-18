// Big Business PWA service worker — cache-first app shell, refreshed in background
// Bump this whenever the app shell changes so installed/PWA users do not
// remain on an older toolbar or an older document-ingestion engine.
const CACHE = "bigbiz-v6-duplicate-link-save";
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"])));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  // Never intercept a request to another website. Link ingestion needs the
  // browser's real CORS result; returning our cached index.html would make a
  // blocked site look as if it had been read successfully.
  const requestUrl = new URL(e.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res.ok) {
          const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp));
        }
        return res;
      }).catch(() => hit || (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error()));
      return hit || net;
    })
  );
});
