"""Bootstrap of the website checkout — clone + bot commit identity, nothing else.

The agent runs git and ``gh`` through its own Bash now (branch, commit, push,
PR), fenced by the PreToolUse main-guard hook in ``hooks.py`` — that hook is the
enforcement of the merge boundary (never push/merge the default branch, never
force-push, no raw API). What remains here is the worker's first-boot plumbing:

* :meth:`ensure_checkout` — clone the site repo into ``root`` if it isn't one
  yet, then pin the repo-local ``user.name``/``user.email`` to the bot. Set once
  per checkout (idempotent, every boot) instead of per branch, so every commit
  the agent makes through its shell carries the linked bot attribution rather
  than the host's config.

Auth stays out of argv: a ``GIT_ASKPASS`` helper answers the clone's prompts
from the environment, so the PAT is never persisted into ``.git/config`` nor
visible in ``ps``. The same helper (:func:`write_askpass_helper`) is what the
worker hands to the agent's session env so the agent's own ``git`` authenticates
the same way.
"""

from __future__ import annotations

import os
import stat
import subprocess
import tempfile
from pathlib import Path

from .config import DEFAULT_GIT_EMAIL, DEFAULT_GIT_NAME


class GitError(RuntimeError):
    """A git command failed, or the bootstrap can't proceed (e.g. no remote)."""


# A GIT_ASKPASS helper instead of a token-in-URL remote: a URL with the PAT
# embedded gets persisted by clone into .git/config (plaintext at rest) and
# shows up in `ps` while the command runs. The helper file itself holds no
# secret — it answers git's prompts from the environment.
_ASKPASS = (
    "#!/bin/sh\n"
    'case "$1" in\n'
    '  [Uu]sername*) echo "x-access-token" ;;\n'
    '  *) printf \'%s\' "$PARATROOPER_GIT_ASKPASS_TOKEN" ;;\n'
    "esac\n"
)


def write_askpass_helper() -> str:
    """Materialize the askpass script to an executable temp file and return its
    path. The file carries no secret (it echoes ``$PARATROOPER_GIT_ASKPASS_TOKEN``
    by name) and is never deleted, so the path stays valid for the life of any
    consumer it is handed to — a clone env here, an agent session in the worker."""
    fd, path = tempfile.mkstemp(prefix="paratrooper-askpass-")
    with os.fdopen(fd, "w") as fh:
        fh.write(_ASKPASS)
    os.chmod(path, stat.S_IRWXU)
    return path


class SiteRepo:
    def __init__(
        self,
        site_root: Path,
        *,
        default_branch: str = "main",
        github_token: str | None = None,
        remote: str | None = None,
        git_name: str = DEFAULT_GIT_NAME,
        git_email: str = DEFAULT_GIT_EMAIL,
    ) -> None:
        self.root = Path(site_root)
        self.default_branch = default_branch
        self._token = github_token
        self._remote = remote
        self._askpass: str | None = None
        self.git_name = git_name
        self.git_email = git_email

    # --- git plumbing --------------------------------------------------------

    def _git(self, *args: str, check: bool = True, env: dict[str, str] | None = None) -> str:
        proc = subprocess.run(
            ["git", *args],
            cwd=self.root,
            capture_output=True,
            text=True,
            env=env,
        )
        if check and proc.returncode != 0:
            raise GitError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
        return proc.stdout.strip()

    def remote_url(self) -> str:
        return self._remote or self._git("remote", "get-url", "origin")

    def _auth_env(self) -> dict[str, str] | None:
        """Env for git commands that must authenticate: askpass helper wired to
        the token. None (inherit untouched env) without a token/HTTPS remote."""
        if not (self._token and self.remote_url().startswith("https://")):
            return None
        if self._askpass is None:
            self._askpass = write_askpass_helper()
        return {
            **os.environ,
            "GIT_ASKPASS": self._askpass,
            "PARATROOPER_GIT_ASKPASS_TOKEN": self._token,
            "GIT_TERMINAL_PROMPT": "0",  # fail fast, never hang on a prompt
        }

    # --- bootstrap -----------------------------------------------------------

    def ensure_checkout(self) -> None:
        """Clone the site repo into ``root`` if it isn't already a checkout,
        then pin the repo-local commit identity to the bot (the worker's
        first-boot bootstrap; idempotent). Cloning needs a configured remote —
        the checkout doesn't exist yet, so ``origin`` can't be read."""
        if not (self.root / ".git").is_dir():
            if not self._remote:
                raise GitError(
                    "cannot clone site repo: no remote configured (set PARATROOPER_REMOTE)"
                )
            self.root.parent.mkdir(parents=True, exist_ok=True)
            clone = [
                "git", "clone", "--branch", self.default_branch,
                self.remote_url(), str(self.root),
            ]
            proc = subprocess.run(clone, capture_output=True, text=True, env=self._auth_env())
            if proc.returncode != 0:
                raise GitError(f"site clone failed: {proc.stderr.strip()}")
        # identity once per checkout, not per branch: the agent commits through
        # its own shell, and this repo-local config is what makes those commits
        # carry the linked bot attribution instead of the host's identity
        self._git("config", "user.name", self.git_name)
        self._git("config", "user.email", self.git_email)
