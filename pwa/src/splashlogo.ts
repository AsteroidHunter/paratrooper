// The splash logo's intrinsic size. The art itself lives in index.html.
//
// The cover has to show the logo in the SAME frame it appears. Anything it must
// go and get first (a network request, a service-worker cache hit, even an
// already-warm file) lands a task or more later, and the user watches the
// phone's launch image, which is white plus this logo, hand over to a bare
// white panel and then to the logo again. So the art is a data URI, and it sits
// in the one file that is already on its way when the cover has to be on
// screen: the document. splash.ts adopts the element index.html carries rather
// than building one, which is why nothing here is a string any more.
//
// What stayed behind is the pair of numbers the geometry needs in JS.
// splashLayout() contain-fits the logo's aspect ratio inside a square, so it
// has to know the ratio before anything has decoded, and reading it back off
// the document would mean waiting for exactly the decode the inlining removes.
//
// Inlining costs document bytes, and the document is the thing that now has to
// arrive before anything can be on screen, so the art is cut down to what the
// cover actually shows and no further. The logo is a photograph, so there is no
// vector form to inline in its place; the cover paints its white background
// behind it either way, so the cut-out's alpha is flattened onto that same
// white and the file carries no alpha channel at all. That flattening is most
// of the saving: the full-res file is 292 kB, the inlined one is 4.7 kB.
//
// Regenerate from the full-res art whenever that art changes, run from pwa/,
// and paste the last line's output into the #splashlogo src in index.html:
//
//   python -c "from PIL import Image; im = Image.open('public/splash-logo.png').convert('RGBA'); \
//     r = im.resize((280, 320), Image.LANCZOS); f = Image.new('RGB', r.size, (255, 255, 255)); \
//     f.paste(r, (0, 0), r); f.save('/tmp/splash-inline.png')"
//   cwebp -q 75 -m 6 /tmp/splash-inline.png -o /tmp/splash-inline.webp
//   echo -n "data:image/webp;base64,$(base64 -i /tmp/splash-inline.webp | tr -d '\n')"
//
// Keep the 7:8 proportion when resizing. It is the full-res file's own ratio,
// so the geometry in splash.ts sees the same aspect either way, and splashLayout()
// derives the entire picture from that number. 280x320 is close to 1:1 with the
// largest rect any iPhone shows the logo at, roughly 370x422 device px.

/** intrinsic size of the art index.html inlines, in its own pixels */
export const SPLASH_LOGO_W = 280;
export const SPLASH_LOGO_H = 320;
