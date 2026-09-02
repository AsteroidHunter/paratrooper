// Web-push permission and subscription state.
//
// The important boundary in this module is action(): when the popup's Enable
// button calls it, requestPermission is the first browser-facing operation.
// The VAPID public key has already been loaded by check(), so the native prompt
// stays on that tap's user-activation stack (required by iOS).

// The other half of this module is the rotation bookkeeping at the bottom: the
// address a push goes to can change while the app is closed, so every
// registration names the address it replaces, and the service worker is left a
// copy of what it needs to do the same repair on its own.

export type PushPermission = "default" | "denied" | "granted";

export type PushState =
  | { kind: "hidden" }
  | { kind: "checking" }
  | { kind: "enable" }
  | { kind: "requesting" }
  | { kind: "active" }
  | { kind: "denied" }
  | { kind: "retry" };

export interface PushDependencies<Subscription> {
  supported(): boolean;
  permission(): PushPermission;
  requestPermission(): Promise<PushPermission>;
  loadPublicKey(): Promise<string | null>;
  getSubscription(): Promise<Subscription | null>;
  subscribe(publicKey: string): Promise<Subscription>;
  registerSubscription(subscription: Subscription): Promise<void>;
  render(state: PushState): void;
}

export interface PushSetup {
  /** Check and repair state without ever opening a native permission prompt. */
  check(): Promise<void>;
  /** Run the popup's primary action. Deliberately synchronous for iOS activation. */
  action(): void;
  /** Hide Paratrooper's popup for this controller/page session only. */
  dismiss(): void;
  /** Invalidate pending work when the authenticated session ends. */
  stop(): void;
  state(): PushState;
}

export function createPushSetup<Subscription>(
  deps: PushDependencies<Subscription>,
): PushSetup {
  let current: PushState = { kind: "hidden" };
  let publicKey: string | null = null;
  let generation = 0;
  let stopped = false;
  let dismissed = false;

  const live = (mine: number): boolean => !stopped && mine === generation;

  const show = (next: PushState, mine = generation): void => {
    if (!live(mine)) return;
    // Not Now suppresses only Paratrooper's own prompt states. Checks keep
    // running, and active/granted repair is never suppressed, so changing
    // permission in iPhone Settings during this page session still converges.
    const promptSuppressed = dismissed && ["enable", "denied", "retry"].includes(next.kind);
    const visible: PushState = promptSuppressed ? { kind: "hidden" } : next;
    current = visible;
    deps.render(visible);
  };

  const permissionNow = (): PushPermission | null => {
    try {
      return deps.permission();
    } catch {
      return null;
    }
  };

  const showSetupFailure = (mine: number): void => {
    if (!live(mine)) return;
    show(permissionNow() === "denied" ? { kind: "denied" } : { kind: "retry" }, mine);
  };

  const ensureSubscription = async (mine: number, key: string): Promise<void> => {
    try {
      let subscription = await deps.getSubscription();
      if (!live(mine)) return;
      if (!subscription) subscription = await deps.subscribe(key);
      if (!live(mine)) return;
      await deps.registerSubscription(subscription);
      show({ kind: "active" }, mine);
    } catch {
      showSetupFailure(mine);
    }
  };

  const handlePermission = async (
    permission: PushPermission,
    mine: number,
    key: string,
    fromNativeRequest = false,
  ): Promise<void> => {
    if (!live(mine)) return;
    if (permission === "denied") {
      // Apple's Do Not Allow sheet is already a complete answer. Do not reveal
      // a second Paratrooper dialog underneath it as soon as it closes. A later
      // app open/check can show the single Settings explanation directly.
      if (fromNativeRequest) dismissed = true;
      show(fromNativeRequest ? { kind: "hidden" } : { kind: "denied" }, mine);
      return;
    }
    if (permission === "default") {
      // Dismissing the native sheet is not permanent: leave Enable available
      // for another deliberate tap, without prompting again on our own.
      show({ kind: "enable" }, mine);
      return;
    }
    await ensureSubscription(mine, key);
  };

  const check = async (): Promise<void> => {
    // The native sheet can make the page visible while its promise is still
    // settling. A resume check must not supersede the user's in-flight choice.
    if (stopped || current.kind === "requesting") return;

    // If a granted-state repair already failed, a temporary key-route outage
    // must not erase its Retry control. Initial key discovery still stays
    // quiet because we cannot claim the server has configured push yet.
    const preserveRetry = current.kind === "retry";
    const mine = ++generation;
    publicKey = null;
    if (!deps.supported()) {
      show({ kind: "hidden" }, mine);
      return;
    }
    show({ kind: "checking" }, mine);

    let key: string | null;
    try {
      key = await deps.loadPublicKey();
    } catch {
      // We cannot truthfully offer notification setup until the server has
      // confirmed a key. A later visibility/open check retries this quietly;
      // an already-earned setup Retry remains available meanwhile.
      show(preserveRetry ? { kind: "retry" } : { kind: "hidden" }, mine);
      return;
    }
    if (!live(mine)) return;
    if (!key) {
      // A null public key is the server's feature-off signal.
      show({ kind: "hidden" }, mine);
      return;
    }
    publicKey = key;

    const permission = permissionNow();
    if (!permission) {
      show(preserveRetry ? { kind: "retry" } : { kind: "hidden" }, mine);
      return;
    }
    await handlePermission(permission, mine, key);
  };

  const requestFromGesture = (): void => {
    const key = publicKey;
    if (current.kind !== "enable" || !key) return;
    const mine = ++generation;

    // Keep this as the first call. No fetch, await, render, or other async
    // boundary may stand between the Enable tap and the browser permission API.
    let answer: Promise<PushPermission>;
    try {
      answer = deps.requestPermission();
    } catch {
      show({ kind: "enable" }, mine);
      return;
    }
    show({ kind: "requesting" }, mine);
    void answer.then(
      (permission) => handlePermission(permission, mine, key, true),
      () => show({ kind: "enable" }, mine),
    );
  };

  const action = (): void => {
    if (current.kind === "enable") {
      requestFromGesture();
      return;
    }
    if (current.kind === "retry") void check();
  };

  const dismiss = (): void => {
    if (!["enable", "denied", "retry"].includes(current.kind)) return;
    dismissed = true;
    show({ kind: "hidden" });
  };

  const stop = (): void => {
    generation++;
    stopped = true;
    publicKey = null;
    current = { kind: "hidden" };
    deps.render(current);
  };

  return { check, action, dismiss, stop, state: () => current };
}

// --- endpoint rotation -------------------------------------------------------
//
// A push endpoint is where the server sends; the phone can be handed a NEW one
// at any time, including while the app is closed. Nothing in a subscription
// tells the server that a new address and an old row are the same device, so a
// plain add left both rows standing — and the old one is not visibly dead:
// Apple accepts pushes to a rotated-away address with 201 and displays nothing.
// The result was a whole run of results delivered nowhere, and afterwards every
// result sent twice.
//
// So the client names the address it is replacing. Two callers do it. The page
// (registerBody below) remembers its last registered endpoint in localStorage
// and sends it as `replaces` on the next registration. The service worker does
// the same from its pushsubscriptionchange handler — but a worker cannot read
// localStorage and cannot call the authenticated key route, so the page mirrors
// the VAPID key, the app token and the current endpoint into IndexedDB here,
// at every successful registration, and the worker reads that one record.
//
// Every step is best-effort. A device with no stored record, a browser that
// refuses IndexedDB, a rotation event that never fires: all of them fall back
// to what already worked, which is the next app open re-registering.

const ENDPOINT_KEY = "paratrooper_push_endpoint";

/** Names shared with public/sw.js, which reads this record without importing. */
export const PUSH_LINK_DB = "paratrooper-push";
export const PUSH_LINK_STORE = "link";
export const PUSH_LINK_ID = "current";

/** What the worker needs to re-register on its own, with no page running. */
export interface PushLink {
  key: string; // VAPID public key (applicationServerKey), base64url
  token: string; // the app bearer token, for the authenticated POST
  endpoint: string; // the address currently registered, the next `replaces`
}

/** The endpoint this page last told the server about, if any. */
export function lastRegisteredEndpoint(): string | null {
  try {
    return localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null; // private mode can refuse storage outright
  }
}

/** Remember an endpoint the server has now accepted. */
export function rememberRegisteredEndpoint(endpoint: string): void {
  try {
    localStorage.setItem(ENDPOINT_KEY, endpoint);
  } catch {
    /* losing the memo only costs the next registration its `replaces` */
  }
}

/**
 * The JSON body for POST /api/push/subscribe: the subscription itself, plus
 * `replaces` when this registration supersedes a different address.
 *
 * JSON round-trip rather than a spread — a real PushSubscription keeps endpoint
 * and keys on its prototype and only surrenders them through toJSON().
 * Registering an UNCHANGED endpoint sends no `replaces`; it is an upsert of the
 * row that is already there, and naming itself would ask the server to delete
 * the row it just wrote.
 */
export function registerBody(subscription: unknown, replaces: string | null): string {
  const body = JSON.parse(JSON.stringify(subscription)) as Record<string, unknown>;
  if (replaces && replaces !== body.endpoint) body.replaces = replaces;
  return JSON.stringify(body);
}

function openLinkDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(PUSH_LINK_DB, 1);
    } catch {
      resolve(null); // private mode can throw synchronously on open
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PUSH_LINK_STORE)) {
        db.createObjectStore(PUSH_LINK_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * Leave the worker what it needs to survive a rotation with no page running.
 *
 * Its own database, in threadcache.ts's mold: a version bump here must never
 * fail another module's open. Resolves when the write commits, and resolves
 * quietly on every failure — the page's registration already succeeded.
 */
export async function savePushLink(link: PushLink): Promise<void> {
  const db = await openLinkDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(PUSH_LINK_STORE, "readwrite");
    } catch {
      resolve();
      return;
    }
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
    try {
      transaction.objectStore(PUSH_LINK_STORE).put({ id: PUSH_LINK_ID, ...link });
    } catch {
      resolve();
    }
  });
}
