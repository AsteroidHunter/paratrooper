"""Web push (Phase 6) — wake a closed PWA when a job finishes.

Fast-follow, not required for the first loop: if VAPID isn't configured the whole
feature is a no-op (``config()`` returns None, the relay skips sending, and the
PWA's ``/api/push/key`` returns null so it never subscribes). VAPID keys are
operator-provided (Phase 0.5, [YOU]).
"""

from __future__ import annotations

import logging
import os
import re
from base64 import urlsafe_b64encode
from dataclasses import dataclass

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid

from .models import EVENT_POLICY

logger = logging.getLogger(__name__)

NOTIFICATION_EXCERPT_CHARS = 200
PUSH_TTL_SECONDS = 24 * 60 * 60


@dataclass
class VapidConfig:
    private_key: str
    public_key: str
    subject: str  # e.g. mailto:you@example.com


def _public_key_for_private(private_key: str) -> str:
    """Return the Web Push applicationServerKey belonging to a VAPID private key."""
    point = Vapid.from_string(private_key).public_key.public_bytes(
        Encoding.X962, PublicFormat.UncompressedPoint
    )
    return urlsafe_b64encode(point).rstrip(b"=").decode("ascii")


def config() -> VapidConfig | None:
    """VAPID config from env, or None if push isn't configured (feature off)."""
    private_key = os.environ.get("VAPID_PRIVATE_KEY")
    public_key = os.environ.get("VAPID_PUBLIC_KEY")
    subject = os.environ.get("VAPID_SUBJECT")
    if not private_key or not public_key or not subject:
        return None
    try:
        derived_public_key = _public_key_for_private(private_key)
    except Exception:
        logger.error("web push disabled: VAPID_PRIVATE_KEY is invalid")
        return None
    if derived_public_key != public_key.rstrip("="):
        logger.error("web push disabled: VAPID public and private keys do not match")
        return None
    return VapidConfig(private_key=private_key, public_key=public_key.rstrip("="), subject=subject)


def public_key() -> str | None:
    """The applicationServerKey (base64url) the browser needs to subscribe."""
    cfg = config()
    return cfg.public_key if cfg else None


def send_push(subscription: dict, payload: str, cfg: VapidConfig) -> bool:
    """Send one push. Returns False if the subscription is gone (404/410) so the
    caller can drop it; True otherwise (delivered or transient failure)."""
    from pywebpush import WebPushException, webpush

    try:
        response = webpush(
            subscription_info=subscription,
            data=payload,
            vapid_private_key=cfg.private_key,
            vapid_claims={"sub": cfg.subject},  # fresh each call (pywebpush mutates it)
            ttl=PUSH_TTL_SECONDS,
            headers={"Urgency": "high"},
            timeout=10,
        )
        logger.info("web push accepted by provider (status %s)", response.status_code)
        return True
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (404, 410):
            return False  # expired/unsubscribed — drop it
        logger.warning("web push failed (status %s): %s", status, exc)
        return True
    except Exception as exc:
        # Bad VAPID material and local encryption errors are not
        # WebPushException instances. Keep the device subscription so a fixed
        # deployment can reuse it, but make the server-side cause visible.
        logger.error("web push could not be prepared (%s)", type(exc).__name__)
        return True


def _message_excerpt(payload: object) -> str | None:
    """A compact push-safe projection of a user-facing terminal message.

    Pushes are a preview, not a second copy of the conversation: normalize
    display whitespace and retain roughly the first 200 characters. The four
    suffix characters are added only when content remains, with exactly one
    ordinary space before the ellipsis.
    """
    if not isinstance(payload, str):
        return None
    text = re.sub(r"\s+", " ", payload).strip()
    if not text:
        return None
    if len(text) <= NOTIFICATION_EXCERPT_CHARS:
        return text
    return f"{text[:NOTIFICATION_EXCERPT_CHARS].rstrip()} ..."


def notification_text(kind: str, payload: object = None) -> str | None:
    """Push body for one result; None for kinds that do not notify.

    The terminal result carries its own job's user-facing reply/error into this
    call, so concurrent runs never consult shared "last reply" state. Special
    screenshot and PR wording remains policy-owned.
    """
    policy = EVENT_POLICY.get(kind)
    if policy is None or policy.push_text is None:
        return None
    if kind in {"done", "error"}:
        return _message_excerpt(payload) or policy.push_text
    return policy.push_text
