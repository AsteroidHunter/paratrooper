# README header banner

`generate.py` renders the illustrated banner used at the top of the README: a
wide rounded white panel carrying the app's own first-open logo/name/version
lockup, surrounded by hand-painted scenery. The lockup reuses the app's source,
with banner-specific sizing, spacing and colours:

- markup: the token-gate `head` template in `pwa/src/main.ts`
- styles: `pwa/src/styles.css` (the `--gate-badge-scale` badge), scaled up for
  the banner with a slightly tighter logo-to-text gap
- logo: `pwa/public/splash-logo.png` (the full-resolution 700x800 copy of the
  same artwork the app ships small as `pwa/public/topbar-logo.png`, used so the
  upscaled header stays sharp)
- version: `APP_VERSION` in `pwa/src/main.ts` (read automatically, never copied)

The scenery is composed from four static watercolour PNGs in `assets/`, plain
inputs stored in the repo (not generated):

- `assets/mountain.png` — one peak, placed three times as the mountain range
  rising from the bottom-left (middle tallest), clipped by the panel edges
- `assets/cloud.png` — one cloud, placed twice as the two overlapping clouds
- `assets/sun.png` — the sun at the top-right, behind the clouds
- `assets/stars.png` — the star scatter in the top-left

Layout lives in the `DECOR` table and the lockup constants near the top of
`generate.py`, in the panel's own CSS pixels (authored at 1000x300, rendered at
2x to a 2000x600 PNG).

Output is two PNGs in this folder:

- `paratrooper-header-light.png`
- `paratrooper-header-dark.png`

The panel is a real white rectangle with rounded, transparent corners and a
black title. Both files carry the identical composition — a white panel reads
the same on a light or dark page — so the two filenames stay only for
compatibility with the README's `prefers-color-scheme` swap.

## Run it

```
python -m pip install "playwright==1.61.0"
python -m playwright install webkit
python tools/readme-header/generate.py
```

WebKit is used on purpose: it is Safari's engine, so `-apple-system` resolves to
San Francisco, the face the app wears. Rendering on macOS keeps that font. Output
is deterministic, so re-running without a source change rewrites identical bytes.

`--version X.Y.Z` is a test-only override that renders a different version string
WITHOUT touching `main.ts`, so a fixture can prove the version flows through to
the image.

## Automatic refresh

`.github/workflows/readme-header.yml` re-runs this on push when the version,
badge markup, badge styles, logo, the scenery PNGs in `assets/`, or this
generator change, and commits the refreshed output PNGs on the same branch (the
`assets/` inputs are never rewritten by the job). It is branch-relative: each
branch keeps its own header for the version on that branch. This becomes live
only once the workflow and generator are pushed to GitHub. It does not bump the
semantic version and does not force GitHub's image cache to refresh instantly.

## Referencing the images

Image paths are relative to the README containing them. A README at the
repository root should use `tools/readme-header/paratrooper-header-light.png`
and `tools/readme-header/paratrooper-header-dark.png`. Adjust that prefix if the
document is stored elsewhere or moved later.
