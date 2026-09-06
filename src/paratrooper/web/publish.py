"""Merge authority (checklist 4.4) — lives ONLY in the web service.

The agent/worker proposes (branch + PR); the human disposes (taps Publish). This
module merges the PR via the GitHub API using the web service's merge credential.
`main` is set to require-PR-before-merge so nothing reaches the live site
unreviewed.

v1 limitation (documented, Open Q#1): the merge token may be the same
fine-grained PAT the worker holds (push and merge share host + scope on a
personal repo), so this stops a misbehaving agent but not a stolen worker token.
A credential-level wall (GitHub App / org actor-restriction) is deferred — hence
the separate ``PARATROOPER_MERGE_TOKEN`` env var, so an operator can swap in a
distinct identity later without code changes.

WHAT A PUBLISH TAP IS ALLOWED TO MERGE. The owner and repository come from
configuration; only the PR number comes off the phone. That left three things
unchecked, and :func:`check_publishable` is where they are checked now, before
any merge call goes out:

* the head branch must be one of the agent's own (the configured prefix), so a
  number naming somebody else's pull request cannot be merged by tapping
  Publish;
* the head repository must be the configured one, so a pull request opened from
  a fork cannot ride in on a number either;
* the head commit is pinned into the merge call. GitHub's merge endpoint takes a
  ``sha`` that must still be the branch's head and refuses with 409 otherwise,
  so a branch that gained commits between the screenshot the owner approved and
  the tap that merges it is refused rather than merged.
"""

from __future__ import annotations

import contextlib
import os
import re
from collections.abc import Iterator

import httpx

_GITHUB_API = "https://api.github.com"
_REMOTE_RE = re.compile(r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?$")
_PR_NUM_RE = re.compile(r"/pull/(\d+)")
_TIMEOUT = 30.0

# The three refusals, worded for the phone: they are shown to the owner as-is,
# so they say what happened and what to do, and name nothing from inside the
# machine.
NOT_AGENT_BRANCH = "That is not one of Paratrooper's own branches, so nothing was published."
WRONG_REPOSITORY = "That pull request is on a different repository, so nothing was published."
BRANCH_CHANGED = (
    "That branch changed after the preview you approved, so nothing was published. "
    "Ask for a new preview and publish that one."
)


class PublishError(RuntimeError):
    pass


@contextlib.contextmanager
def _session(client: httpx.Client | None) -> Iterator[httpx.Client]:
    """The HTTP client these calls run on. Tests hand in one built on
    ``httpx.MockTransport``; production opens its own and closes it again."""
    if client is not None:
        yield client
        return
    with httpx.Client(timeout=_TIMEOUT) as opened:
        yield opened


def is_agent_branch(ref: str, branch_prefix: str) -> bool:
    """Is ``ref`` a branch inside the agent's namespace?

    The prefix names a namespace, so the separator is part of the test: a bare
    ``startswith`` would also accept ``paratrooperX/whatever``, which is a
    branch anyone with push rights could create and is not the agent's.
    """
    if not branch_prefix:
        return False
    return ref == branch_prefix or ref.startswith(f"{branch_prefix}/")


def merge_token() -> str:
    """The web service's merge credential — a dedicated token if provided, else
    the shared PAT (v1)."""
    tok = os.environ.get("PARATROOPER_MERGE_TOKEN") or os.environ.get("PARATROOPER_GITHUB_TOKEN")
    if not tok:
        raise PublishError(
            "no merge token (set PARATROOPER_MERGE_TOKEN or PARATROOPER_GITHUB_TOKEN)"
        )
    return tok


def owner_repo_from_remote(remote: str) -> tuple[str, str]:
    m = _REMOTE_RE.search(remote)
    if not m:
        raise PublishError(f"cannot parse owner/repo from remote {remote!r}")
    return m.group("owner"), m.group("repo")


def parse_pr_number(pr: str) -> int:
    """Accept a PR url (``.../pull/12``) or a bare number/string."""
    m = _PR_NUM_RE.search(pr)
    if m:
        return int(m.group(1))
    pr = pr.strip().lstrip("#")
    if pr.isdigit():
        return int(pr)
    raise PublishError(f"cannot parse a PR number from {pr!r}")


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def find_open_pr(
    owner: str, repo: str, *, token: str, branch_prefix: str = "",
    client: httpx.Client | None = None,
) -> dict:
    """Resolve THE open agent PR when the phone lost the ref (pr rows persisted
    as ``body=""`` before payloads were serialized). Exactly one open PR may
    match the branch prefix; zero or several is a :class:`PublishError` — never
    guess which PR a Publish tap meant."""
    with _session(client) as http:
        resp = http.get(
            f"{_GITHUB_API}/repos/{owner}/{repo}/pulls",
            headers=_headers(token),
            params={"state": "open", "per_page": 30},
        )
    if resp.status_code != 200:
        raise PublishError(f"PR lookup failed ({resp.status_code}): {resp.text}")
    prs = resp.json()
    if branch_prefix:
        prs = [
            p for p in prs
            if is_agent_branch(str(p.get("head", {}).get("ref", "")), branch_prefix)
        ]
    if not prs:
        raise PublishError("no open PR to publish")
    if len(prs) > 1:
        raise PublishError(f"{len(prs)} open PRs; ask the agent which one to publish")
    return prs[0]


def get_pull_request(
    owner: str, repo: str, number: int, *, token: str, client: httpx.Client | None = None
) -> dict:
    """Read one pull request from GitHub — the state :func:`check_publishable`
    is asked about. Read before every merge: the phone supplies only a number,
    so nothing about the branch behind it is known until this call."""
    with _session(client) as http:
        resp = http.get(
            f"{_GITHUB_API}/repos/{owner}/{repo}/pulls/{number}", headers=_headers(token)
        )
    if resp.status_code != 200:
        raise PublishError(f"could not read PR #{number} ({resp.status_code}): {resp.text}")
    return resp.json()


def check_publishable(pr: dict, *, owner: str, repo: str, branch_prefix: str) -> str:
    """Refuse anything a Publish tap must not merge; return the head commit to
    pin the merge to.

    Raises :class:`PublishError` carrying one of the three refusals at the top
    of this module — the message goes straight to the phone, so the reason is
    the message.
    """
    head = pr.get("head") or {}
    head_repo = head.get("repo") or {}
    full_name = str(head_repo.get("full_name") or "")
    if full_name.lower() != f"{owner}/{repo}".lower():
        raise PublishError(WRONG_REPOSITORY)
    if not is_agent_branch(str(head.get("ref") or ""), branch_prefix):
        raise PublishError(NOT_AGENT_BRANCH)
    sha = str(head.get("sha") or "")
    if not sha:
        # no head commit to pin means no way to tell an unchanged branch from a
        # changed one, and an unpinned merge is the thing this exists to stop
        raise PublishError(BRANCH_CHANGED)
    return sha


def merge_pull_request(
    owner: str, repo: str, number: int, *, token: str, method: str = "squash",
    sha: str | None = None, client: httpx.Client | None = None,
) -> dict:
    """Merge a PR via the GitHub API, pinned to ``sha``. Raises
    :class:`PublishError` if the API reports the PR isn't mergeable.

    GitHub answers 409 when the pinned commit is no longer the branch's head,
    which is exactly the branch-moved-under-the-screenshot case, so that status
    is reported as such rather than as a bare merge failure."""
    body: dict[str, str] = {"merge_method": method}
    if sha:
        body["sha"] = sha
    with _session(client) as http:
        resp = http.put(
            f"{_GITHUB_API}/repos/{owner}/{repo}/pulls/{number}/merge",
            headers=_headers(token),
            json=body,
        )
    if resp.status_code == 409 and sha:
        raise PublishError(BRANCH_CHANGED)
    if resp.status_code != 200:
        raise PublishError(f"merge failed ({resp.status_code}): {resp.text}")
    return resp.json()
