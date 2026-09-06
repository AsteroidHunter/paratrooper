"""Web push (Phase 6) — wake a closed PWA when a job finishes.

Fast-follow, not required for the first loop: if VAPID isn't configured the whole
feature is a no-op (``config()`` returns None, the relay skips sending, and the
PWA's ``/api/push/key`` returns null so it never subscribes). VAPID keys are
operator-provided (Phase 0.5, [YOU]).
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse

from .models import EVENT_POLICY

logger = logging.getLogger(__name__)

NOTIFICATION_EXCERPT_CHARS = 200
PUSH_TIMEOUT_SECONDS = 10
FINGERPRINT_CHARS = 8

# --- who may be registered as a push address ---------------------------------
#
# A registered endpoint is an address this service will POST to, over and over,
# with the app's own notification text. Until this list existed, any address at
# all could be registered, so one authenticated request turned the service into
# a sender aimed wherever the caller liked, and a second one could name an
# existing row as "replaced" and delete the phone's real registration with it.
#
# The list is the browser push services, and browser push services only. A
# subscription's endpoint is minted by the browser, not by us and not by the
# page, so anything outside this set was not minted by a browser and is not a
# device of ours. Hostnames are matched exactly and https only.
#
# Sources (read rather than guessed, 2026-09-05):
#   web.push.apple.com                  Apple, Safari and iOS home-screen apps —
#                                       the one this app actually runs on
#   fcm.googleapis.com                  Google FCM, Chrome and Chromium browsers
#   android.googleapis.com              Google's older GCM host, still handed out
#                                       to some Chromium builds
#   updates.push.services.mozilla.com   Mozilla autopush, Firefox
#
# These are vendor-operated names and can change. A registration refused here
# shows up as the notification setup failing on the device, which is the signal
# to come back and re-read the vendors' current hosts.
PUSH_SERVICE_HOSTS = frozenset({
    "web.push.apple.com",
    "fcm.googleapis.com",
    "android.googleapis.com",
    "updates.push.services.mozilla.com",
})

# what the phone is told when an address is refused
NOT_A_PUSH_SERVICE = "that is not a browser notification address"


def is_push_service_endpoint(endpoint: object) -> bool:
    """Was ``endpoint`` minted by one of the browser push services above?

    Everything about the URL is checked, not just its start: a string like
    ``https://evil.example/web.push.apple.com`` has the right letters in it and
    the wrong host, and only parsing tells the two apart.
    """
    if not isinstance(endpoint, str) or not endpoint:
        return False
    try:
        parsed = urlparse(endpoint)
    except ValueError:
        return False
    if parsed.scheme != "https":
        return False
    return (parsed.hostname or "").lower() in PUSH_SERVICE_HOSTS


# the settings row holding the fingerprint of the token the stored registrations
# were made under (see ``drop_subscriptions_on_token_change`` in app.py)
TOKEN_SETTING = "app_token_fingerprint"


def token_fingerprint(token: str) -> str:
    """A comparable stand-in for the sign-in token, safe to keep on disk.

    Registrations are made by a device that presented the token, so they are
    only meaningful while that token is the token: rotating it is how a device
    is taken off the app, and a registration that outlives the rotation is a
    push still going to a phone that has been signed out. The full SHA-256 is
    stored rather than the token itself, so the thread database never holds the
    credential it is asked about.
    """
    return hashlib.sha256(token.encode()).hexdigest()


def endpoint_fingerprint(endpoint: str) -> str:
    """A short, stable, log-safe name for one push address.

    An endpoint URL is a bearer capability — anyone holding it can push to the
    phone — so it must never be written to a log. The last 8 characters of its
    SHA-256 are enough to tell one device's address from another's across lines
    and across runs, and carry nothing back to the address itself.
    """
    return hashlib.sha256((endpoint or "").encode()).hexdigest()[-FINGERPRINT_CHARS:]


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
    caller can drop it; True otherwise (delivered or transient failure).

    Every outcome names its address by fingerprint. That is the only way to read
    a run of these lines and see WHICH device each send went to — the failure
    this was written for was two accepted sends per result, one of them into a
    rotated-away address Apple still answers 201 for.
    """
    from pywebpush import WebPushException, webpush

    fingerprint = endpoint_fingerprint(subscription.get("endpoint", ""))
    try:
        response = webpush(
            subscription_info=subscription,
            data=payload,
            vapid_private_key=cfg.private_key,
            vapid_claims={"sub": cfg.subject},  # fresh each call (pywebpush mutates it)
            timeout=PUSH_TIMEOUT_SECONDS,
        )
        logger.info(
            "web push to %s accepted by provider (status %s)",
            fingerprint,
            getattr(response, "status_code", "unknown"),
        )
        return True
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (404, 410):
            logger.info("web push to %s gone (status %s)", fingerprint, status)
            return False  # expired/unsubscribed — drop it
        logger.warning("web push to %s failed (status %s): %s", fingerprint, status, exc)
        return True
    except Exception as exc:
        # Network timeouts and local encryption/key errors are not guaranteed
        # to be WebPushException instances. Push is best-effort: retain the
        # subscription for a later retry and never let it kill the relay.
        logger.warning(
            "web push to %s failed without provider response (%s)",
            fingerprint,
            type(exc).__name__,
        )
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
