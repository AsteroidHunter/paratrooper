// The swipe that opens the settings, and the layout it belongs to.
//
// The rule is a few lines of arithmetic, and it is the only way into the
// controls on a phone, so it is pinned here rather than felt for on a device:
// what commits, what waits, what is handed back to the scroll. The wiring
// around it - which listeners, on what, passive or not - is source-pinned the
// way this repository pins main.ts, because a page that boots a real thread at
// import cannot be loaded under node.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMIT_PX, DOMINANCE, DRAWER_MEDIA, DROP_PX, swipeVerdict } from "../src/drawer";

const drawer = readFileSync(new URL("../src/drawer.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/tool.css", import.meta.url), "utf8");
const wiring = readFileSync(new URL("../src/playground.ts", import.meta.url), "utf8");

describe("the numbers the swipe is decided by", () => {
  it("are the ones the panel was designed around", () => {
    expect(COMMIT_PX).toBe(24);
    expect(DOMINANCE).toBe(2);
    expect(DROP_PX).toBe(24);
  });

  it("a leftward finger opens once it has gone the whole 24 px", () => {
    expect(swipeVerdict(-23.9, 0, -1)).toBe("wait");
    expect(swipeVerdict(-24, 0, -1)).toBe("commit");
    expect(swipeVerdict(-300, 0, -1)).toBe("commit");
  });

  it("but only while it is clearly sideways rather than diagonal", () => {
    // 24 px across and 12 down is exactly the two-to-one the rule asks for
    expect(swipeVerdict(-24, 12, -1)).toBe("commit");
    expect(swipeVerdict(-24, 12.1, -1)).toBe("wait");
    // and a diagonal that keeps going sideways still gets there
    expect(swipeVerdict(-40, 12, -1)).toBe("commit");
  });

  it("a rightward finger never opens it, and a leftward one never closes it", () => {
    expect(swipeVerdict(24, 0, -1)).toBe("wait");
    expect(swipeVerdict(-24, 0, 1)).toBe("wait");
    expect(swipeVerdict(24, 0, 1)).toBe("commit");
  });

  it("a scroll is handed back for good once it has gone 24 px down", () => {
    expect(swipeVerdict(-10, 23, -1)).toBe("wait");
    expect(swipeVerdict(-10, 24, -1)).toBe("drop");
    expect(swipeVerdict(-10, -24, -1)).toBe("drop"); // upward is a scroll too
    // a drop needs vertical to be LEADING: a wide diagonal is still undecided
    expect(swipeVerdict(-30, 25, -1)).toBe("wait");
  });

  it("the finger that has not moved decides nothing", () => {
    expect(swipeVerdict(0, 0, -1)).toBe("wait");
    expect(swipeVerdict(0, 0, 1)).toBe("wait");
  });
});

describe("the gesture cannot take a scroll or a slider away", () => {
  it("every listener it adds is passive: it never blocks the browser's own pan", () => {
    const listeners = [...drawer.matchAll(/document\.addEventListener\("(touch\w+)"[^;]*;/g)];
    expect(listeners.map((m) => m[1])).toEqual([
      "touchstart",
      "touchmove",
      "touchend",
      "touchcancel",
    ]);
    for (const l of listeners) expect(l[0]).toContain("{ passive: true }");
    expect(drawer).not.toMatch(/\.preventDefault\(/);
  });

  it("a touch that lands on a control in the panel is never a closing swipe", () => {
    // dragging a slider IS a horizontal gesture; a panel that shut every time
    // one was dragged would have no usable controls in it
    expect(drawer).toContain('const CONTROL = "input, select, textarea, button, a, label"');
    expect(drawer).toMatch(/if \(!inPanel \|\| onControl\(e\.target\)\) return;/);
  });

  it("a second finger is not a swipe", () => {
    expect(drawer).toContain("if (e.touches.length !== 1) return;");
  });

  it("and the thread's own gesture is lifted the moment the panel wins", () => {
    // the finger was on the transcript until it became a swipe, and the field is
    // still holding the rows behind it
    expect(drawer).toMatch(/setOpen\(true\);\n\s*parts\.onOpen\(\);/);
    expect(wiring).toMatch(/onOpen: \(\) => \{\n\s*liftSpring\(\);/);
  });
});

describe("the layout the drawer lives in", () => {
  it("is the same two conditions in the stylesheet and in the module", () => {
    expect(DRAWER_MEDIA).toBe("(max-width: 900px), (display-mode: standalone)");
    expect(css).toContain("@media (max-width: 900px), (display-mode: standalone) {");
  });

  it("fills the screen with the transcript: no frame, no page scroll, pinned like the app", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 900px), (display-mode: standalone) {"));
    // The shell is pinned by its edges the way the app pins #app, so iOS
    // standalone's dvh / innerHeight misreport can't leave a strip under the
    // composer; the root is the app's 100vh, never the 100dvh the app calls
    // wrong on cold start nor the 100% that letterboxes a bar under
    // viewport-fit=cover. (src/styles.css: "Fixed app shell pinned by inset
    // alone" and "100vh, NOT 100% or 100dvh".)
    const shell = phone.slice(phone.indexOf(".shell {"), phone.indexOf(".stage,"));
    expect(shell).toContain("position: fixed;");
    expect(shell).toContain("inset: 0;");
    expect(phone).toContain("height: 100vh;");
    expect(phone).not.toContain("height: 100dvh");
    expect(phone).toContain("overflow: hidden; /* only the thread scrolls */");
    expect(phone).toContain("overscroll-behavior: none;");
    expect(phone).toContain("border: 0;");
    expect(phone).toContain("box-shadow: none;");
    // the preview sizes do not survive a screen that IS the phone
    for (const frame of ["375", "390", "fill"]) {
      expect(phone).toContain(`.stage[data-frame="${frame}"] .phone`);
    }
  });

  it("reads the phone's real safe areas, which the desktop fixture cannot", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 900px), (display-mode: standalone) {"));
    expect(phone).toContain("--fixture-inset-top: env(safe-area-inset-top, 0px);");
    expect(phone).toContain("--fixture-inset-bottom: env(safe-area-inset-bottom, 0px);");
    // the desktop preview still says zero, and still says why
    expect(css).toContain("--fixture-inset-top: 0px;");
  });

  it("slides the panel in from the right and gives it the sideways finger", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 900px), (display-mode: standalone) {"));
    expect(phone).toContain("transform: translateX(100%);");
    expect(phone).toContain("body.panelopen .panel { transform: none; }");
    expect(phone).toContain("touch-action: pan-y;");
    expect(phone).toContain("overscroll-behavior: contain;");
  });

  it("leaves nothing on the glass for a finger to press by accident", () => {
    // the floating button belongs to a pointer on a narrow window; a touch
    // screen and the installed app have the swipe and the close control
    expect(css).toContain("@media (pointer: coarse), (display-mode: standalone) {");
    const hide = css.slice(css.indexOf("@media (pointer: coarse), (display-mode: standalone) {"));
    expect(hide).toContain(".paneltoggle { display: none; }");
  });

  it("keeps the controls finger-sized inside the drawer", () => {
    const phone = css.slice(css.indexOf("@media (max-width: 900px), (display-mode: standalone) {"));
    expect(phone).toMatch(/\.knob input\[type="range"\] \{\n\s*height: 34px;/);
    expect(phone).toMatch(/\.panelclose \{ min-height: 44px; \}/);
  });

  it("and the desktop column is untouched: 372px, beside the stage", () => {
    const desktop = css.slice(css.indexOf(".panel {"), css.indexOf(".panelbar {"));
    expect(desktop).toContain("width: 372px;");
    expect(desktop).toContain("border-left: 1px solid var(--panel-line);");
    expect(desktop).not.toContain("position: fixed");
  });
});

describe("the page the drawer is on", () => {
  it("has the close control and the sheet that keeps fingers off the thread", () => {
    expect(page).toContain('<button class="panelclose" id="panelclose" type="button">Close</button>');
    expect(page).toContain('<div class="scrim" id="scrim" hidden></div>');
    // the scrim is switched by the attribute alone, so no rule may set display
    expect(css).toMatch(/\.scrim \{[^}]*\}/);
    expect(/\.scrim \{[^}]*display:/.test(css)).toBe(false);
  });

  it("carries no inline script and no inline style anywhere", () => {
    // the service sends script-src 'self' and a style-src whose hashes are read
    // off the APP's index.html, so anything inline in this document is blocked
    expect(page).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(page).not.toMatch(/<style[\s>]/i);
    expect(page).not.toMatch(/\sstyle="/i);
  });

  it("and neither does anything the page builds at runtime", () => {
    for (const name of ["drawer.ts", "controls.ts", "thread.ts", "playground.ts"]) {
      const src = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
      expect(src, name).not.toContain('createElement("style")');
      expect(src, name).not.toContain('setAttribute("style"');
      expect(src, name).not.toContain("innerHTML");
    }
  });
});
