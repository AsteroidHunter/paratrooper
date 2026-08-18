// The iOS home-screen launch image, painted for THIS device at runtime.
//
// An installed web app on iOS shows a launch image only through
// <link rel="apple-touch-startup-image">, and each tag's media query has to
// match the device's exact pixel size — there is no fixed set of images that
// covers every iPhone, so the standard fix is to paint one on load. We draw the
// same logo the top bar shows, centered on white, onto a canvas sized to the
// current screen in device pixels, then inject a link whose media query targets
// this device. Android builds its splash from the manifest and every non-iOS
// browser ignores these tags, so we only do the work on iOS.
//
// Same shape as the shell module: a pure geometry core (unit-tested, no DOM)
// beneath a thin canvas/DOM layer.

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

// paint solid white, then the logo centered — pure drawing over a 2D-context-
// shaped target; the caller owns the canvas the target writes to.
export function paintSplash(ctx: DrawTarget, logo: CanvasImageSource, g: SplashLayout): void {
  ctx.fillStyle = "#ffffff";
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
