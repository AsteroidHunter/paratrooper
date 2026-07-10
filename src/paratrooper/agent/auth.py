"""Agent auth: a **manual mode**, LOUD failure, no fallback, no escape hatch.

``AGENT_AUTH`` is set explicitly by the operator to ``subscription`` or ``api``.
The selected mode reads only its own credential and **hard-errors** if it's
missing — there is no silent switch to the other mode, no retry on the
alternate, no catch. Auth failure crashes the job, visibly. (User's emphatic,
documented choice — Open Q#4.)

Subtlety that makes this necessary: the Agent SDK's credential precedence puts
``ANTHROPIC_API_KEY`` / ``ANTHROPIC_AUTH_TOKEN`` *above* ``CLAUDE_CODE_OAUTH_TOKEN``.
So ``subscription`` mode doesn't just require the OAuth token — it must also
**clear** the API-key vars from the process env, or a stray key would silently
take precedence and bill metered API (the exact failure the user forbade).
"""

from __future__ import annotations

import os

from .config import ConfigError

OAUTH_VAR = "CLAUDE_CODE_OAUTH_TOKEN"
API_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")


def configure_auth(mode: str | None = None) -> str:
    """Validate and lock in the auth mode, mutating ``os.environ`` so the SDK
    can only use the selected credential. Returns the resolved mode.

    Raises :class:`ConfigError` (loudly) if ``AGENT_AUTH`` is unset/invalid or
    the selected mode's credential is missing. Never falls back.
    """
    mode = (mode if mode is not None else os.environ.get("AGENT_AUTH", "")).strip().lower()

    if mode == "subscription":
        if not os.environ.get(OAUTH_VAR):
            raise ConfigError(
                f"AGENT_AUTH=subscription but {OAUTH_VAR} is unset. "
                "Generate one with `claude setup-token`. No fallback to API billing."
            )
        # Clear API creds so they can't silently win the SDK's precedence order.
        for var in API_VARS:
            os.environ.pop(var, None)
        return "subscription"

    if mode == "api":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise ConfigError(
                "AGENT_AUTH=api but ANTHROPIC_API_KEY is unset. No fallback to subscription."
            )
        os.environ.pop(OAUTH_VAR, None)  # avoid ambiguity; api was explicitly chosen
        return "api"

    raise ConfigError(
        f"AGENT_AUTH must be explicitly 'subscription' or 'api' (got {mode!r}). "
        "There is no default and no fallback — the operator chooses."
    )
