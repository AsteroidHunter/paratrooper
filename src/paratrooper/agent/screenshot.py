"""``screenshot_board`` — build the site and capture the board with Playwright.

Per the architecture: after the pin folder is written on the feature branch, run
``astro build`` in the checkout, serve the built ``dist/`` over an ephemeral
local HTTP server, open it with headless Chromium at a fixed desktop viewport,
and capture the ``.cloth`` element. Building (rather than a persistent dev
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
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DEFAULT_VIEWPORT = (1440, 1440)  # square-ish desktop; the board is square
DEFAULT_SELECTOR = ".cloth"
DEFAULT_BUILD_CMD = ("npm", "run", "build")


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


async def screenshot_board(
    site_root: str | Path,
    out_path: str | Path,
    *,
    viewport: tuple[int, int] = DEFAULT_VIEWPORT,
    selector: str = DEFAULT_SELECTOR,
    build: bool = True,
    build_cmd: tuple[str, ...] = DEFAULT_BUILD_CMD,
    dist_subdir: str = "dist",
) -> Path:
    """Build the site (unless ``build=False``) and screenshot the ``.cloth``
    element to ``out_path`` (PNG). Returns the path."""
    from playwright.async_api import async_playwright  # lazy: browser dep is heavy

    site_root = Path(site_root)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if build:
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
                await element.screenshot(path=str(out_path))
            finally:
                await browser.close()
    return out_path
