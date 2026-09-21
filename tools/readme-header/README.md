# README header badge

`generate.py` renders the header graphic used at the top of the README. It is
the app's own first-open contact badge, drawn from the real source so it can
never drift from what the app shows:

- markup: the token-gate `head` template in `pwa/src/main.ts`
- styles: `pwa/src/styles.css` (the `--gate-badge-scale` badge)
- logo: `pwa/public/splash-logo.png` (the full-resolution 700x800 copy of the
  same artwork the app ships small as `pwa/public/topbar-logo.png`, used so the
  upscaled header stays sharp)
- version: `APP_VERSION` in `pwa/src/main.ts` (read automatically, never copied)

Output is two transparent PNGs in this folder:

- `paratrooper-header-light.png` (black title, for a light page)
- `paratrooper-header-dark.png` (white title, for a dark page)

The README picks between them with `prefers-color-scheme`.

## Run it

```
python -m pip install "playwright==1.61.0"
python -m playwright install webkit
python tools/readme-header/generate.py
```

WebKit is used on purpose: it is Safari's engine, so `-apple-system` resolves to
San Francisco, the face the app wears. Rendering on macOS keeps that font. Output
is deterministic, so re-running without a source change rewrites identical bytes.

## Automatic refresh

`.github/workflows/readme-header.yml` re-runs this on push when the version,
badge markup, badge styles, logo, or this generator change, and commits the
refreshed PNGs on the same branch. It is branch-relative: each branch keeps its
own header for the version on that branch. This becomes live only once the
workflow and generator are pushed to GitHub. It does not bump the semantic
version and does not force GitHub's image cache to refresh instantly.

## Referencing the images

Image paths are relative to the README containing them. A README at the
repository root should use `tools/readme-header/paratrooper-header-light.png`
and `tools/readme-header/paratrooper-header-dark.png`. Adjust that prefix if the
document is stored elsewhere or moved later.
