"""Controlled git operations on the website checkout — branches only, never main.

The worker holds a fine-grained PAT (Contents + Pull requests write). This class
is the *clean* git path the worker/tools use; it structurally cannot merge or
touch the default branch:

* :meth:`prepare_branch` (checklist 3.5) — ``git fetch`` + reset local default
  branch to ``origin/<default>`` (so a just-published merge isn't missed and a
  new branch never forks from a stale board), then create the fresh
  ``<prefix>/<pin-id>-<slug>`` branch from it.
* :meth:`commit_all` / :meth:`push_branch` — commit the worktree and push the
  feature branch. ``push_branch`` refuses the default branch outright.
* :meth:`open_pr` — open a PR (``base`` = default branch) via the GitHub API.
  Opening a PR is not merging it; the merge happens in the web service on the
  human's Publish tap.

(The agent's *own* git-via-Bash is independently fenced by the PreToolUse hook
in ``hooks.py`` — this is the typed, auditable path; that is the backstop.)
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import httpx

_GITHUB_API = "https://api.github.com"
_REMOTE_RE = re.compile(r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?$")


class GitError(RuntimeError):
    """A git command failed, or an operation that would touch the default branch
    was refused."""


class SiteRepo:
    def __init__(
        self,
        site_root: Path,
        *,
        default_branch: str = "main",
        branch_prefix: str = "paratrooper",
        github_token: str | None = None,
        remote: str | None = None,
    ) -> None:
        self.root = Path(site_root)
        self.default_branch = default_branch
        self.branch_prefix = branch_prefix
        self._token = github_token
        self._remote = remote

    # --- git plumbing --------------------------------------------------------

    def _git(self, *args: str, check: bool = True) -> str:
        proc = subprocess.run(
            ["git", *args],
            cwd=self.root,
            capture_output=True,
            text=True,
        )
        if check and proc.returncode != 0:
            raise GitError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
        return proc.stdout.strip()

    def current_branch(self) -> str:
        return self._git("rev-parse", "--abbrev-ref", "HEAD")

    def remote_url(self) -> str:
        return self._remote or self._git("remote", "get-url", "origin")

    def _owner_repo(self) -> tuple[str, str]:
        m = _REMOTE_RE.search(self.remote_url())
        if not m:
            raise GitError(f"cannot parse owner/repo from remote {self.remote_url()!r}")
        return m.group("owner"), m.group("repo")

    def _authed_remote(self) -> str:
        """HTTPS remote with the PAT injected for push (token never logged)."""
        url = self.remote_url()
        if self._token and url.startswith("https://"):
            return url.replace("https://", f"https://x-access-token:{self._token}@", 1)
        return url

    # --- bootstrap -----------------------------------------------------------

    def ensure_checkout(self) -> None:
        """Clone the site repo into ``root`` if it isn't already a checkout (the
        worker's first-boot bootstrap). Needs a configured remote — the checkout
        doesn't exist yet, so ``origin`` can't be read."""
        if (self.root / ".git").is_dir():
            return
        if not self._remote:
            raise GitError("cannot clone site repo: no remote configured (set PARATROOPER_REMOTE)")
        self.root.parent.mkdir(parents=True, exist_ok=True)
        clone = [
            "git", "clone", "--branch", self.default_branch,
            self._authed_remote(), str(self.root),
        ]
        proc = subprocess.run(clone, capture_output=True, text=True)
        if proc.returncode != 0:
            raise GitError(f"site clone failed: {proc.stderr.strip()}")

    # --- branch strategy (3.5) ----------------------------------------------

    def branch_name(self, *parts: str) -> str:
        """``<prefix>/<part>-<part>...`` from pre-slugified, possibly-empty parts
        (an *add* has no pin id yet, so the request slug carries the name)."""
        tail = "-".join(p for p in parts if p)
        return f"{self.branch_prefix}/{tail or 'update'}"

    def prepare_branch(self, *name_parts: str) -> str:
        """Fetch, hard-reset the local default branch to ``origin/<default>``,
        and create+check out the fresh feature branch from it. Returns the
        branch name. Run once per request, before the agent edits anything."""
        self._git("fetch", "origin", self.default_branch)
        # reset local default branch to the just-fetched origin tip (don't miss a merge)
        self._git("checkout", "-B", self.default_branch, f"origin/{self.default_branch}")
        branch = self.branch_name(*name_parts)
        self._git("checkout", "-B", branch)  # fork the feature branch from fresh default
        return branch

    # --- commit / push (branches only) --------------------------------------

    def commit_all(self, message: str) -> str:
        """Stage the whole worktree and commit. Returns the new commit sha. No-op
        commits raise (nothing to commit is a caller bug worth surfacing)."""
        self._git("add", "-A")
        self._git("commit", "-m", message)
        return self._git("rev-parse", "HEAD")

    def push_branch(self, branch: str) -> None:
        """Push a feature branch to origin. **Refuses the default branch** — the
        worker may never push main."""
        if branch == self.default_branch:
            raise GitError(f"refusing to push the default branch {branch!r}")
        self._git("push", "--set-upstream", self._authed_remote(), f"{branch}:{branch}")

    # --- pull request (open, not merge) -------------------------------------

    def _gh_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def open_pr(self, branch: str, title: str, body: str = "") -> str:
        """Open a PR from ``branch`` into the default branch via the GitHub API,
        or return the EXISTING open PR for that branch (pushing more commits to
        a branch with a PR is normal — the caller still needs the URL so the
        phone gets its Publish button). Returns html_url. Opening ≠ merging."""
        if not self._token:
            raise GitError("no GitHub token configured; cannot open a PR")
        owner, repo = self._owner_repo()
        resp = httpx.post(
            f"{_GITHUB_API}/repos/{owner}/{repo}/pulls",
            headers=self._gh_headers(),
            json={"title": title, "head": branch, "base": self.default_branch, "body": body},
            timeout=30.0,
        )
        if resp.status_code in (200, 201):
            return resp.json()["html_url"]
        if resp.status_code == 422 and "already exists" in resp.text:
            existing = httpx.get(
                f"{_GITHUB_API}/repos/{owner}/{repo}/pulls",
                headers=self._gh_headers(),
                params={"head": f"{owner}:{branch}", "state": "open"},
                timeout=30.0,
            )
            if existing.status_code == 200 and existing.json():
                return existing.json()[0]["html_url"]
        raise GitError(f"PR open failed ({resp.status_code}): {resp.text}")
