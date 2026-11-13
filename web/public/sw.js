// Minimal service worker: cache the app shell for instant launch.
// Never caches /api, /ws or /widgets (always live).
const CACHE = "harbor-v2";
self.addEventListener("install", (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/manifest.webmanifest", "/icons/icon.svg"]))); });
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || /^\/(api|ws|widgets|user-icons)/.test(u.pathname)) return;
  if (u.pathname.startsWith("/assets/")) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => { const c = res.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)); return res; })));
    return;
  }
  // App shell: always revalidate with the server so a new build is picked up at once.
  e.respondWith(fetch(e.request, { cache: "no-cache" }).catch(() => caches.match(e.request).then((r) => r || caches.match("/"))));
});
