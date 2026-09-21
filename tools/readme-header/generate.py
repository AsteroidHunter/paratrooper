#!/usr/bin/env python3
"""Render the README header badge from the app's own source of truth.

This draws the exact contact badge the PWA shows on first open (the token gate
head in pwa/src/main.ts, styled by pwa/src/styles.css, with the real
pwa/public/topbar-logo.png). It reads APP_VERSION straight out of main.ts, so
there is never a second version string to keep in step. Output is two
transparent PNGs, one tuned for a light page and one for a dark page, so the
README can swap them with prefers-color-scheme.

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
# Oversampled render: the PNG carries 4x the CSS pixels so it stays sharp when
# the README scales it up past its native CSS width.
DEVICE_SCALE_FACTOR = 4

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
    # open (the app closes it later). For a standalone badge we close .gate.
    return markup + "\n    </div>"


def build_html(css: str, markup: str, logo_data_uri: str, version: str) -> str:
    markup = markup.replace("${APP_VERSION}", version)
    markup = markup.replace('src="/topbar-logo.png"', f'src="{logo_data_uri}"')
    # Strip the card chrome so only the badge is measured/painted: no card
    # padding, no max-width, no centring transform, transparent page.
    overrides = """
      html, body { margin: 0; background: transparent; }
      body { display: inline-block; }
      .gate {
        margin: 0; max-width: none; padding: 0;
        position: static; transform: none; will-change: auto;
      }
    """
    return (
        "<!doctype html>\n"
        '<html lang="en"><head><meta charset="utf-8">\n'
        f"<style>{css}\n{overrides}</style>\n"
        f"</head><body>{markup}</body></html>\n"
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
            page.wait_for_function(
                "() => { const a = document.querySelector('img.avatar');"
                " return a && a.complete && a.naturalWidth > 0; }"
            )
            badge = page.locator(".contact")
            box = badge.bounding_box()
            if not box:
                raise SystemExit("Could not measure the .contact badge")
            badge.screenshot(path=str(out_png), omit_background=True)
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
    logo_path = repo_root / "pwa" / "public" / "topbar-logo.png"
    for pth in (main_ts_path, css_path, logo_path):
        if not pth.exists():
            raise SystemExit(f"Required source file not found: {pth}")

    main_ts = main_ts_path.read_text(encoding="utf-8")
    css = css_path.read_text(encoding="utf-8")
    version = args.version or read_app_version(main_ts)
    markup = read_head_markup(main_ts)
    logo_b64 = base64.b64encode(logo_path.read_bytes()).decode("ascii")
    logo_data_uri = f"data:image/png;base64,{logo_b64}"

    html = build_html(css, markup, logo_data_uri, version)

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
