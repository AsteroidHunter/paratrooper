// The iOS home-screen launch image, painted for THIS device at runtime.
//
// An installed web app on iOS shows a launch image only through
// <link rel="apple-touch-startup-image">, and each tag's media query has to
// match the device's exact pixel size — there is no fixed set of images that
// covers every iPhone, so the standard fix is to paint one on load. We draw the
// logo art (a full-res cut-out of the same trooper the top bar shows, served as
// /splash-logo.png), centered on white, onto a canvas sized to the
// current screen in device pixels, then inject a link whose media query targets
// this device. Android builds its splash from the manifest and every non-iOS
// browser ignores these tags, so we only do the work on iOS.
//
// Same shape as the shell module: a pure geometry core (unit-tested, no DOM)
// beneath a thin canvas/DOM layer.
import { SPLASH_LOGO_H, SPLASH_LOGO_INLINE, SPLASH_LOGO_W } from "./splashlogo";

// The logo's longer side spans this fraction of the screen's SHORTER edge; the
// logo's other side and its centered position are then derived from the logo's
// own aspect ratio and the device's pixel size. This is the only tuned number
// here — every pixel below comes from it, the screen size, and the logo.
export const SPLASH_LOGO_FRACTION = 0.32;

export interface SplashInput {
  screenW: number; // CSS px, screen.width
  screenH: number; // CSS px, screen.height
  dpr: number; // devicePixelRatio
  logoAspect: number; // logo natural width / height
}

export interface SplashLayout {
  canvasW: number; // device px
  canvasH: number; // device px
  logoX: number; // device px, logo's left edge
  logoY: number; // device px, logo's top edge
  logoW: number; // device px
  logoH: number; // device px
  media: string; // the apple-touch-startup-image media query for this device
}

// pure: screen + dpr + logo aspect -> the exact device-pixel canvas, the
// centered logo rect, and the device-matching media query. No DOM, no canvas.
export function splashLayout(inp: SplashInput): SplashLayout {
  const canvasW = Math.round(inp.screenW * inp.dpr);
  const canvasH = Math.round(inp.screenH * inp.dpr);
  const box = Math.min(canvasW, canvasH) * SPLASH_LOGO_FRACTION; // logo's bounding square
  // contain-fit the aspect ratio inside that square: the longer side lands on
  // `box`, the shorter side scales down with the ratio
  const logoW = inp.logoAspect >= 1 ? box : box * inp.logoAspect;
  const logoH = inp.logoAspect >= 1 ? box / inp.logoAspect : box;
  const logoX = (canvasW - logoW) / 2;
  const logoY = (canvasH - logoH) / 2;
  const orientation = inp.screenW <= inp.screenH ? "portrait" : "landscape";
  const media =
    `(device-width: ${inp.screenW}px) and (device-height: ${inp.screenH}px) ` +
    `and (-webkit-device-pixel-ratio: ${inp.dpr}) and (orientation: ${orientation})`;
  return { canvasW, canvasH, logoX, logoY, logoW, logoH, media };
}

// the slice of CanvasRenderingContext2D we touch — narrowed so the draw step can
// run against a recording stand-in in tests, no real canvas needed
export interface DrawTarget {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void;
}

// the launch image's background, single-sourced: the in-app cover below is a
// panel of this same white, and the inlined art the cover shows is flattened
// onto it, so the handoff between the two is one continuous colour
export const SPLASH_BG = "#ffffff";

// paint solid white, then the logo centered — pure drawing over a 2D-context-
// shaped target; the caller owns the canvas the target writes to.
export function paintSplash(ctx: DrawTarget, logo: CanvasImageSource, g: SplashLayout): void {
  ctx.fillStyle = SPLASH_BG;
  ctx.fillRect(0, 0, g.canvasW, g.canvasH);
  ctx.drawImage(logo, g.logoX, g.logoY, g.logoW, g.logoH);
}

// --- DOM/canvas layer ---------------------------------------------------------

// iOS (incl. iPadOS, which reports as a Mac but has a touch screen) or an
// already-installed standalone window — the only places these tags do anything.
function isAppleHomeScreenTarget(nav: Navigator): boolean {
  const ua = nav.userAgent;
  const iOS = /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1);
  const standalone =
    (nav as unknown as { standalone?: boolean }).standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches);
  return iOS || standalone;
}

let started = false; // once per load, no matter how many times we are called

// Paint the launch image for the current device and inject its link. Safe to
// call unconditionally at boot: it no-ops off iOS and after the first call, and
// swallows its own errors — a splash is cosmetic and must never break startup.
// Async only because the logo has to decode before it can be drawn.
export function installStartupImage(logoSrc: string): void {
  if (started) return;
  started = true;
  try {
    if (typeof document === "undefined" || !document.head) return;
    if (!isAppleHomeScreenTarget(navigator)) return;
    const img = new Image();
    img.onload = () => {
      const layout = splashLayout({
        screenW: screen.width,
        screenH: screen.height,
        dpr: window.devicePixelRatio || 1,
        logoAspect: img.naturalWidth / img.naturalHeight || 1,
      });
      const canvas = document.createElement("canvas");
      canvas.width = layout.canvasW;
      canvas.height = layout.canvasH;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      paintSplash(ctx, img, layout);
      const link = document.createElement("link");
      link.rel = "apple-touch-startup-image";
      link.media = layout.media;
      link.href = canvas.toDataURL("image/png");
      document.head.appendChild(link);
    };
    img.src = logoSrc;
  } catch {
    /* cosmetic only: a failed splash must never block boot */
  }
}

// --- the in-app copy of that launch image: the lift rule (pure) ---------------
//
// The image above is the PHONE's, and it is gone the instant the web view is
// handed the page, which is well before the thread has laid out, so the
// handoff shows a bare or half-drawn frame for the rest of the boot. The app
// therefore holds its OWN copy of that same image over its own first frames.
// This is when that copy lifts, and nothing here knows about the DOM: two
// conditions and a cap, driven by the environment's timers exactly like the
// chevron's pause window.
//
//   both of these, then fade: a minimum hold has passed (a launch image that
//   blinks reads as a glitch), and the thread reported itself settled;
//   and above them a hard cap, so a slow or dead network can never strand the
//   cover on screen.

export const COVER_MIN_HOLD_MS = 1000; // held at least this long, however fast the boot
export const COVER_CAP_MS = 2000; // the ceiling on the whole thing: it always lifts
export const COVER_FADE_MS = 260; // short and smooth, not a cut

export type CoverLift = "settled" | "cap";

export interface SplashCover {
  /** the boot's messages are laid out and their images have finished loading */
  settled(): void;
  /** the fade has started (either by the rule or by the cap) */
  lifted(): boolean;
}

// pure: two timers and the settle flag. The lift callback runs exactly once and
// is told which of the two took the cover down, so the wiring can record it.
export function createSplashCover(
  lift: (why: CoverLift) => void,
  minHoldMs: number = COVER_MIN_HOLD_MS,
  capMs: number = COVER_CAP_MS,
): SplashCover {
  let holdPassed = false;
  let threadSettled = false;
  let done = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  function fire(why: CoverLift): void {
    if (done) return; // one lift per load: a settle after the cap is a no-op
    done = true;
    for (const t of timers) clearTimeout(t);
    lift(why);
  }

  function maybeLift(): void {
    if (holdPassed && threadSettled) fire("settled");
  }

  timers.push(
    setTimeout(() => {
      holdPassed = true;
      maybeLift();
    }, minHoldMs),
  );
  timers.push(setTimeout(() => fire("cap"), capMs)); // answers to nothing else

  return {
    settled(): void {
      threadSettled = true;
      maybeLift();
    },
    lifted: () => done,
  };
}

// --- the in-app copy: where its logo sits (pure) -------------------------------

export interface CoverLogoRect {
  left: number; // CSS px from the cover's left edge
  top: number; // CSS px from the cover's top edge
  width: number; // CSS px
  height: number; // CSS px
}

// pure: the launch image's device-pixel logo rect, restated in the CSS pixels
// the cover lays out in. The startup image draws that rect into a canvas of
// canvasW x canvasH device pixels; the cover shows the same rect over a screen
// of screenW x screenH CSS pixels, so the conversion is the canvas-to-screen
// ratio per axis. Deliberately not 1/dpr: splashLayout() rounds the canvas to
// whole device pixels, which can leave the two axes a hair apart, and copying
// the ratio it actually produced is what keeps the logo on the exact spot the
// phone's launch image put it rather than a fraction of a pixel off it.
export function coverLogoRect(g: SplashLayout, screenW: number, screenH: number): CoverLogoRect {
  const sx = screenW / g.canvasW;
  const sy = screenH / g.canvasH;
  return { left: g.logoX * sx, top: g.logoY * sy, width: g.logoW * sx, height: g.logoH * sy };
}

// --- the in-app copy: DOM layer -----------------------------------------------

// A launch image preceded this load only when the app opened as an installed
// window; a browser tab has no handoff to cover, so the copy stays out of one.
function isInstalledWindow(nav: Navigator): boolean {
  return (
    (nav as unknown as { standalone?: boolean }).standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches)
  );
}

// nothing to cover (a browser tab, or no document at all): every call is a
// no-op, so the caller needs no null checks
const NO_COVER: SplashCover = { settled: () => {}, lifted: () => true };

let coverStarted = false; // once per load, like the startup image above

// Mount the app's own copy of the launch image over everything and hand back
// its lift rule. The copy is placed by the SAME splashLayout() the startup
// image is drawn by, on the same inputs, so the phone's image and this one put
// the logo on the same spot by construction rather than by eye. Safe to call
// unconditionally at boot: it no-ops outside an installed window and after the
// first call, and swallows its own errors. The lift timers start with the
// mount, so the copy cannot outlive the cap even if the thread never settles.
//
// The whole thing is built and filled before it is attached to the document:
// the cover enters the page already carrying its logo, in one mutation, so the
// first frame that shows the cover is a frame with the logo in it. It used to
// attach as bare white and fetch the art afterwards, which put a logo-less
// white frame between the phone's launch image and this one, and that read as
// a flash of the logo going away and coming back.
//
// logoSrc is the full-res file the startup image is built from. The cover no
// longer reads it (its art is inlined, see splashlogo.ts) and keeps the
// argument only so both install calls at the boot site still name the same
// picture; it can be dropped whenever that call site is next edited.
export function installSplashCover(
  _logoSrc: string,
  onLift?: (why: CoverLift) => void,
): SplashCover {
  if (coverStarted) return NO_COVER;
  coverStarted = true;
  try {
    if (typeof document === "undefined" || !document.body) return NO_COVER;
    if (!isInstalledWindow(navigator)) return NO_COVER;
    const el = document.createElement("div");
    el.id = "splashcover";
    // inline, not a stylesheet rule: the cover has to be right from the very
    // first frame, before any imported CSS has had to land
    el.style.cssText =
      `position:fixed;inset:0;z-index:40;background:${SPLASH_BG};` +
      `opacity:1;transition:opacity ${COVER_FADE_MS}ms ease;`;
    // the SAME geometry the startup image is built from, on the same inputs:
    // nothing here decides anything about the picture. The aspect comes from
    // the inlined art's own declared size instead of a decoded image's
    // naturalWidth, which is the only reason this no longer has to wait.
    const screenW = screen.width;
    const screenH = screen.height;
    const layout = splashLayout({
      screenW,
      screenH,
      dpr: window.devicePixelRatio || 1,
      logoAspect: SPLASH_LOGO_W / SPLASH_LOGO_H,
    });
    const rect = coverLogoRect(layout, screenW, screenH);
    const logo = document.createElement("img");
    logo.alt = "";
    // decode on the spot rather than whenever the browser gets round to it:
    // the default lets an image present a frame or two after its element does,
    // which is the exact gap this whole change exists to close. Cheap to insist
    // on here because the inlined art is small.
    logo.decoding = "sync";
    // a data URI: no request, no service-worker lookup, nothing that could
    // resolve on a later task than this one
    logo.src = SPLASH_LOGO_INLINE;
    logo.style.cssText =
      `position:absolute;display:block;` +
      `left:${rect.left}px;top:${rect.top}px;` +
      `width:${rect.width}px;height:${rect.height}px;`;
    el.appendChild(logo);
    document.body.appendChild(el);
    const cover = createSplashCover((why) => {
      el.style.pointerEvents = "none"; // the fade must not eat the first tap
      el.style.opacity = "0";
      setTimeout(() => el.remove(), COVER_FADE_MS);
      onLift?.(why);
    });
    return cover;
  } catch {
    return NO_COVER; // cosmetic only: a failed cover must never block boot
  }
}
