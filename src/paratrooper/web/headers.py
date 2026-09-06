"""The one response-header layer on the web service.

Until this existed the service sent no policy at all: the built page could be
framed by anything, its referrer went out to wherever a link pointed, its
content types were sniffable, and an injected script would have run with the
same rights as the app's own. This is where that is stated, once, for every
response the service makes.

WHY A HASH AND NOT A NONCE. The page's styles are inline, in two blocks: the
loading page carries its own in index.html, and the build folds the whole
stylesheet into the document as a second block (pwa/vite.config.ts explains
why). A nonce would mean rewriting the document on every request, which is a
mechanism and a cache problem in exchange for nothing here, because the two
blocks are fixed for the life of a build. So they are named by SHA-256 hash,
read out of the built page at start-up. Scripts get no such exemption: the
bundle is a file, ``script-src 'self'`` covers it, and there is no inline
script anywhere in the document.

WHAT THE POLICY HAS TO ALLOW, and nothing else: the bundle and the two style
blocks, the socket and the API on this same origin, photos from this origin plus
the ``data:`` screenshots and the ``blob:`` previews the composer makes locally,
the manifest, and the service worker. Everything else, framing included, is off.

A build whose page this cannot read still gets the policy; it simply gets one
with no style hashes in it, which fails loudly on the first paint rather than
quietly allowing whatever arrives.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

_STYLE_BLOCK_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.DOTALL | re.IGNORECASE)

# Features the app does not use. Named individually rather than with a wildcard
# because the header is a list of what is switched off, and a name the browser
# does not know is ignored rather than obeyed.
PERMISSIONS_POLICY = ", ".join(
    f"{feature}=()"
    for feature in (
        "accelerometer",
        "autoplay",
        "camera",
        "display-capture",
        "encrypted-media",
        "fullscreen",
        "geolocation",
        "gyroscope",
        "magnetometer",
        "microphone",
        "midi",
        "payment",
        "publickey-credentials-get",
        "screen-wake-lock",
        "usb",
        "xr-spatial-tracking",
    )
)


def style_hashes(index_html: Path) -> list[str]:
    """The ``'sha256-...'`` source expressions for the built page's inline style
    blocks, in document order.

    The hash is over the block's bytes exactly as they sit in the file, which is
    what the browser hashes: nothing unescapes inside a style element.
    """
    try:
        page = index_html.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("could not read %s for its style hashes: %s", index_html, exc)
        return []
    hashes = []
    for block in _STYLE_BLOCK_RE.findall(page):
        digest = hashlib.sha256(block.encode("utf-8")).digest()
        hashes.append(f"'sha256-{base64.b64encode(digest).decode()}'")
    return hashes


def content_security_policy(hashes: list[str]) -> str:
    """The policy string, built once at start-up."""
    style_src = " ".join(["'self'", *hashes])
    return "; ".join((
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "script-src 'self'",
        f"style-src {style_src}",
        # photos served by this service, the base64 screenshots the worker
        # streams in, and the blob previews the composer makes on the device
        "img-src 'self' data: blob:",
        "font-src 'self'",
        # the API and the socket, both on this origin
        "connect-src 'self'",
        "manifest-src 'self'",
        "worker-src 'self'",
    ))


def security_headers(policy: str) -> dict[str, str]:
    return {
        "Content-Security-Policy": policy,
        # frame-ancestors above is the modern rule; this is the same answer for
        # anything that only ever learned the old header
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Permissions-Policy": PERMISSIONS_POLICY,
    }


class SecurityHeaders:
    """Add the headers to every HTTP response, leaving any already set alone.

    Written as plain ASGI rather than a request/response middleware so it cannot
    buffer a body or come between the socket and its handler: it edits the
    response's start message and touches nothing else.
    """

    def __init__(self, app, headers: dict[str, str]) -> None:
        self.app = app
        self._headers = [
            (name.lower().encode("latin-1"), value.encode("latin-1"))
            for name, value in headers.items()
        ]

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message) -> None:
            if message["type"] == "http.response.start":
                present = {name.lower() for name, _ in message.get("headers", [])}
                message["headers"] = [
                    *message.get("headers", []),
                    *((name, value) for name, value in self._headers if name not in present),
                ]
            await send(message)

        await self.app(scope, receive, send_with_headers)
