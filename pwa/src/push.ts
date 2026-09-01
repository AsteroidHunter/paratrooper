// Web-push permission and subscription state.
//
// The important boundary in this module is action(): when the UI says
// "Enable Notifications", requestPermission is its first browser-facing call.
// The VAPID public key has already been loaded by check(), so the native prompt
// stays on the button's user-activation stack (required by iOS) instead of
// sitting behind a fetch.

export type PushPermission = "default" | "denied" | "granted";

export type PushState =
  | { kind: "hidden" }
  | { kind: "checking" }
  | { kind: "enable"; requestFailed?: boolean }
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
  /** Check permission/subscription state without ever opening a native prompt. */
  check(): Promise<void>;
  /** Run the action currently presented by the view. Deliberately synchronous. */
  action(): void;
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

  const live = (mine: number): boolean => !stopped && mine === generation;

  const show = (next: PushState, mine = generation): void => {
    if (!live(mine)) return;
    current = next;
    deps.render(next);
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
  ): Promise<void> => {
    if (!live(mine)) return;
    if (permission === "denied") {
      show({ kind: "denied" }, mine);
      return;
    }
    if (permission === "default") {
      // Dismissing the native sheet is not a permanent failure: the control
      // remains available for another deliberate tap.
      show({ kind: "enable" }, mine);
      return;
    }
    await ensureSubscription(mine, key);
  };

  const check = async (): Promise<void> => {
    // A native permission sheet can make the page visible again while its
    // promise is still settling. Do not let that resume edge supersede the
    // user's in-flight choice.
    if (stopped || current.kind === "requesting") return;

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
      show({ kind: "retry" }, mine);
      return;
    }
    if (!live(mine)) return;
    if (!key) {
      // A null public key is the server's feature-off signal. There must be no
      // permission control when there is nowhere to register a subscription.
      show({ kind: "hidden" }, mine);
      return;
    }
    publicKey = key;

    const permission = permissionNow();
    if (!permission) {
      show({ kind: "retry" }, mine);
      return;
    }
    await handlePermission(permission, mine, key);
  };

  const requestFromGesture = (): void => {
    const key = publicKey;
    if (current.kind !== "enable" || !key) return;
    const mine = ++generation;

    // Do not put a fetch, an await, or any other asynchronous boundary above
    // this call. iOS only presents the permission sheet while this exact click
    // stack still carries transient user activation.
    let answer: Promise<PushPermission>;
    try {
      answer = deps.requestPermission();
    } catch {
      show({ kind: "enable", requestFailed: true }, mine);
      return;
    }
    show({ kind: "requesting" }, mine);
    void answer.then(
      (permission) => handlePermission(permission, mine, key),
      () => show({ kind: "enable", requestFailed: true }, mine),
    );
  };

  const action = (): void => {
    if (current.kind === "enable") {
      requestFromGesture();
      return;
    }
    if (current.kind === "retry") void check();
  };

  const stop = (): void => {
    generation++;
    stopped = true;
    publicKey = null;
    current = { kind: "hidden" };
    deps.render(current);
  };

  return { check, action, stop, state: () => current };
}
