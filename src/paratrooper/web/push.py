"""Web push (Phase 6) — wake a closed PWA when a job finishes.

Fast-follow, not required for the first loop: if VAPID isn't configured the whole
feature is a no-op (``config()`` returns None, the relay skips sending, and the
PWA's ``/api/push/key`` returns null so it never subscribes). VAPID keys are
operator-provided (Phase 0.5, [YOU]).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class VapidConfig:
    private_key: str
    subject: str  # e.g. mailto:you@example.com


def config() -> VapidConfig | None:
    """VAPID config from env, or None if push isn't configured (feature off)."""
    private_key = os.environ.get("VAPID_PRIVATE_KEY")
    subject = os.environ.get("VAPID_SUBJECT")
    if not private_key or not subject:
        return None
    return VapidConfig(private_key=private_key, subject=subject)


def public_key() -> str | None:
    """The applicationServerKey (base64url) the browser needs to subscribe."""
    return os.environ.get("VAPID_PUBLIC_KEY")


def send_push(subscription: dict, payload: str, cfg: VapidConfig) -> bool:
    """Send one push. Returns False if the subscription is gone (404/410) so the
    caller can drop it; True otherwise (delivered or transient failure)."""
    from pywebpush import WebPushException, webpush

    try:
        webpush(
            subscription_info=subscription,
            data=payload,
            vapid_private_key=cfg.private_key,
            vapid_claims={"sub": cfg.subject},  # fresh each call (pywebpush mutates it)
        )
        return True
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (404, 410):
            return False  # expired/unsubscribed — drop it
        logger.warning("web push failed (status %s): %s", status, exc)
        return True


def notification_text(kind: str) -> str | None:
    """Short body for a terminal result; None for non-notifying kinds."""
    return {
        "pr": "Your pin is ready — tap to review and publish 🪂",
        "done": "Paratrooper finished your update.",
        "error": "Paratrooper hit a problem with your update.",
    }.get(kind)
