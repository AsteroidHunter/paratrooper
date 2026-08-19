"""``screenshot_board`` — build the site and capture the board with Playwright.

Per the architecture: after the pin folder is written on the feature branch, run
``astro build`` in the checkout, serve the built ``dist/`` over an ephemeral
local HTTP server, open it with headless Chromium at a fixed desktop viewport,
and capture the ``.cloth`` element (or, with ``pin_id``, click that polaroid
open and capture the opened view). Building (rather than a persistent dev
server) means each screenshot reflects exactly the committed state; the server
is spun up per-capture and torn down.

Chromium runs with ``--no-sandbox`` (managed hosts like Render block the user
namespaces Chromium's own sandbox needs). The browser binary is installed
separately (``playwright install chromium``) in the worker image (Phase 5.2);
this code is exercised end-to-end at the 5.4 smoke.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_VIEWPORT = (1440, 1440)  # square-ish desktop; the board is square
DEFAULT_SELECTOR = ".cloth"
DEFAULT_BUILD_CMD = ("npm", "run", "build")
# The board's polaroid markup (src/pages/index.astro in the site repo): each
# pin renders as a clickable ``.board-pin`` div carrying its id in
# ``data-pin-id``; clicking it opens the ``.polaroid-overlay`` lightbox (a
# fixed full-viewport backdrop) with the ``.polaroid-card`` zooming in.
PIN_SELECTOR = ".board-pin"
CARD_SELECTOR = ".polaroid-card"
TITLE_SELECTOR = ".polaroid-title"
# breathing room around the opened card + title union: enough backdrop to read
# as a lightbox close-up without shrinking the card back into a corner
CLIP_PAD = 32


class ScreenshotError(RuntimeError):
    """The build failed or the board element never appeared."""


async def _run(cmd: tuple[str, ...], cwd: Path) -> None:
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        tail = (out or b"").decode(errors="replace")[-2000:]
        raise ScreenshotError(f"{' '.join(cmd)} failed (exit {proc.returncode}):\n{tail}")


@contextlib.contextmanager
def _serve(directory: Path):
    """Serve ``directory`` on an ephemeral localhost port; yields the base URL."""
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(directory))
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}/"
    finally:
        httpd.shutdown()
        thread.join(timeout=5)


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _match_pin(requested: str, ids: list[str]) -> str | None:
    """Resolve ``requested`` against the board's ``data-pin-id`` values: exact
    first, then a normalized (slugified) match if it is unambiguous."""
    if requested in ids:
        return requested
    want = _slug(requested)
    hits = [i for i in ids if i and _slug(i) == want]
    return hits[0] if len(hits) == 1 else None


async def _shoot_opened(page, pin_id: str, out_path: Path) -> None:
    """Click open the polaroid whose ``data-pin-id`` matches ``pin_id`` and
    capture it close up. The lightbox is a fixed full-viewport overlay, but
    the card fills only its middle — a viewport shot arrives mostly dim
    backdrop with a tiny card. Clip to the union box of the card and its
    floating title (a sibling on the backdrop, shown only on multi-song pins;
    empty means display:none, a zero rect), padded by ``CLIP_PAD`` of backdrop
    so it still reads as a lightbox, clamped to the viewport."""
    ids = await page.locator(PIN_SELECTOR).evaluate_all(
        "els => els.map(e => e.dataset.pinId ?? '')"
    )
    target = _match_pin(pin_id, ids)
    if target is None:
        known = ", ".join(i for i in ids if i) or "(none)"
        raise ScreenshotError(f"no polaroid matches {pin_id!r}; the board has: {known}")
    await page.locator(PIN_SELECTOR).nth(ids.index(target)).click(timeout=15_000)
    card = page.locator(CARD_SELECTOR)
    await card.wait_for(state="visible", timeout=15_000)
    # the card zooms in via a CSS animation and its artwork is injected on
    # open — capture only once both have settled
    await page.wait_for_function(
        "sel => { const c = document.querySelector(sel);"
        " return c && c.getAnimations().every(a => a.playState === 'finished')"
        " && [...c.querySelectorAll('img')].every(i => i.complete); }",
        arg=CARD_SELECTOR,
        timeout=15_000,
    )
    # measured only after the settle wait above: the zoom animation scales the
    # card's rect, so an earlier read would clip the mid-zoom size
    clip = await page.evaluate(
        "([sels, pad]) => {"
        " const rects = sels.map(s => document.querySelector(s))"
        "   .filter(el => el).map(el => el.getBoundingClientRect())"
        "   .filter(r => r.width > 0 && r.height > 0);"
        " const x = Math.max(0, Math.min(...rects.map(r => r.left)) - pad);"
        " const y = Math.max(0, Math.min(...rects.map(r => r.top)) - pad);"
        " const right = Math.min(innerWidth, Math.max(...rects.map(r => r.right)) + pad);"
        " const bottom = Math.min(innerHeight, Math.max(...rects.map(r => r.bottom)) + pad);"
        " return { x, y, width: right - x, height: bottom - y }; }",
        [[CARD_SELECTOR, TITLE_SELECTOR], CLIP_PAD],
    )
    await page.screenshot(path=str(out_path), clip=clip)


async def screenshot_board(
    site_root: str | Path,
    out_path: str | Path,
    *,
    viewport: tuple[int, int] = DEFAULT_VIEWPORT,
    selector: str = DEFAULT_SELECTOR,
    build: bool = True,
    build_cmd: tuple[str, ...] = DEFAULT_BUILD_CMD,
    dist_subdir: str = "dist",
    pin_id: str | None = None,
) -> Path:
    """Build the site (unless ``build=False``) and screenshot the ``.cloth``
    element to ``out_path`` (PNG). With ``pin_id``, click that polaroid open
    once the board is visible and capture a close-up of the opened view (the
    card and its floating title, padded) instead; an unknown id raises
    :class:`ScreenshotError` naming the ids that exist. Returns the path."""
    from playwright.async_api import async_playwright  # lazy: browser dep is heavy

    site_root = Path(site_root)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if build:
        # fresh clones have no node_modules; install once per container life
        if not (site_root / "node_modules").is_dir():
            await _run(("npm", "ci", "--no-audit", "--no-fund"), site_root)
        await _run(build_cmd, site_root)

    dist = site_root / dist_subdir
    if not (dist / "index.html").is_file():
        raise ScreenshotError(f"no built board at {dist/'index.html'} (did the build run?)")

    with _serve(dist) as base_url:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
            try:
                page = await browser.new_page(
                    viewport={"width": viewport[0], "height": viewport[1]}
                )
                await page.goto(base_url, wait_until="networkidle")
                element = page.locator(selector).first
                await element.wait_for(state="visible", timeout=15_000)
                if pin_id is None:
                    await element.screenshot(path=str(out_path))
                else:
                    await _shoot_opened(page, pin_id, out_path)
            finally:
                await browser.close()
    return out_path
