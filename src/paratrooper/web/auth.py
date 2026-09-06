"""Shared-bearer-token gate (endpoint security — Open Q / design decision).

One user, one long token over HTTPS: the PWA stores it in localStorage and sends
it on every request (``Authorization: Bearer <token>``) and on the socket
handshake (query param, since browsers can't set WS headers). The backend rejects
anything else. Comparison is constant-time.
"""

from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, status

from ..agent.config import app_token


def verify_token(token: str | None) -> bool:
    """Constant-time check of a presented token against ``PARATROOPER_APP_TOKEN``.

    Compared as bytes, and that is the whole point of the encode below.
    ``compare_digest`` refuses two strings when either carries a character
    outside ASCII — it raises TypeError rather than answering false — and a
    header or a query string is free to carry any byte at all. So one request
    with a high byte in it turned the gate into a 500 with a traceback in the
    deploy logs, where every other wrong token is a quiet 401. On bytes the
    comparison always answers, and a token that is not the token is refused the
    same way whatever it is made of.
    """
    if not token:
        return False
    try:
        presented = token.encode("utf-8", "surrogatepass")
    except UnicodeEncodeError:  # a lone surrogate the encoder cannot pass either
        return False
    return secrets.compare_digest(presented, app_token().encode("utf-8"))


def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


async def require_token(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: 401 unless a valid bearer token is present."""
    if not verify_token(_bearer(authorization)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")
