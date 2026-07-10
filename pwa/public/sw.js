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

// --- web push (Phase 6) ---
// Unread count for the home-screen badge. SW state is ephemeral (the worker
// can be killed between pushes), so the count is best-effort — it resets to 1
// after an eviction rather than persisting through IndexedDB. The page clears
// it on focus.
let unread = 0;

self.addEventListener("push", (event) => {
  const body = event.data ? event.data.text() : "Paratrooper update";
  unread += 1;
  event.waitUntil(
    Promise.all([
      self.registration.showNotification("Paratrooper", {
        body,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
      }),
      "setAppBadge" in navigator ? navigator.setAppBadge(unread).catch(() => {}) : Promise.resolve(),
    ])
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "badge-clear") {
    unread = 0;
    if ("clearAppBadge" in navigator) navigator.clearAppBadge().catch(() => {});
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    })
  );
});
