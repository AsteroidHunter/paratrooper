// The iOS home-screen launch image, painted for THIS device at runtime.
//
// An installed web app on iOS shows a launch image only through
// <link rel="apple-touch-startup-image">, and each tag's media query has to
// match the device's exact pixel size — there is no fixed set of images that
// covers every iPhone, so the standard fix is to paint one on load. We draw the
// logo art (a full-res cut-out of the same trooper the top bar shows, served as
// /splash-logo.png), centered on white with the handle in faint grey near the
// bottom edge, onto a canvas sized to the current screen in device pixels, then
// inject a link whose media query targets this device. Android builds its
// splash from the manifest and every non-iOS browser ignores these tags, so we
// only do the work on iOS.
//
// Same shape as the shell module: a pure geometry core (unit-tested, no DOM)
// beneath a thin canvas/DOM layer.
import { SPLASH_LOGO_H, SPLASH_LOGO_INLINE, SPLASH_LOGO_W } from "./splashlogo";

// The logo's longer side spans this fraction of the screen's SHORTER edge; the
// logo's other side and its centered position are then derived from the logo's
// own aspect ratio and the device's pixel size. This is the only tuned number
// here — every pixel below comes from it, the screen size, and the logo.
export const SPLASH_LOGO_FRACTION = 0.32;

// The credit line under the logo. Both of its numbers are fractions of the
// SAME shorter edge the logo's box is measured against, so the handle grows and
// shrinks with the screen exactly the way the logo does and the two splashes
// cannot drift apart on one device and not another. Measuring the bottom gap
// against the shorter edge rather than the height is deliberate: a credit line
// wants to sit a constant distance off the bottom, not further down the taller
// the phone is.
export const SPLASH_HANDLE = "@theonetrueakash";
export const SPLASH_HANDLE_FRACTION = 0.035; // font size / shorter edge
export const SPLASH_HANDLE_BOTTOM_FRACTION = 0.12; // bottom edge -> the text's middle

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
  handleFont: number; // device px, the credit line's font size
  handleCenterX: number; // device px, the credit line's horizontal middle
  handleCenterY: number; // device px, the credit line's vertical middle
  media: string; // the apple-touch-startup-image media query for this device
}

// pure: screen + dpr + logo aspect -> the exact device-pixel canvas, the
// centered logo rect, the credit line's size and anchor, and the
// device-matching media query. No DOM, no canvas.
export function splashLayout(inp: SplashInput): SplashLayout {
  const canvasW = Math.round(inp.screenW * inp.dpr);
  const canvasH = Math.round(inp.screenH * inp.dpr);
  const shortEdge = Math.min(canvasW, canvasH);
  const box = shortEdge * SPLASH_LOGO_FRACTION; // logo's bounding square
  // contain-fit the aspect ratio inside that square: the longer side lands on
  // `box`, the shorter side scales down with the ratio
  const logoW = inp.logoAspect >= 1 ? box : box * inp.logoAspect;
  const logoH = inp.logoAspect >= 1 ? box / inp.logoAspect : box;
  const logoX = (canvasW - logoW) / 2;
  const logoY = (canvasH - logoH) / 2;
  // Whole device pixels for the type size, unlike the logo's rect: this canvas
  // is rasterized once at exactly these pixels and never resampled, and the
  // font readback below can only prove a shorthand parsed if the size it hands
  // back is the size we asked for.
  const handleFont = Math.round(shortEdge * SPLASH_HANDLE_FRACTION);
  const handleCenterX = canvasW / 2;
  const handleCenterY = canvasH - shortEdge * SPLASH_HANDLE_BOTTOM_FRACTION;
  const orientation = inp.screenW <= inp.screenH ? "portrait" : "landscape";
  const media =
    `(device-width: ${inp.screenW}px) and (device-height: ${inp.screenH}px) ` +
    `and (-webkit-device-pixel-ratio: ${inp.dpr}) and (orientation: ${orientation})`;
  return {
    canvasW,
    canvasH,
    logoX,
    logoY,
    logoW,
    logoH,
    handleFont,
    handleCenterX,
    handleCenterY,
    media,
  };
}

// the slice of CanvasRenderingContext2D we touch — narrowed so the draw step can
// run against a recording stand-in in tests, no real canvas needed
export interface DrawTarget {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
}

// the launch image's background, single-sourced: the in-app cover below is a
// panel of this same white, and the inlined art the cover shows is flattened
// onto it, so the handoff between the two is one continuous colour
export const SPLASH_BG = "#ffffff";

// The chat's own family list, restated (styles.css sets the same one on body).
// It has to live here as a string because the canvas needs it in JS and reading
// it back off the stylesheet would mean a computed-style read, which is exactly
// the kind of waiting the cover exists to avoid. Every name in it is a system
// face, so there is nothing to fetch and nothing to load-check on either side:
// the canvas can draw the moment it is asked to and the cover inherits a font
// that is already there. Keep in step with styles.css if that list ever moves.
export const SPLASH_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif';

// Tried in order against a real 2D context, best first. A context runs the font
// shorthand through the CSS parser and drops the WHOLE declaration if any part
// of it fails to parse, leaving the context on its previous font — so a stack a
// browser dislikes does not degrade, it silently paints the credit line in the
// canvas default (10px sans-serif) at the wrong size. The two fallbacks are the
// same typeface asked for in plainer words: system-ui resolves to the very face
// -apple-system names, and sans-serif is whatever is left.
export const SPLASH_FONT_LADDER = [SPLASH_FONT_FAMILY, "system-ui", "sans-serif"];

// A quiet credit, not a label: Apple's systemGray2, one step fainter than the
// grey the app's own secondary text uses (--muted, #8e8e93). Written out rather
// than taken from that CSS variable because the cover is styled inline for the
// first frame, and because both splashes are white in either colour scheme
// while --muted flips with the scheme.
export const SPLASH_HANDLE_COLOR = "#aeaeb2";

// Put the credit line's font on a 2D context and hand back what the context
// actually holds afterwards. Each rung is assigned and then read back, and the
// size coming back is the proof the shorthand parsed at all (see the ladder
// above); the last rung is returned whether it took or not, since by then there
// is nothing plainer left to ask for.
export function applySplashFont(ctx: Pick<DrawTarget, "font">, px: number): string {
  for (const family of SPLASH_FONT_LADDER) {
    ctx.font = `${px}px ${family}`;
    if (ctx.font.includes(`${px}px`)) break;
  }
  return ctx.font;
}

// paint solid white, then the logo centered, then the credit line near the
// bottom — pure drawing over a 2D-context-shaped target; the caller owns the
// canvas the target writes to.
export function paintSplash(ctx: DrawTarget, logo: CanvasImageSource, g: SplashLayout): void {
  ctx.fillStyle = SPLASH_BG;
  ctx.fillRect(0, 0, g.canvasW, g.canvasH);
  ctx.drawImage(logo, g.logoX, g.logoY, g.logoW, g.logoH);
  // Anchored by its middle on both axes. "middle" is the point half the font's
  // ascent-minus-descent above the baseline, which is the same point CSS puts
  // at the middle of a line box, and that correspondence is the whole reason
  // the cover below can land its copy of this text on the same spot without
  // measuring a single glyph.
  applySplashFont(ctx, g.handleFont);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = SPLASH_HANDLE_COLOR;
  ctx.fillText(SPLASH_HANDLE, g.handleCenterX, g.handleCenterY);
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

export interface CoverHandleBox {
  top: number; // CSS px from the cover's top edge to the line box's top
  height: number; // CSS px, the line box: set it as the line-height, nothing else
  fontPx: number; // CSS px
}

// pure: the launch image's device-pixel credit line, restated in the cover's
// CSS pixels, by the same canvas-to-screen ratio coverLogoRect() uses and for
// the same reason. Only the vertical axis converts: the canvas centers the text
// on canvasW/2 and the cover spans the same screen, so a full-width box with
// centered text lands on that column by construction.
//
// The canvas draws from the text's middle and CSS draws from a box's top, so
// the middle is handed over as top-plus-half-a-line-box. That works because a
// line box's middle sits exactly where the canvas's "middle" baseline sits, so
// as long as the caller sets BOTH the returned top and the returned height (as
// line-height, whatever the font's own metrics would have given), the two
// splashes put the same text on the same row.
export function coverHandleBox(g: SplashLayout, screenH: number): CoverHandleBox {
  const sy = screenH / g.canvasH;
  const fontPx = g.handleFont * sy;
  return { top: g.handleCenterY * sy - fontPx / 2, height: fontPx, fontPx };
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
// the cover enters the page already carrying its logo and its credit line, in
// one mutation, so the first frame that shows the cover is a frame with both of
// them in it. It used to attach as bare white and fetch the art afterwards,
// which put a logo-less white frame between the phone's launch image and this
// one, and that read as a flash of the logo going away and coming back.
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
    // the credit line, from the same layout and in the same mutation as the
    // logo: it is plain text in a font the device already has, so it costs the
    // cover nothing to wait for. Pinned to both side edges and centered inside
    // that, which is the CSS way of saying the canvas's canvasW/2; the box's
    // height is the line-height coverHandleBox() asks for, and the pair of them
    // is what puts this text on the row the phone's launch image drew it on.
    const handleBox = coverHandleBox(layout, screenH);
    const handle = document.createElement("div");
    handle.textContent = SPLASH_HANDLE;
    handle.style.cssText =
      `position:absolute;left:0;right:0;text-align:center;` +
      `top:${handleBox.top}px;` +
      `font:${handleBox.fontPx}px/${handleBox.height}px ${SPLASH_FONT_FAMILY};` +
      `color:${SPLASH_HANDLE_COLOR};`;
    el.appendChild(handle);
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
