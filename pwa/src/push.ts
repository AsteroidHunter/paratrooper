// Web-push permission and subscription state.
//
// The important boundary in this module is action(): when the popup's Enable
// button calls it, requestPermission is the first browser-facing operation.
// The VAPID public key has already been loaded by check(), so the native prompt
// stays on that tap's user-activation stack (required by iOS).

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
