"""The worker's GitHub credential: hourly installation tokens (checklist 2.2).

Until this item the worker used a personal access token that never expired. It
now signs a short-lived JWT with the ``paratrooper-98cc`` App's private key,
exchanges it for an installation token scoped to the one repository the App is
installed on, and uses that. Two things follow, and both are the point:

* a token that leaks is dead within the hour, and carries only the App's own
  permissions on the one named repository;
* the pull requests are authored by ``paratrooper-98cc[bot]``, which is already
  the commit identity, so the bot finally owns its own work end to end.

No fallback anywhere in here. A missing value, an unreadable key or a refusal
from GitHub is an error naming what failed; nothing reaches for a second
credential, because there is not supposed to be one.

The token is held in this module between turns and re-minted when fewer than
ten minutes remain on it, so an ordinary hour of messages costs one mint.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
import jwt

from .config import Config, ConfigError, GitHubApp, take_github_app
from .github import GITHUB_API, owner_repo

# GitHub refuses a JWT whose lifetime is over ten minutes, and rejects one whose
# `iat` is in its future, so the issue time is backdated by a minute against
# clock drift and the lifetime is kept a minute under the ceiling.
JWT_LIFETIME = 540
JWT_BACKDATE = 60
# re-mint once less than this is left: a token that expires mid-push is a failed
# turn, and ten minutes is longer than any turn has ever taken
REFRESH_MARGIN = 600
_TIMEOUT = 30.0


class GitHubAppError(RuntimeError):
    """Minting an installation token failed. Never retried with anything else."""


@dataclass(frozen=True)
class InstallationToken:
    token: str
    expires_at: datetime

    def stale(self, *, now: datetime | None = None) -> bool:
        moment = now or datetime.now(UTC)
        return (self.expires_at - moment).total_seconds() < REFRESH_MARGIN


def build_jwt(app: GitHubApp, *, issued_at: int | None = None) -> str:
    """The App's own assertion, signed with its private key. It authenticates
    the App to GitHub just long enough to ask for an installation token; it is
    not a repository credential and cannot touch one."""
    moment = int(issued_at if issued_at is not None else time.time())
    try:
        return jwt.encode(
            {
                "iat": moment - JWT_BACKDATE,
                "exp": moment + JWT_LIFETIME,
                "iss": app.app_id,
            },
            app.private_key,
            algorithm="RS256",
        )
    except Exception as exc:  # a malformed or truncated key file
        raise GitHubAppError(
            f"the GitHub App's private key could not sign a token: {exc}"
        ) from exc


def mint_installation_token(
    app: GitHubApp,
    *,
    repositories: list[str] | None = None,
    client: httpx.Client | None = None,
    issued_at: int | None = None,
) -> InstallationToken:
    """Exchange a fresh App JWT for an installation token, narrowed to
    ``repositories`` when given. Any refusal is a :class:`GitHubAppError`."""
    url = f"{GITHUB_API}/app/installations/{app.installation_id}/access_tokens"
    headers = {
        "Authorization": f"Bearer {build_jwt(app, issued_at=issued_at)}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    body = {"repositories": repositories} if repositories else {}
    try:
        if client is not None:
            resp = client.post(url, headers=headers, json=body, timeout=_TIMEOUT)
        else:
            with httpx.Client(timeout=_TIMEOUT) as own:
                resp = own.post(url, headers=headers, json=body)
    except httpx.HTTPError as exc:
        raise GitHubAppError(f"could not reach GitHub to mint a token: {exc}") from exc
    if resp.status_code != 201:
        raise GitHubAppError(
            "GitHub refused to mint an installation token for app "
            f"{app.app_id} installation {app.installation_id}: "
            f"{resp.status_code} {resp.text.strip()[:400]}"
        )
    payload = resp.json()
    token = payload.get("token")
    expires = payload.get("expires_at")
    if not token or not expires:
        raise GitHubAppError(
            "GitHub's answer carried no token and expiry to use: "
            f"{sorted(payload)}"
        )
    return InstallationToken(token=token, expires_at=datetime.fromisoformat(expires))


# the one token this worker is using, held between turns
_held: InstallationToken | None = None


def reset_cache() -> None:
    """Forget the held token. For tests; nothing in the worker calls it."""
    global _held
    _held = None


def installation_token(
    config: Config,
    *,
    client: httpx.Client | None = None,
    now: datetime | None = None,
) -> str:
    """The credential the worker authenticates with, minted if the one held has
    fewer than ten minutes left on it.

    Raises :class:`ConfigError` when the App is not configured at all (a local
    run, where the handoff tools then say so and nothing else changes) and
    :class:`GitHubAppError` when it is configured and GitHub refuses, which is a
    failed turn rather than a quiet degrade."""
    global _held
    app = take_github_app()
    if not config.remote:
        raise ConfigError(
            "no site repository is configured (set PARATROOPER_REMOTE): an "
            "installation token is minted for one named repository, so there is "
            "nothing to ask for without it"
        )
    if _held is None or _held.stale(now=now):
        _, repo = owner_repo(config.remote)
        _held = mint_installation_token(app, repositories=[repo], client=client)
    return _held.token
