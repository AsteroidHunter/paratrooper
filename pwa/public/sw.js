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
  // One waitUntil around the whole chain: the client lookup is async, so the
  // worker must stay alive from the visibility check through the notification.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Reading the app already puts the message on screen. A banner and a badge
      // on top of that are noise, so a visible window suppresses both — and the
      // unread count stays put so the badge never counts a message you just read.
      if (clients.some((client) => client.visibilityState === "visible")) return undefined;
      unread += 1;
      return Promise.all([
        self.registration.showNotification("New message", {
          body,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
        }),
        "setAppBadge" in navigator ? navigator.setAppBadge(unread).catch(() => {}) : Promise.resolve(),
      ]);
    })
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "badge-clear") {
    unread = 0;
    if ("clearAppBadge" in navigator) navigator.clearAppBadge().catch(() => {});
    // Same moment, same reasoning as the badge: the thread is on screen, so the
    // banners nobody tapped are stale. iOS parks them in Notification Center and
    // on the lock screen until something closes them, and closing is what
    // getNotifications + close() do — no tag filter, which would only narrow the
    // list. Best-effort like the badge calls; WebKit refuses to close a
    // notification younger than 30s, so a just-arrived one simply stays.
    if ("getNotifications" in self.registration) {
      self.registration
        .getNotifications()
        .then((notifications) => {
          for (const notification of notifications) notification.close();
        })
        .catch(() => {});
    }
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

// --- push address rotation ---------------------------------------------------
// The phone can be handed a NEW push endpoint at any time, including while the
// app is closed. Until something re-registers, the server keeps sending to the
// old address — and that failure is silent: Apple accepts a push to a
// rotated-away address with 201 and shows nothing, so a whole run of results
// lands nowhere. This handler repairs it at the moment of the rotation.
//
// The worker has no page and no page storage. It cannot read localStorage and
// cannot call the authenticated key route, so src/push.ts writes one IndexedDB
// record at every successful registration — the VAPID key, the app token, and
// the address currently registered — and this reads it. Names must match that
// module's PUSH_LINK_* exports.
//
// Everything here is best-effort, in the same spirit as the badge work above:
// no record (a device that has not opened the app since this shipped), a
// browser that refuses IndexedDB, a rejected subscribe, a failed POST — all of
// them fall through to what has always worked, which is the next app open
// re-registering and naming the address it replaces.
const LINK_DB = "paratrooper-push";
const LINK_STORE = "link";
const LINK_ID = "current";

function openLinkDB() {
  return new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(LINK_DB, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LINK_STORE)) {
        db.createObjectStore(LINK_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function readLink(db) {
  return new Promise((resolve) => {
    let read;
    try {
      read = db.transaction(LINK_STORE, "readonly").objectStore(LINK_STORE).get(LINK_ID);
    } catch {
      resolve(null);
      return;
    }
    read.onsuccess = () => resolve(read.result ?? null);
    read.onerror = () => resolve(null);
  });
}

// Keep the stored address current, so a SECOND rotation with no app open in
// between still names the right predecessor instead of one already deleted.
function writeLink(db, link) {
  return new Promise((resolve) => {
    let transaction;
    try {
      transaction = db.transaction(LINK_STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
    try {
      transaction.objectStore(LINK_STORE).put(link);
    } catch {
      resolve();
    }
  });
}

// the page's urlBase64ToUint8Array, duplicated because a worker cannot import it
function applicationServerKey(base64) {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const db = await openLinkDB();
        if (!db) return;
        const link = await readLink(db);
        if (!link || !link.key || !link.token) return;
        // The event's own old address is the truth when the browser supplies
        // it; the stored one is the fallback for browsers that do not.
        const replaces = (event.oldSubscription && event.oldSubscription.endpoint) || link.endpoint;
        const fresh =
          event.newSubscription ||
          (await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey(link.key),
          }));
        const body = JSON.parse(JSON.stringify(fresh));
        if (replaces && replaces !== body.endpoint) body.replaces = replaces;
        const response = await fetch("/api/push/subscribe", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${link.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!response || !response.ok) return; // leave the record for the page to fix
        await writeLink(db, { ...link, id: LINK_ID, endpoint: body.endpoint });
      } catch {
        /* the next app open re-registers exactly as it always has */
      }
    })()
  );
});
