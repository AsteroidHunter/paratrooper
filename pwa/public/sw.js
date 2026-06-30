// Minimal service worker — enables installability (Add to Home Screen) and an
// offline app-shell cache. Network-first for navigations so updates land; the
// shell is a fallback. (Web push subscription is added in Phase 6.)
const SHELL = "paratrooper-shell-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // never intercept API/socket traffic
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/ws")) return;
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(SHELL).then((c) => c.put("/", copy));
          return resp;
        })
        .catch(() => caches.match("/").then((r) => r ?? Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request))
  );
});
