"""The worker's own road to GitHub's pull request API (checklist 2.1).

The agent used to reach GitHub itself: the session env handed its shell a real
token, and ``gh`` turned that token into pull requests. This module is the other
half of taking the token away from it. Everything here runs **in the worker's
own process**, with a credential the agent never sees, and is reached only
through the three handoff tools in :mod:`paratrooper.agent.tools`.

Deliberately small: parse the remote into ``owner/repo``, list the open pull
requests the agent may continue, and open one. No merging (that authority lives
in the web service, behind Akash's Publish tap) and nothing that writes a repo
setting. Every failure raises :class:`GitHubError` with GitHub's own message in
it, so the tool can hand the agent something it can act on.

``client`` is injectable on every call so the tests drive these against
``httpx.MockTransport`` instead of the network.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

GITHUB_API = "https://api.github.com"
GITHUB_WEB = "https://github.com"

# `https://github.com/owner/repo.git`, `git@github.com:owner/repo.git`, and the
# same two without the suffix or with a trailing slash
_REMOTE_RE = re.compile(r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?/?$")

# a pull request list is small (the agent keeps at most a handful of branches),
# so one page is the whole answer rather than the first of many
_PAGE = 100
_TIMEOUT = 30.0


class GitHubError(RuntimeError):
    """A GitHub API call failed, or the remote cannot be read as owner/repo."""


def owner_repo(remote: str) -> tuple[str, str]:
    """Split a GitHub remote URL into ``(owner, repo)``. Raises rather than
    guessing: every call below writes to or reads from a named repository, and
    the wrong name is worse than no answer."""
    match = _REMOTE_RE.search(remote.strip())
    if not match:
        raise GitHubError(f"cannot read owner/repo out of the remote {remote!r}")
    return match.group("owner"), match.group("repo")


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _send(
    method: str,
    url: str,
    *,
    token: str,
    client: httpx.Client | None = None,
    **kwargs: Any,
) -> httpx.Response:
    if client is not None:
        return client.request(method, url, headers=_headers(token), timeout=_TIMEOUT, **kwargs)
    with httpx.Client(timeout=_TIMEOUT) as own:
        return own.request(method, url, headers=_headers(token), **kwargs)


def _fail(what: str, resp: httpx.Response) -> GitHubError:
    """One failure shape for every call: the status, and whatever GitHub said.
    A 401 here means the credential is wrong or expired, and there is no second
    credential to try — the turn fails and says so."""
    detail = resp.text.strip()
    return GitHubError(f"{what} failed: GitHub answered {resp.status_code} {detail[:400]}")


def _as_entry(pull: dict) -> dict[str, Any]:
    """The four fields the agent needs about a pull request, and nothing else:
    the API's own object is large and most of it is noise in a context window."""
    return {
        "number": pull.get("number"),
        "branch": (pull.get("head") or {}).get("ref"),
        "title": pull.get("title"),
        "url": pull.get("html_url"),
    }


def open_pull_requests(
    owner: str,
    repo: str,
    *,
    token: str,
    branch_prefix: str = "",
    client: httpx.Client | None = None,
) -> list[dict[str, Any]]:
    """The repository's open pull requests, narrowed to the agent's namespace.

    The filtering is done here rather than by the API's ``head`` parameter,
    which matches one exact ``owner:branch`` and cannot take a prefix — asking
    it for ``owner:paratrooper/`` returns nothing at all, which would read as
    "no pending work" and start a second branch for work already waiting."""
    resp = _send(
        "GET",
        f"{GITHUB_API}/repos/{owner}/{repo}/pulls",
        token=token,
        client=client,
        params={"state": "open", "per_page": _PAGE},
    )
    if resp.status_code != 200:
        raise _fail("listing the open pull requests", resp)
    entries = [_as_entry(pull) for pull in resp.json()]
    if not branch_prefix:
        return entries
    return [e for e in entries if (e["branch"] or "").startswith(branch_prefix)]


def find_open_pull_request(
    owner: str,
    repo: str,
    *,
    branch: str,
    token: str,
    client: httpx.Client | None = None,
) -> dict[str, Any] | None:
    """The open pull request whose head is ``branch``, or ``None``."""
    for entry in open_pull_requests(owner, repo, token=token, client=client):
        if entry["branch"] == branch:
            return entry
    return None


def create_pull_request(
    owner: str,
    repo: str,
    *,
    branch: str,
    base: str,
    title: str,
    body: str,
    token: str,
    client: httpx.Client | None = None,
) -> dict[str, Any]:
    """Open a pull request from ``branch`` into ``base`` and return its entry."""
    resp = _send(
        "POST",
        f"{GITHUB_API}/repos/{owner}/{repo}/pulls",
        token=token,
        client=client,
        json={"title": title, "body": body, "head": branch, "base": base},
    )
    if resp.status_code not in (200, 201):
        raise _fail(f"opening a pull request for '{branch}'", resp)
    return _as_entry(resp.json())


def branch_url(owner: str, repo: str, branch: str) -> str:
    """Where a pushed branch can be looked at. Not an API call — the worker
    hands this back from ``push_branch`` so the agent has something to name."""
    return f"{GITHUB_WEB}/{owner}/{repo}/tree/{branch}"
