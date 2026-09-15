// The playground's service worker. It is the app worker's discipline applied to
// one folder: the page opens from its own cache while a background fetch
// refreshes it, its assets cache on first fetch, and a new build gets a new
// cache instead of the old one.
//
// What is deliberately different from pwa/public/sw.js:
//
//   - IT NEVER LOOKS OUTSIDE ITS OWN FOLDER. A worker sees every request its
//     clients make, including the app's icons at the site root, so the first
//     thing the fetch handler does is hand back anything that is not under this
//     scope. The app's worker owns "/" and this one owns "/playground/"; a
//     client is controlled by the most specific scope that covers it, so the two
//     never answer the same request.
//   - IT ONLY EVER DELETES ITS OWN CACHES. CacheStorage is per ORIGIN, not per
//     scope, so a sweep of every key would take the app's shell with it.
//   - there is no push, no badge and no subscription repair: this page has no
//     backend, sends nothing and asks for no permission.
//
// The cache name carries the build stamp the page registered this script with
// (src/install.ts), so a deploy activates a worker whose cache is empty and
// whose first navigation therefore comes from the network.
const BUILD = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `playground-${BUILD}`;
/** the folder this worker was served from, with its trailing slash */
const SCOPE = new URL("./", self.location.href).pathname;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith("playground-") && k !== CACHE).map((k) => caches.delete(k))
        )
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // not ours: the app's icons, another origin, /api, /ws, the app itself
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (request.method !== "GET") return;

  if (request.mode === "navigate") {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(SCOPE).then((cached) => {
          const fresh = fetch(request)
            .then((resp) => {
              if (resp.ok) cache.put(SCOPE, resp.clone());
              return resp;
            })
            .catch(() => cached ?? Response.error());
          return cached ?? fresh; // the stored page paints NOW; network refreshes behind
        })
      )
    );
    return;
  }

  // assets: cache-first, populated on first fetch, so opens and offline work
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((resp) => {
            if (resp.ok) cache.put(request, resp.clone());
            return resp;
          })
      )
    )
  );
});
