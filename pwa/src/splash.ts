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
//
// The second half of this file is the app's OWN loading page, which is a
// different picture on the same white and is described in index.html. The two
// live together because they are the same event seen from both sides: the phone
// holds the screen until it hands the page over, and the page holds it from
// there until the conversation has finished moving.

// ===================== TEMP DIAGNOSTIC (remove after the cold-open session) =====================
// The white gap, measured instead of reasoned about. On a cold open the phone
// paints its own saved launch image instantly, then hands the web view a page
// with nothing drawn on it at all, and that bare page is the white flash a
// standalone open shows until the cover further down goes up. Both ends of
// that stretch are read here off performance.now(), which counts from the
// moment the page began loading:
//
//   codeStartMs: the bundle is running. Read as this module's first statement,
//     so it carries the fetch and the parse and none of the work the app does
//     afterwards. Nothing earlier is reachable from here: no timing API says
//     when a script BEGINS executing, only when its bytes finished arriving.
//   coverUpMs: the instant the app took the loading page OVER, read where the
//     adoption below returns. It used to be when a panel appeared, back when
//     this module built one; now the page is markup in index.html and is on
//     screen long before this runs, so the stretch from the paint mark to here
//     is time the user spends looking at a page that is already right.
//   htmlDoneMs: the navigation entry's responseEnd, the last byte of the HTML
//     document. Splits that first stretch again, into waiting for the page and
//     then fetching plus parsing the bundle the page asks for.
//   firstPaintMs: the browser's own first-contentful-paint mark, and since the
//     loading page moved into the document, the moment that page appeared. This
//     is the number the move is judged on. It is a browser mark rather than one
//     of ours because the page cannot see its own first paint from inside
//     itself, and it degrades to null wherever paint timing is not reported.
//
// main.ts lands all four on the holddiag boot channel as one boot-blank
// record. TO REMOVE: delete this block, the one assignment inside
// installLoadingScreen below, the boot-blank record in main.ts, the matching
// block at the end of tests/loading.test.ts, and the "boot-blank" names in
// hold.ts and web/app.py.
const CODE_START_MS = performance.now();

// set once, when the loading page is taken over, and left null wherever none
// is adopted at all: a browser tab had no launch image to hand over from,
// so there is no blank stretch of this kind to report on one
let coverUpMs: number | null = null;

// A type alias rather than an interface, which is what lets the result hand
// straight to the trail's Record<string, unknown> field bag with nothing
// restated and nothing copied: only aliases carry the implicit index
// signature that assignment needs.
export type BootBlankGap = {
  codeStartMs: number;
  coverUpMs: number | null;
  htmlDoneMs: number | null;
  firstPaintMs: number | null;
};

// The marks above as whole milliseconds for the caller to record. The two
// browser entries are read here rather than at module time on purpose: both
// are complete long before the adoption mark, so reading them late costs
// nothing and keeps the module's first statement to the one thing it has to
// be. A contentful paint is asked for first and any paint accepted after it,
// since a browser that reports only the plain one still answers the question.
export function bootBlankGap(): BootBlankGap {
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const paints = performance.getEntriesByType("paint");
  const paint = paints.find((e) => e.name === "first-contentful-paint") ?? paints[0];
  return {
    codeStartMs: Math.round(CODE_START_MS),
    coverUpMs: coverUpMs === null ? null : Math.round(coverUpMs),
    htmlDoneMs: nav ? Math.round(nav.responseEnd) : null,
    firstPaintMs: paint ? Math.round(paint.startTime) : null,
  };
}
// =================== END TEMP DIAGNOSTIC (remove after the cold-open session) ===================

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
  // The screen this layout was built for, carried back out in the CSS pixels it
  // came in as. The credit line needs it and cannot go and read it for itself:
  // that line has to be asked for in the screen's unit rather than the canvas's
  // for the reason paintSplash gives.
  screenW: number; // CSS px, as handed in
  screenH: number; // CSS px, as handed in
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
    screenW: inp.screenW,
    screenH: inp.screenH,
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
  // the credit line is drawn through a scale, so these three come with it
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
}

// The launch image's background. The app's own loading page stands on this same
// white, so the phone's dissolve lands on the colour it left and the only thing
// that changes across the handover is what is drawn on it. index.html states
// its own copy of this, because it has to be right before any of this file has
// arrived; the suite is what keeps the two saying the same thing.
export const SPLASH_BG = "#ffffff";

// The chat's own family list, restated (styles.css sets the same one on body).
// It has to live here as a string because the canvas needs it in JS and reading
// it back off a stylesheet would mean a computed-style read, which is exactly
// the kind of waiting a launch must not do. Every name in it is a system face,
// so there is nothing to fetch and nothing to load-check: the canvas can draw
// the moment it is asked to. Keep the two in step if that list ever moves.
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
// than taken from that CSS variable because the launch image is painted before
// any of the app's own CSS has landed, and because it is white in either colour
// scheme while --muted flips with the scheme.
export const SPLASH_HANDLE_COLOR = "#aeaeb2";

// Put the credit line's font on a 2D context and hand back what the context
// actually holds afterwards. Each rung is assigned and then read back, and the
// size coming back is the proof the shorthand parsed at all (see the ladder
// above); the last rung is returned whether it took or not, since by then there
// is nothing plainer left to ask for.
export function applySplashFont(ctx: Pick<DrawTarget, "font">, px: number): string {
  for (const family of SPLASH_FONT_LADDER) {
    ctx.font = `${px}px ${family}`;
    // The size that comes back is read as a NUMBER, not looked for as a piece
    // of the string. The size asked for is the cover's own CSS pixels now (see
    // paintSplash), and those are a repeating fraction on most screens: 41
    // device px over a ratio of 3 is 13.666666666666666, which a browser hands
    // back as "13.6667px". Matching on the text would miss that and walk the
    // whole ladder down to a plain sans-serif, which is the exact failure the
    // ladder exists to prevent. The tolerance only has to tell the size asked
    // for apart from the size a REFUSED shorthand leaves behind, and that is
    // either the canvas default of 10px or a rung that asked for this very
    // number, so a hair is plenty.
    const back = /(\d+(?:\.\d+)?)px/.exec(ctx.font);
    if (back && Math.abs(Number(back[1]) - px) < 0.05) break;
  }
  return ctx.font;
}

// THE ROUTINE THAT DRAWS THE CREDIT LINE onto the launch image.
//
// The point is drawn in DEVICE pixels and the type is asked for in SCREEN
// pixels, through a scale of the canvas-to-screen ratio per axis. paintSplash's
// own comment carries the why of that split; the short version is that the
// system face spaces small type looser than large type, so the size the font
// engine is ASKED for has to be the size the line occupies on the screen,
// whatever device pixels it lands on.
//
// The split is left exactly as it was when the app's first page was a hand copy
// of this picture and the two had to agree glyph for glyph. That page is gone
// and there is no second rasterizer left to match, but every pixel of the
// launch image is decided here, and changing how the type is asked for would
// change the picture the phone stores. So it stays.
export function drawSplashHandle(
  ctx: DrawTarget,
  text: string,
  fontPx: number,
  sx: number,
  sy: number,
  deviceX: number,
  deviceY: number,
): void {
  ctx.save();
  ctx.scale(1 / sx, 1 / sy);
  applySplashFont(ctx, fontPx);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = SPLASH_HANDLE_COLOR;
  ctx.fillText(text, deviceX * sx, deviceY * sy);
  ctx.restore();
}

// paint solid white, then the logo centered, then the credit line near the
// bottom — pure drawing over a 2D-context-shaped target; the caller owns the
// canvas the target writes to.
export function paintSplash(ctx: DrawTarget, logo: CanvasImageSource, g: SplashLayout): void {
  ctx.fillStyle = SPLASH_BG;
  ctx.fillRect(0, 0, g.canvasW, g.canvasH);
  ctx.drawImage(logo, g.logoX, g.logoY, g.logoW, g.logoH);
  // THE CREDIT LINE IS ASKED FOR IN SCREEN PIXELS, NOT THE CANVAS'S.
  //
  // Everything else on this canvas is a rectangle, and a rectangle drawn at
  // three times the size and shown at a third of it is the same picture. Type
  // is not. The system face this app sets its text in carries a tracking table:
  // the SAME string at the same proportion of the screen is measurably wider
  // per em at a small size than at a large one, because small type is spaced
  // loose to stay readable and large type is spaced tight to stay even. Asking
  // a canvas for 39px and asking a stylesheet for 13px on a 3x screen therefore
  // does NOT produce the same line, even though both land on 39 device pixels:
  // measured in this app's own stack, 13px comes out 8.735 em-widths long and
  // 39px comes out 8.091, so the launch image's credit line was about eight
  // percent narrower than the cover's. That is the tag changing size under the
  // user on the handover, and it is invisible on a 1x screen, where the two
  // sizes are the same number, which is why nothing but a real measurement on a
  // real screen would have found it.
  //
  // So the line is asked for at the size it occupies on the SCREEN, which is
  // what splashHandleBox states, and the canvas is scaled to put it on the
  // device pixels the launch image needs. The font engine picks its spacing off
  // the size it is asked for and the scale is applied afterwards. The scale is
  // the canvas-to-screen ratio per axis, inverted, rather than the device pixel
  // ratio: the canvas is rounded to whole device pixels and the screen is
  // stretched onto exactly that, so this is the stretch the phone itself will
  // apply.
  //
  // The anchor is the layout's own, handed over in device pixels for
  // drawSplashHandle to put through the scale, so it lands on the very same
  // device pixel it always did. "middle" is the point half the font's
  // ascent-minus-descent above the baseline, which is the same point CSS puts
  // at the middle of a line box.
  const sx = g.screenW / g.canvasW;
  const sy = g.screenH / g.canvasH;
  drawSplashHandle(
    ctx,
    SPLASH_HANDLE,
    splashHandleBox(g).fontPx,
    sx,
    sy,
    g.handleCenterX,
    g.handleCenterY,
  );
}

export interface SplashHandleBox {
  top: number; // CSS px from the screen's top edge to the line box's top
  height: number; // CSS px, the line box
  fontPx: number; // CSS px
}

// pure: the launch image's device-pixel credit line, restated in the SCREEN's
// own CSS pixels. Only the vertical axis converts: the canvas centers the text
// on canvasW/2, so the horizontal answer is "the middle" and needs no number.
//
// The canvas draws from the text's middle and CSS measures a box from its top,
// so the middle is handed back as top-plus-half-a-line-box, which is the point
// a line box's middle sits at.
//
// This is where the size the launch image sets the line in is decided, and
// paintSplash is the only caller. It reads as a CSS answer because it once was
// one: the app's first page used to restate this picture as live text, and the
// size had to be the size that page would ask a stylesheet for, since the
// system face spaces small type looser than large type. That page is gone. The
// arithmetic stays because it is what the shipped launch image is built from,
// and a launch image that changed size under the user is exactly the artifact
// the change was made to be rid of.
//
// The conversion is the canvas-to-screen ratio rather than a bare 1/dpr:
// splashLayout() rounds the canvas to whole device pixels, which can leave the
// two axes a hair apart, and copying the ratio it actually produced is what
// keeps the line where the phone's own picture puts it. The screen defaults to
// the one the layout was built for, which is the only screen any caller has
// ever passed; naming it stays allowed so the pairing is visible at the call
// site.
export function splashHandleBox(g: SplashLayout, screenH: number = g.screenH): SplashHandleBox {
  const sy = screenH / g.canvasH;
  const fontPx = g.handleFont * sy;
  return { top: g.handleCenterY * sy - fontPx / 2, height: fontPx, fontPx };
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

// --- the app's own loading page: the lift rule (pure) -------------------------
//
// The image above is the PHONE's, and it is gone the instant the web view is
// handed the page, which is well before the thread has laid out, so the
// handover would show a bare or half-drawn frame for the rest of the boot. The
// document therefore carries a loading page of its own, as markup and styles in
// index.html, over the app's first frames. This is when that page lifts, and
// nothing here knows about the DOM: two conditions and a cap, driven by the
// environment's timers exactly like the chevron's pause window.
//
//   both of these, then fade: a minimum hold has passed (a page that blinks
//   reads as a glitch), and the app underneath reported itself settled;
//   and above them a hard cap, so a slow or dead network can never strand the
//   loading page on screen.

export const LOAD_MIN_HOLD_MS = 1000; // held at least this long, however fast the boot
export const LOAD_CAP_MS = 2000; // the ceiling on the whole thing: it always lifts
export const LOAD_FADE_MS = 260; // short and smooth, not a cut

export type LiftReason = "settled" | "cap";

export interface LoadingScreen {
  /** the boot's messages are laid out, their images are in, and nothing is moving */
  settled(): void;
  /** the fade has started (either by the rule or by the cap) */
  lifted(): boolean;
}

// pure: two timers and the settle flag. The lift callback runs exactly once and
// is told which of the two took the page down, so the wiring can record it.
export function createLoadingGate(
  lift: (why: LiftReason) => void,
  minHoldMs: number = LOAD_MIN_HOLD_MS,
  capMs: number = LOAD_CAP_MS,
): LoadingScreen {
  let holdPassed = false;
  let appSettled = false;
  let done = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  function fire(why: LiftReason): void {
    if (done) return; // one lift per load: a settle after the cap is a no-op
    done = true;
    for (const t of timers) clearTimeout(t);
    lift(why);
  }

  function maybeLift(): void {
    if (holdPassed && appSettled) fire("settled");
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
      appSettled = true;
      maybeLift();
    },
    lifted: () => done,
  };
}

// --- when the app underneath has stopped MOVING (pure) ------------------------
//
// Settled used to mean the boot's messages were laid out and their images had
// decoded. That is when the app has finished ARRIVING, and it is not the same
// instant as when the app has finished MOVING. The boot-motion recorder in
// main.ts exists because the two came apart on real cold opens: the thread's
// scrollHeight grew after the cached paint, the bottom pin was re-asserted from
// fresh geometry a frame later, and the layout viewport grew into its real
// height as the safe-area insets appeared. Lifting on arrival meant the user
// watched the tail end of all that, which is the one thing this page exists to
// stand in front of.
//
// So the lift waits for quiet too, and quiet is decided by WATCHING rather than
// by waiting out a number nobody can justify: a few frames in a row in which
// the thread's height, the thread's scroll position and the viewport's height
// all read the same as they did on the frame before, with the scroll sitting
// where it is meant to come to rest. Anything still growing, gliding or
// re-pinning fails one of those and the count starts over.
//
// Two things this deliberately does NOT have. It has no timeout of its own: the
// only ceiling is the cap above, which lifts the page whatever this says and is
// also what ends the watch, since a page that has already gone has nothing left
// to wait for. And it writes nothing. The rest position is READ and compared,
// never asserted, because a scroll write from the one thing that is supposed to
// be proving the app is still would be the app moving again.
//
// The rest position is the bottom, because that is where every boot path puts
// the thread: the cached paint pins it, the first settle of a fresh open pins
// it again once its images are in, and a thread shorter than its own box is at
// the bottom by construction. A boot that somehow came to rest anywhere else
// simply never reports quiet, and the cap takes the page down on time.

export const QUIET_FRAMES = 3; // unchanged frames in a row before the app counts as still
export const QUIET_SLACK_PX = 1; // this far off the rest position is at rest

export interface QuietFrame {
  sh: number; // the thread's scrollHeight
  st: number; // the thread's scrollTop
  ch: number; // the thread's clientHeight
  vh: number; // the viewport's height
}

export interface QuietWatch {
  /** feed one frame's reading; true once the app has been still long enough */
  frame(f: QuietFrame): boolean;
  /** how many frames were fed, for the record the lift lands on the trail */
  seen(): number;
}

// pure: the frame-to-frame comparison, with no clock and no DOM in it.
export function createQuietWatch(need: number = QUIET_FRAMES): QuietWatch {
  let prev: QuietFrame | null = null;
  let still = 0;
  let seen = 0;
  return {
    frame(f: QuietFrame): boolean {
      seen += 1;
      // at the bottom, within the slack a fractional layout leaves behind
      const atRest = f.sh - f.st - f.ch <= QUIET_SLACK_PX;
      // and nothing the eye could catch changed since the frame before. The
      // thread's own box is not compared directly: a box that changed while the
      // height did not moves the rest position, which fails the line above.
      const same =
        prev !== null && f.sh === prev.sh && f.st === prev.st && f.vh === prev.vh;
      still = same && atRest ? still + 1 : 0;
      prev = f;
      return still >= need;
    },
    seen: () => seen,
  };
}

// --- when the app underneath has stopped MOVING: the frame loop ---------------

// The three readings the watch takes off the thread, and nothing else. Declared
// readonly so this path cannot write one back even by accident: the compiler is
// the cheapest possible proof that the reveal never scrolls anything.
export interface QuietThread {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

// Watch until the app is still, then call done with the number of frames it
// took. stop() is the way out that does not depend on the app ever settling:
// the caller passes the loading page's own lifted(), so the cap ends this loop
// as surely as it ends the page. Where there is no frame clock at all there is
// also nothing to watch, so it answers straight away.
export function watchQuiet(
  thread: QuietThread,
  viewportH: () => number,
  stop: () => boolean,
  done: (frames: number) => void,
  need: number = QUIET_FRAMES,
): void {
  if (typeof requestAnimationFrame !== "function") {
    done(0);
    return;
  }
  const watch = createQuietWatch(need);
  const step = (): void => {
    if (stop()) {
      done(watch.seen());
      return;
    }
    const quiet = watch.frame({
      sh: thread.scrollHeight,
      st: thread.scrollTop,
      ch: thread.clientHeight,
      vh: viewportH(),
    });
    if (quiet) {
      done(watch.seen());
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// --- the app's own loading page: DOM layer ------------------------------------

// A launch image preceded this load only when the app opened as an installed
// window; a browser tab has no handover to hold, so the page stays out of one.
function isInstalledWindow(nav: Navigator): boolean {
  return (
    (nav as unknown as { standalone?: boolean }).standalone === true ||
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches)
  );
}

// nothing to hold up (a browser tab, or no document at all): every call is a
// no-op, so the caller needs no null checks
const NO_SCREEN: LoadingScreen = { settled: () => {}, lifted: () => true };

let loadingStarted = false; // once per load, like the startup image above

// Take over the loading page the document already carries, and hand back its
// lift rule. Safe to call unconditionally at boot: it no-ops outside an
// installed window and after the first call, and swallows its own errors. The
// lift timers start here, so the page cannot outlive the cap even if the app
// never settles.
//
// Nothing here builds the page and, since the page stopped being a copy of the
// launch image, nothing here measures it either. It is markup and styles in
// index.html (the comment at the top of that file carries the why), so it is on
// screen from the document's first paint instead of from this bundle's first
// statement, which on a measured cold open was two to six hundred milliseconds
// later. The old copy needed its geometry rewritten from here as well, because
// it had to land on the very pixels the phone's stored picture used and iOS
// reports a short layout viewport on the first frame. The scene the page draws
// now is its own, every length in it is a fraction of the viewport's shorter
// edge, and on a phone that edge is the width and does not move. There is
// nothing left to correct.
//
// What is left is the two things a stylesheet cannot do: decide whether there
// was a launch image to hand over from at all, and own the lift.
//
// No page in the document is a legitimate state, not an error: an old page
// still in the service worker's cache predates this markup, and a page like
// that is served with the bundle it shipped with.
export function installLoadingScreen(onLift?: (why: LiftReason) => void): LoadingScreen {
  if (loadingStarted) return NO_SCREEN;
  loadingStarted = true;
  try {
    if (typeof document === "undefined") return NO_SCREEN;
    const el = document.getElementById("loading");
    if (!el) return NO_SCREEN;
    // A browser tab has no launch image to hand over from, so the page comes
    // straight back out of the document rather than merely being hidden: it is
    // a fixed, full-screen panel, and one of those has no business sitting over
    // a page for the rest of its life. The stylesheet already hid it before any
    // of this ran (its display-mode rule); this is the half of the pair that
    // also catches a browser which does not know that query.
    if (!isInstalledWindow(navigator)) {
      el.remove();
      return NO_SCREEN;
    }
    // TEMP DIAGNOSTIC (the block at the top of this file owns the why): the
    // page has been on screen since the document's first paint, so this mark
    // is when the app took it over, not when the user first saw it
    coverUpMs = performance.now();
    return createLoadingGate((why) => {
      el.style.pointerEvents = "none"; // the fade must not eat the first tap
      el.style.opacity = "0"; // index.html states the transition this rides
      setTimeout(() => el.remove(), LOAD_FADE_MS);
      onLift?.(why);
    });
  } catch {
    return NO_SCREEN; // cosmetic only: a failed loading page must never block boot
  }
}
