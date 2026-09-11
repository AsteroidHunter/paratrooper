"""The worker's own git: the checkout, and the two commands that reach GitHub.

The agent branches, edits and commits in its own Bash, fenced by the PreToolUse
main-guard hook in ``hooks.py``. What it can no longer do is reach GitHub at
all: its session carries no token, so every command that opens a connection
runs **here instead**, in the worker's process, with a credential the agent
never sees.

* :meth:`ensure_checkout` — clone the site repo into ``root`` if it isn't one
  yet, then pin the repo-local ``user.name``/``user.email`` to the bot. Set once
  per checkout (idempotent, every boot) instead of per branch, so every commit
  the agent makes through its shell carries the linked bot attribution rather
  than the host's config.
* :meth:`fetch` — refresh ``origin/*`` before a turn starts. The agent used to
  run ``git fetch`` itself; without a credential it cannot, and a checkout left
  at boot state would have it branch off a stale default branch and miss the
  branch of an open pull request it is meant to continue.
* :meth:`push_branch` — the push behind the ``push_branch`` tool.

Auth stays out of argv: a ``GIT_ASKPASS`` helper answers git's prompts from the
environment, so the token is never persisted into ``.git/config`` nor visible
in ``ps``. It is no longer handed to the agent's session at all.

The two commands the agent can trigger (fetch, push) run with the same
allowlisted environment the site build uses — nothing but ``PATH``, ``HOME``,
``LANG``, ``TMPDIR`` and the askpass wiring — so a turn can never carry one of
the worker's other secrets into a git subprocess. The clone keeps the inherited
environment it has always had: it runs once at boot, before any agent exists.

**Where the credential is allowed to go.** Both of them authenticate against
:meth:`SiteRepo.configured_remote`, the full URL the worker was configured with,
and never against the name ``origin``. The agent can write ``.git/config`` and
``.git/hooks`` with its file tools and could point ``origin`` anywhere, so a push
"to origin" would have handed a freshly minted token to whatever host the
checkout last named. Four things stand behind that before either command runs:
the checkout's ``origin`` still has to match the configured repository; the
checkout's own config must carry no URL rewrite, credential helper or ``http.*``
setting, while the user and system config files, which the agent can write too,
are switched off outright for these commands; the askpass helper answers for one
host and no other; and every command that carries the credential runs its own
hooks from nowhere (:data:`_NO_HOOKS`).

Note for anyone reading this next to the CLI's shell sandbox: these run in the
worker's own process, which nothing sandboxes. Neither does anything sandbox the
agent's shells — the switch that wrapped them in bubblewrap is off, because the
platform will not let that sandbox start. So every write the agent can reach the
checkout with is a write it can reach with ordinary shell code too, which is why
the fences above are all in this process rather than in the shell's. The push
itself sets no upstream and writes no config at all, which is what the old worry
about ``git push -u`` was about.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import tempfile
from pathlib import Path

from .config import DEFAULT_GIT_EMAIL, DEFAULT_GIT_NAME
from .screenshot import ENV_PASSTHROUGH, FALLBACK_PATH


class GitError(RuntimeError):
    """A git command failed, or the bootstrap can't proceed (e.g. no remote)."""


# A GIT_ASKPASS helper instead of a token-in-URL remote: a URL with the token
# embedded gets persisted by clone into .git/config (plaintext at rest) and
# shows up in `ps` while the command runs. The helper file itself holds no
# secret — it answers git's prompts from the environment.
#
# It answers for ONE host, named in PARATROOPER_GIT_ASKPASS_HOST, and exits
# without a word for anything else. Git asks whoever the URL points at, and
# until this phase the URL could be whatever the checkout said: the agent can
# write .git/config with its file tools, so "push to origin" was "hand the
# credential to whatever host the agent last wrote there". The host test is
# anchored on the separators around it (``://host/``, ``://host'``, ``@host/``,
# ``@host'``) so a look-alike like ``github.com.example.net`` does not match the
# way a bare substring search would.
_ASKPASS = (
    "#!/bin/sh\n"
    'host="${PARATROOPER_GIT_ASKPASS_HOST:-}"\n'
    '[ -n "$host" ] || exit 1\n'
    'case "$1" in\n'
    '  *"://$host/"*|*"://$host\'"*|*"@$host/"*|*"@$host\'"*) ;;\n'
    "  *) exit 1 ;;\n"
    "esac\n"
    'case "$1" in\n'
    '  [Uu]sername*) echo "x-access-token" ;;\n'
    '  *) printf \'%s\' "$PARATROOPER_GIT_ASKPASS_TOKEN" ;;\n'
    "esac\n"
)

# the host out of an https or ssh remote: `https://github.com/o/r.git` and
# `git@github.com:o/r.git` both answer `github.com`
_HOST_RE = re.compile(r"^(?:[a-zA-Z][\w+.-]*://)?(?:[^/@]*@)?(?P<host>[^/:]+)")


def remote_host(url: str) -> str:
    """The host a remote URL points at, for the askpass helper's one question.

    An address with no host at all — a local path, a ``file://`` URL, which is
    what a local rehearsal uses — answers the empty string. Nothing there wants
    a credential, and the helper refuses to answer when it is told no host, so
    the empty answer is the safe one rather than a hole."""
    match = _HOST_RE.match(url.strip())
    return match.group("host") if match else ""


def _normalize_remote(url: str) -> str:
    """A remote URL in comparable form: no trailing slash, no ``.git`` suffix,
    case folded. Two spellings of the same repository compare equal; a different
    host, owner or repository does not."""
    text = url.strip().rstrip("/")
    return text.removesuffix(".git").casefold()


# git settings that can send a credential somewhere else or capture it on the
# way past: a URL rewrite (`url.<base>.insteadOf`), a credential helper, or the
# http.* family (proxy, extra headers). All three are lines the agent could
# write, and each scope is dealt with in the way that scope allows. The user and
# system files are switched off outright for these commands (see
# _clean_auth_env) — stronger than a check, and free of false alarms on a
# machine where a global credential helper is perfectly ordinary. The
# repository's own config cannot be switched off, since it is the checkout, so
# it is read instead, and a checkout carrying any of these keys is refused.
_TAMPER_KEYS_RE = r"^(url\.|credential\.|http\.)"

# No hooks, for any command that carries the credential. A hook is a script in
# the checkout that git runs itself, with the command's own environment: a
# `pre-push` file is the whole of it, and a push would hand that script the very
# token it is authenticating with. `.git/hooks` is a directory the agent's
# file tools can write, and `core.hooksPath` in the checkout's own config moves
# the directory git looks in, so neither the file nor the setting is something
# this process can rely on being untouched.
#
# `-c` on the command line is config at the highest precedence git has: it beats
# the repository's config, the user's and the system's, so this is a decision
# made per command rather than a setting in a file that the thing it is fencing
# can rewrite. `/dev/null` is not a directory, so the hook path git builds from
# it (`/dev/null/pre-push`) cannot exist and every hook lookup comes back empty
# — nothing runs, and nothing has to be listed by name.
#
# It is not the same thing as `push --no-verify`: that skips `pre-push` on a
# push and nothing else, and fetch and clone run hooks too
# (`reference-transaction` on a fetch's ref updates, `post-checkout` from a
# template on a clone).
_NO_HOOKS = ("-c", "core.hooksPath=/dev/null")


def write_askpass_helper() -> str:
    """Materialize the askpass script to an executable temp file and return its
    path. The file carries no secret (it echoes ``$PARATROOPER_GIT_ASKPASS_TOKEN``
    by name) and is never deleted, so the path stays valid for the life of any
    consumer it is handed to — the boot clone, and the worker's own fetch and
    push. It is no longer handed to an agent session: nothing in the agent's
    shell has a token for it to answer with."""
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

    def _authenticated_git(self, url: str, *args: str) -> str:
        """Run one git command with the credential wired in, and no hooks.

        The two halves travel together because they are one decision: a command
        that can answer a credential prompt is a command no script out of the
        checkout may run inside. Every caller that authenticates goes through
        here, so there is one place to read rather than a flag to remember at
        each call site."""
        return self._git(*_NO_HOOKS, *args, env=self._clean_auth_env(url))

    def remote_url(self) -> str:
        return self._remote or self._git("remote", "get-url", "origin")

    def _askpass_wiring(self, url: str) -> dict[str, str]:
        """The values git needs to answer its own credential prompt, including
        the one host the helper is allowed to answer for."""
        if self._askpass is None:
            self._askpass = write_askpass_helper()
        return {
            "GIT_ASKPASS": self._askpass,
            "PARATROOPER_GIT_ASKPASS_TOKEN": self._token or "",
            "PARATROOPER_GIT_ASKPASS_HOST": remote_host(url),
            "GIT_TERMINAL_PROMPT": "0",  # fail fast, never hang on a prompt
        }

    def _auth_env(self) -> dict[str, str] | None:
        """Env for the boot clone: the inherited environment plus the askpass
        helper wired to the token. None (inherit untouched) without a
        token/HTTPS remote. It runs at boot, with no checkout and no session in
        existence, so there is nothing yet to have been tampered with."""
        url = self.remote_url()
        if not (self._token and url.startswith("https://")):
            return None
        return {**os.environ, **self._askpass_wiring(url)}

    def _clean_auth_env(self, url: str) -> dict[str, str]:
        """Env for the commands a turn can trigger (fetch, push): the site
        build's allowlist and the askpass wiring, nothing else.

        The worker holds the Claude credential, the queue address and the App's
        private key in its own environment and memory. A git subprocess needs
        none of them, and building the environment from a list of what is needed
        is the only shape where a secret added later does not silently join
        every push."""
        env = {k: v for k in ENV_PASSTHROUGH if (v := os.environ.get(k))}
        env["PATH"] = env.get("PATH") or FALLBACK_PATH
        # the user and system config files are switched off for these two
        # commands. ``~/.gitconfig`` is writable by the agent, and a single
        # ``url.<somewhere>.insteadOf`` line in it would redirect the explicit
        # URL below without changing anything this code can see.
        env["GIT_CONFIG_GLOBAL"] = os.devnull
        env["GIT_CONFIG_SYSTEM"] = os.devnull
        return {**env, **self._askpass_wiring(url)}

    # --- the two commands that reach GitHub ----------------------------------

    def configured_remote(self) -> str:
        """The site repository this worker is configured for, as a full URL.

        Everything that authenticates uses this and never the name ``origin``,
        and never a URL read back out of the checkout. The agent can write
        ``.git/config`` (its file tools are not inside the CLI's shell sandbox),
        so "push to origin" would have meant "hand the credential to whatever
        host the checkout last named"."""
        if not self._remote:
            raise GitError(
                "no site repository is configured (set PARATROOPER_REMOTE): the "
                "worker authenticates only against the repository it is configured "
                "with, never against whatever the checkout calls 'origin'"
            )
        return self._remote

    def _verified_remote(self) -> str:
        """The configured repository URL, after checking that the checkout still
        agrees with it and carries nothing that could redirect or capture a
        credential. Raises rather than pushing anywhere it is unsure of."""
        configured = self.configured_remote()
        try:
            actual = self._git("remote", "get-url", "origin")
        except GitError as exc:
            raise GitError(
                "the checkout has no 'origin' to compare with the configured site "
                f"repository, so nothing here can be trusted to authenticate: {exc}"
            ) from exc
        if _normalize_remote(actual) != _normalize_remote(configured):
            raise GitError(
                f"the checkout's origin is {actual!r}, but the configured site "
                f"repository is {configured!r}. Refusing to authenticate against a "
                "checkout whose remote has been changed"
            )
        proc = subprocess.run(
            ["git", "config", "--local", "--get-regexp", _TAMPER_KEYS_RE],
            cwd=self.root,
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            # names only, never the values: one of these could itself be a secret
            keys = sorted({line.split()[0] for line in proc.stdout.splitlines() if line.strip()})
            raise GitError(
                "the checkout's own git config carries settings that can redirect "
                f"or capture a credential ({', '.join(keys)}). Refusing to "
                "authenticate until they are gone"
            )
        return configured

    def fetch(self) -> None:
        """Refresh ``origin/*`` (pruning branches gone from the remote).

        Runs before each turn so the agent, which can no longer fetch, still
        branches off today's default branch and can check out the branch of a
        pull request it is continuing. The refspec is written out in full
        because the URL, not the remote name, is what is fetched: without it
        git would update no ``refs/remotes/origin/*`` at all."""
        url = self._verified_remote()
        self._authenticated_git(
            url, "fetch", "--prune", url, "+refs/heads/*:refs/remotes/origin/*"
        )

    def push_branch(self, branch: str) -> None:
        """Push one branch, as the worker rather than the agent.

        Both sides of the refspec are spelled out and the destination is the
        configured URL, so nothing about where this goes comes from the
        checkout. No branch-name policy here: the tool that calls this refuses
        anything outside the agent's namespace first, with the guard's own
        wording, and a check in two places drifts apart."""
        url = self._verified_remote()
        self._authenticated_git(url, "push", url, f"refs/heads/{branch}:refs/heads/{branch}")

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
            # The clone authenticates, so it gets the same no-hooks rule as the
            # other two. Its hooks would come from a template directory rather
            # than from a checkout that does not exist yet, and this is the one
            # command here that keeps the inherited environment — `~/.gitconfig`
            # included, where an `init.templateDir` or `core.hooksPath` line is a
            # line the agent's file tools can write and a restart can find again.
            clone = [
                "git", *_NO_HOOKS, "clone", "--branch", self.default_branch,
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
