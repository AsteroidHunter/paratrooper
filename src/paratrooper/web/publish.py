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
"""

from __future__ import annotations

import os
import re

import httpx

_GITHUB_API = "https://api.github.com"
_REMOTE_RE = re.compile(r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?$")
_PR_NUM_RE = re.compile(r"/pull/(\d+)")


class PublishError(RuntimeError):
    pass


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


def merge_pull_request(
    owner: str, repo: str, number: int, *, token: str, method: str = "squash"
) -> dict:
    """Merge a PR via the GitHub API. Raises :class:`PublishError` if the API
    reports the PR isn't mergeable."""
    resp = httpx.put(
        f"{_GITHUB_API}/repos/{owner}/{repo}/pulls/{number}/merge",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        json={"merge_method": method},
        timeout=30.0,
    )
    if resp.status_code != 200:
        raise PublishError(f"merge failed ({resp.status_code}): {resp.text}")
    return resp.json()
