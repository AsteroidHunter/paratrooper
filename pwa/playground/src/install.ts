// The page's own service worker, registered at its own scope.
//
// Two workers live on this origin. The app's (pwa/public/sw.js) is registered
// at "/" and answers every navigation with the cached app shell, which is
// exactly what a phone with the chat app installed would have done to this page
// as well. It now returns early for anything under /playground, so the first
// visit reaches the network and this file; after that the worker below controls
// this folder, because a client is taken by the most specific scope that covers
// it and "/playground/" is more specific than "/".
//
// Nothing here is derived from a constant written twice: the scope is the folder
// this document was served from, so the page works under whatever base it was
// built with, and the build stamp vite defines is carried in the script's query
// so that a new deploy is a new worker with a new cache rather than the last
// build's bundle served out of the old one.

declare const __PLAYGROUND_BUILD__: string;

export function registerPlaygroundWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  const scope = new URL("./", document.baseURI);
  const script = new URL(`sw.js?v=${__PLAYGROUND_BUILD__}`, scope);
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(script.href, { scope: scope.href }).catch(() => {
      /* offline opens and the Home Screen icon are best-effort, as in the app */
    });
  });
}
