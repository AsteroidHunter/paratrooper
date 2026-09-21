#!/usr/bin/env python3
"""Render the illustrated README banner from the app's own source of truth.

The banner is a wide rounded white panel carrying the same logo/name/version
lockup the PWA shows on first open (the token-gate `head` in pwa/src/main.ts,
styled by the badge rules in pwa/src/styles.css) surrounded by hand-painted
scenery: three mountains rising from the bottom-left, a scatter of stars in the
top-left, and a sun behind two clouds at the top-right.

The lockup reuses the app's source, with banner-specific sizing and spacing:

- logo: pwa/public/splash-logo.png, the full-resolution (700x800) copy of the
  same cutout the app ships small as pwa/public/topbar-logo.png (140x160);
  feeding the banner the large copy keeps the scaled-up image sharp without
  enlarging the tiny topbar asset.
- name + version: the token-gate `head` markup and the badge CSS, with the
  version read straight out of APP_VERSION in main.ts, so there is never a
  second version string to keep in step.

The scenery is composed from four static watercolour PNGs stored beside this
script in assets/ (mountain.png reused three times, cloud.png reused twice, plus
stars.png and sun.png). They are plain inputs, not generated.

The white panel and black title are kept identical for a light and a dark page:
the two output filenames (…-light.png, …-dark.png) stay for compatibility but
carry the same composition, so the banner reads the same whatever colour scheme
GitHub renders it under.

It renders with Playwright WebKit on purpose: WebKit is Safari's engine, so
-apple-system resolves to the same San Francisco face the app wears on iOS
rather than a fallback.

Usage:
    python generate.py [--repo-root PATH] [--out-dir PATH] [--version X.Y.Z]

--version is only for tests: it overrides the version WITHOUT touching main.ts,
so a fixture can prove a different version flows through to the image.
"""

from __future__ import annotations

import argparse
import base64
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

# Bounded so a wedged browser fails loudly instead of hanging forever.
LAUNCH_TIMEOUT_MS = 60_000
OP_TIMEOUT_MS = 30_000
# The panel is authored at CSS 1000x300 (a 10:3 banner) and rendered at 2x, so
# the PNG is 2000x600 — sharp at GitHub's full README width and beyond.
CSS_WIDTH = 1000
CSS_HEIGHT = 300
DEVICE_SCALE_FACTOR = 2
PANEL_RADIUS_PX = 10

# Same two filenames as before, kept for compatibility; both carry the identical
# white-panel composition (see module docstring).
THEMES = ("light", "dark")

# The badge markup lives once in main.ts. We lift that literal so the image
# cannot drift from the app; these anchors bound the template string.
HEAD_START = re.compile(r"const\s+head\s*=\s*`", re.MULTILINE)
HEAD_END = "`;"
REQUIRED_CLASSES = (
    'class="gate"',
    'class="contact"',
    'class="avatar"',
    'class="ident"',
    'class="title"',
    'class="ver"',
)

# The four scenery PNGs, resolved next to this script under assets/. Filenames
# only — the generator depends solely on tracked repository files.
ASSET_NAMES = ("mountain.png", "cloud.png", "stars.png", "sun.png")

# Scenery placement, in the panel's own CSS pixels (0,0 top-left, 1000x300).
# Every item is one <img> layer: `w` is its rendered width (height follows the
# file's aspect ratio), `left`/`top` place its top-left corner (negative values
# run a layer off the panel edge, where overflow:hidden clips it against the
# rounded corners), `rot` is an optional degrees rotation, and `z` orders the
# stack. mountain.png appears three times and cloud.png twice — one source file,
# reused — matching the reference sample.
DECOR = [
    # Sun at the upper-right edge, behind the clouds, clipped by the right edge.
    # Its disc top peeks above the clouds; the body runs off the right edge.
    {"file": "sun.png", "w": 150, "left": 877, "top": 17, "z": 1},
    # Two overlapping clouds in front of the sun: a smaller, higher one to the
    # left and a larger, lower one to the right. Both run off the right edge and
    # cover the sun's lower half, leaving the group inside x~782..1000, y~82..236.
    {"file": "cloud.png", "w": 195, "left": 777, "top": 74, "z": 2},
    {"file": "cloud.png", "w": 202.5, "left": 865, "top": 100, "z": 3},
    # Three mountains rising from the bottom-left, middle tallest, all clipped by
    # the bottom edge and the leftmost by the left edge. Each width is chosen so
    # the source art's near-flat lower edge falls below the panel (y>300 CSS) and
    # is clipped, leaving no horizontal seam. The centre peak sits behind the two
    # outer peaks; the left (front) peak overlaps the bottom-left corner.
    {"file": "mountain.png", "w": 250, "left": -11, "top": 108, "z": 4},   # centre (tallest)
    {"file": "mountain.png", "w": 200, "left": -56, "top": 153, "z": 6},   # left (front)
    {"file": "mountain.png", "w": 178, "left": 109, "top": 181, "z": 5},   # right (shortest)
    # Star scatter in the top-left. The width/left/top/rotation come from a
    # least-squares fit of the four largest stars' centroids against the sample.
    {"file": "stars.png", "w": 230.4615, "left": -38.6531, "top": -66.73,
     "rot": -130.0761, "z": 4},
]

# Lockup dial and gap. --gate-badge-scale drives the whole logo/name/version
# block off one number (see styles.css); 3.5 sizes it to the reference. The
# reference tightens the logo-to-text gap versus the app's default
# (5px*scale ≈ 17.5px), so we set it smaller here.
BADGE_SCALE = 3.5
BADGE_GAP_PX = 6
# The lockup's optical centre sits a hair right of, and just above, the panel
# centre in the reference; nudge it to match.
LOCKUP_SHIFT_X = 10
LOCKUP_SHIFT_Y = 0


def read_app_version(main_ts: str) -> str:
    m = re.search(r'const\s+APP_VERSION\s*=\s*["\']([^"\']+)["\']', main_ts)
    if not m:
        raise SystemExit("Could not read APP_VERSION from main.ts")
    return m.group(1)


def read_head_markup(main_ts: str) -> str:
    start = HEAD_START.search(main_ts)
    if not start:
        raise SystemExit("Could not find the `const head = ` template in main.ts")
    rest = main_ts[start.end():]
    end = rest.find(HEAD_END)
    if end == -1:
        raise SystemExit("Could not find the end of the head template in main.ts")
    markup = rest[:end]
    for needed in REQUIRED_CLASSES:
        if needed not in markup:
            raise SystemExit(f"Token-gate markup no longer contains {needed}")
    # The head template already closes .ident and .contact; only .gate is left
    # open (the app closes it later). For a standalone lockup we close .gate.
    return markup + "\n    </div>"


def data_uri(path: Path) -> str:
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def decor_html(assets: dict[str, str]) -> str:
    layers = []
    for d in DECOR:
        style = (
            f"width:{d['w']}px;left:{d['left']}px;top:{d['top']}px;z-index:{d['z']};"
        )
        if d.get("rot"):
            style += f"transform:rotate({d['rot']}deg);"
        layers.append(f'<img class="deco" src="{assets[d["file"]]}" alt="" style="{style}">')
    return "\n      ".join(layers)


def build_html(css: str, markup: str, logo_data_uri: str, assets: dict[str, str],
               version: str) -> str:
    markup = markup.replace("${APP_VERSION}", version)
    markup = markup.replace('src="/topbar-logo.png"', f'src="{logo_data_uri}"')
    # Banner chrome + a light-locked lockup palette. The panel is a real white
    # rectangle with rounded, transparent corners; overflow:hidden clips every
    # scenery layer against those corners. .gate is stripped of the app's fixed
    # positioning/transform and re-centred inside the panel at the banner dial,
    # and the title/version colours are pinned so the same bytes serve the light
    # and dark filenames.
    overrides = f"""
      html, body {{ margin: 0; background: transparent; }}
      body {{ display: inline-block; }}
      .banner {{
        position: relative; width: {CSS_WIDTH}px; height: {CSS_HEIGHT}px;
        background: #ffffff; border-radius: {PANEL_RADIUS_PX}px; overflow: hidden;
      }}
      .banner img.deco {{ position: absolute; display: block; }}
      .gate {{
        position: absolute;
        left: calc(50% + {LOCKUP_SHIFT_X}px); top: calc(50% + {LOCKUP_SHIFT_Y}px);
        transform: translate(-50%, -50%);
        margin: 0; max-width: none; padding: 0; will-change: auto;
        --gate-badge-scale: {BADGE_SCALE};
        z-index: 10;
      }}
      .contact {{ gap: {BADGE_GAP_PX}px; }}
      .gate .title {{ color: #000000; }}
      .gate .ver {{ color: #8a8a8f; }}
    """
    return (
        "<!doctype html>\n"
        '<html lang="en"><head><meta charset="utf-8">\n'
        f"<style>{css}\n{overrides}</style>\n"
        f'</head><body><div class="banner">\n      {decor_html(assets)}\n      '
        f"{markup}\n</div></body></html>\n"
    )


def render_theme(html: str, out_png: Path, theme: str) -> tuple[int, int]:
    with sync_playwright() as p:
        browser = p.webkit.launch(timeout=LAUNCH_TIMEOUT_MS)
        try:
            context = browser.new_context(
                device_scale_factor=DEVICE_SCALE_FACTOR, color_scheme=theme
            )
            context.set_default_timeout(OP_TIMEOUT_MS)
            page = context.new_page()
            page.set_content(html, wait_until="load")
            # Wait for the logo and every scenery layer to finish decoding, so
            # the screenshot never catches a half-painted image.
            page.wait_for_function(
                "() => Array.from(document.images)"
                ".every(i => i.complete && i.naturalWidth > 0)"
            )
            panel = page.locator(".banner")
            box = panel.bounding_box()
            if not box:
                raise SystemExit("Could not measure the .banner panel")
            panel.screenshot(path=str(out_png), omit_background=True)
            return (round(box["width"]), round(box["height"]))
        finally:
            browser.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=None)
    parser.add_argument("--out-dir", type=Path, default=None)
    parser.add_argument(
        "--version",
        default=None,
        help="Test-only override; does NOT touch main.ts.",
    )
    args = parser.parse_args()

    script_dir = Path(__file__).resolve().parent
    repo_root = (args.repo_root or script_dir.parents[1]).resolve()
    out_dir = (args.out_dir or script_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    main_ts_path = repo_root / "pwa" / "src" / "main.ts"
    css_path = repo_root / "pwa" / "src" / "styles.css"
    # Full-resolution copy of the topbar logo (same artwork, 700x800 vs the
    # topbar's 140x160). Injected in place of the markup's /topbar-logo.png so
    # the upscaled banner stays sharp without enlarging the small asset.
    logo_path = repo_root / "pwa" / "public" / "splash-logo.png"
    asset_dir = script_dir / "assets"
    asset_paths = {name: asset_dir / name for name in ASSET_NAMES}
    for pth in (main_ts_path, css_path, logo_path, *asset_paths.values()):
        if not pth.exists():
            raise SystemExit(f"Required source file not found: {pth}")

    main_ts = main_ts_path.read_text(encoding="utf-8")
    css = css_path.read_text(encoding="utf-8")
    version = args.version or read_app_version(main_ts)
    markup = read_head_markup(main_ts)
    logo_data_uri = data_uri(logo_path)
    assets = {name: data_uri(pth) for name, pth in asset_paths.items()}

    html = build_html(css, markup, logo_data_uri, assets, version)

    sizes = {}
    for theme in THEMES:
        out_png = out_dir / f"paratrooper-header-{theme}.png"
        sizes[theme] = render_theme(html, out_png, theme)
        print(f"wrote {out_png} (css {sizes[theme][0]}x{sizes[theme][1]})")

    print(f"version {version} (source: {main_ts_path})")
    # The light image sets the README's display width (both are the same size).
    print(f"display-width {sizes['light'][0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
