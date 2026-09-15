// The settings drawer, and the swipe that opens it.
//
// On the phone the transcript owns the whole screen, so the controls have to
// live somewhere that costs the transcript nothing: a panel off the right edge
// that a leftward swipe pulls in and a rightward one pushes back. The gesture
// is the only way in there, which makes the rule it is decided by the whole
// design, because the same finger on the same glass is also how the thread is
// scrolled and how the spring is fed.
//
// THE RULE, in one place, in px and in ratios:
//
//   - the finger must travel COMMIT_PX (24) in the wanted direction: left to
//     open, right to close;
//   - at that moment the horizontal travel must be at least DOMINANCE (2) times
//     the vertical one, so a diagonal flick that is mostly a scroll is not a
//     swipe;
//   - a gesture that has gone DROP_PX (24) vertically while vertical still
//     leads is dropped for good, so a long scroll that wanders sideways at the
//     end cannot turn into a swipe;
//   - until one of those happens the verdict is "wait": nothing is opened,
//     nothing is cancelled, and the thread keeps the gesture.
//
// Two more rules that are not about px and matter just as much:
//
//   - a touch that lands on a control inside the panel (a slider, the picker, a
//     button, the export box) is never a closing swipe. Dragging a slider IS a
//     horizontal gesture, and a slider that shut the panel every time it was
//     dragged would make the panel unusable;
//   - none of this runs unless the drawer layout is actually in force. On a wide
//     screen the panel is a column that is already on screen and there is
//     nothing to reveal.

/** how far the finger must travel in the wanted direction before it counts */
export const COMMIT_PX = 24;
/** how much the horizontal travel must beat the vertical one at that moment */
export const DOMINANCE = 2;
/** vertical travel, with vertical leading, that gives the gesture to the scroll */
export const DROP_PX = 24;

/** the media the drawer exists in: a narrow screen, or the installed app.
    tool.css carries the same two conditions on the layout itself. */
export const DRAWER_MEDIA = "(max-width: 900px), (display-mode: standalone)";

export type Verdict = "wait" | "commit" | "drop";

/**
 * One swipe, judged from where the finger landed.
 *
 * @param dx   horizontal travel since the finger landed, px; leftward is negative
 * @param dy   vertical travel since then, px
 * @param want -1 for the leftward swipe that opens, +1 for the rightward one that closes
 */
export function swipeVerdict(dx: number, dy: number, want: -1 | 1): Verdict {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // plainly a scroll: hand it back and do not look again this gesture
  if (ay >= DROP_PX && ay > ax) return "drop";
  if (dx * want >= COMMIT_PX && ax >= DOMINANCE * ay) return "commit";
  return "wait";
}

/** a touch that lands on one of these is working the control, not swiping */
const CONTROL = "input, select, textarea, button, a, label";

export function onControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTROL) !== null;
}

export interface DrawerParts {
  /** the drawer */
  panel: HTMLElement;
  /** the sheet behind it, shown only while it is open */
  scrim: HTMLElement;
  /** the pointer-only button; its label and aria-expanded follow the state */
  toggle: HTMLButtonElement;
  /** the visible close control inside the drawer */
  close: HTMLButtonElement;
  /** the phone canvas: an opening swipe has to start on it */
  canvas: HTMLElement;
  /** the opening swipe won, so whatever the thread had begun is not a scroll */
  onOpen(): void;
}

export interface Drawer {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function mountDrawer(parts: DrawerParts): Drawer {
  let open = false;

  const paint = (): void => {
    document.body.classList.toggle("panelopen", open);
    parts.scrim.hidden = !open;
    parts.toggle.setAttribute("aria-expanded", String(open));
    parts.toggle.textContent = open ? "Hide controls" : "Controls";
  };

  const setOpen = (next: boolean): void => {
    if (open === next) return;
    open = next;
    paint();
  };

  parts.toggle.addEventListener("click", () => setOpen(!open));
  parts.close.addEventListener("click", () => setOpen(false));
  parts.scrim.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  });

  // --- the swipe --------------------------------------------------------------
  const drawerLayout = window.matchMedia(DRAWER_MEDIA);
  let live = false;
  let want: -1 | 1 = -1;
  let x0 = 0;
  let y0 = 0;

  const begin = (e: TouchEvent): void => {
    live = false;
    if (!drawerLayout.matches) return; // the panel is a column: nothing to reveal
    if (e.touches.length !== 1) return; // a pinch is not a swipe
    const touch = e.touches[0];
    const inPanel = parts.panel.contains(e.target as Node);
    if (open) {
      // only the panel can be swiped shut, and only where it is not a control
      if (!inPanel || onControl(e.target)) return;
      want = 1;
    } else {
      if (inPanel) return; // the closed panel is off screen; ignore what is left of it
      if (!parts.canvas.contains(e.target as Node)) return;
      want = -1;
    }
    live = true;
    x0 = touch.clientX;
    y0 = touch.clientY;
  };

  const carry = (e: TouchEvent): void => {
    if (!live) return;
    const touch = e.touches[0];
    if (!touch) return;
    const verdict = swipeVerdict(touch.clientX - x0, touch.clientY - y0, want);
    if (verdict === "wait") return;
    live = false;
    if (verdict === "drop") return;
    if (want === -1) {
      setOpen(true);
      parts.onOpen(); // the thread's gesture ends here, so nothing trails a swipe
    } else {
      setOpen(false);
    }
  };

  const finish = (): void => {
    live = false;
  };

  // passive: the swipe never calls preventDefault. The thread is pan-y, so a
  // horizontal finger scrolls nothing, and the spring is stood down through
  // onOpen rather than by blocking the browser's own gesture.
  document.addEventListener("touchstart", begin, { passive: true });
  document.addEventListener("touchmove", carry, { passive: true });
  document.addEventListener("touchend", finish, { passive: true });
  document.addEventListener("touchcancel", finish, { passive: true });

  // a rotation or a window that grows out of the drawer layout leaves the body
  // class behind, and with it a panel that is a column AND has a scrim over it
  drawerLayout.addEventListener("change", () => {
    if (!drawerLayout.matches) setOpen(false);
  });

  paint();
  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
  };
}
