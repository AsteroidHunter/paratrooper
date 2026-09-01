// Service worker — installability, offline app-shell cache, and INSTANT opens:
// navigations serve the locally cached shell immediately (no network wait, no
// white screen) while a background fetch refreshes the cache. Version skew is
// safe because the page compares its build against /api/health and runs the
// update flow (overlay -> cache clear -> warm refetch -> reload) on mismatch.
// Assets cache on first fetch; hashed filenames make new bundles cache-miss.
const SHELL = "paratrooper-shell-v2";

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
      caches.match("/").then((cached) => {
        const fresh = fetch(request)
          .then((resp) => {
            const copy = resp.clone();
            caches.open(SHELL).then((c) => c.put("/", copy));
            return resp;
          })
          .catch(() => cached ?? Response.error());
        return cached ?? fresh; // stored copy paints NOW; network refreshes behind
      })
    );
    return;
  }

  // assets: cache-first, populated on first fetch so opens and offline work
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((resp) => {
          if (resp.ok && url.origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
          }
          return resp;
        })
    )
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
      "setAppBadge" in self.navigator
        ? self.navigator.setAppBadge(unread).catch(() => {})
        : Promise.resolve(),
    ])
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "badge-clear") {
    unread = 0;
    if ("clearAppBadge" in self.navigator) self.navigator.clearAppBadge().catch(() => {});
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
