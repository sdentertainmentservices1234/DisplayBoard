/* SD War Room / Display Board — service worker.
   The board HTML is NETWORK-FIRST so a deployed change is live on the next open
   (cache is the offline fallback). Firebase SDK + fonts + icons are CACHE-FIRST
   so the login button is armed instantly. Live data (the SC board relay,
   Firestore, Auth) is NEVER cached. */
const CACHE = "sdboard-v31";
const SHELL = ["./board.html", "./board-manifest.json",
  "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// A push from the chamber's worker — shows even when the app is CLOSED. Payload is
// JSON {title, body, tag, urgent}. This is what makes a phone pop when a matter is
// reaching or a chat message arrives, without the app being open.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  const title = d.title || "SD Board";
  const opts = {
    body: d.body || "", tag: d.tag || "sd", renotify: true, data: d,
    icon: "icon-192.png", badge: "icon-192.png",
    vibrate: d.urgent ? [250, 120, 250, 120, 250] : [160, 90, 160],
    requireInteraction: !!d.urgent
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
// Tapping a "head to court X" alert focuses the app (or opens it).
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of cs) { if ("focus" in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow("./board.html");
  })());
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url), host = url.hostname;
  // Live data — always straight to network, never cache.
  if (host.endsWith("workers.dev") || host.includes("firestore") ||
      host.includes("identitytoolkit") || host.includes("securetoken") ||
      host.includes("firebaseio") || host.includes("firebaseinstallations")) return;
  // Board HTML — NETWORK-FIRST so fixes go live immediately; cache is the offline fallback.
  const isHTML = req.mode === "navigate"
    || (url.origin === location.origin && (url.pathname.endsWith(".html") || url.pathname.endsWith("/")));
  if (isHTML) {
    e.respondWith(
      fetch(req).then(r => {
        if (r && r.status === 200) caches.open(CACHE).then(c => c.put(req, r.clone()));
        return r;
      }).catch(() => caches.match(req).then(m => m || caches.match("./board.html")))
    );
    return;
  }
  // Libraries + fonts + icons (immutable, versioned) — cache-first for speed.
  // status 0 = opaque cross-origin (fonts / firebase SDK) — cache those too.
  const isStatic = url.origin === location.origin
    || host === "www.gstatic.com"      // firebase SDK
    || host === "fonts.googleapis.com" // font CSS
    || host === "fonts.gstatic.com"    // font files
    || host === "cdn.jsdelivr.net";    // tabler icons
  if (!isStatic) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    const net = fetch(req).then(r => { if (r && (r.status === 200 || r.status === 0)) cache.put(req, r.clone()); return r; })
                          .catch(() => hit);
    return hit || net;
  })());
});
