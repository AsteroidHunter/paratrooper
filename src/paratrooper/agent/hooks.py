"""PreToolUse hook: fence the agent's shell onto git and the ``gh`` PR commands.

The namespace is one configured word — ``[site] branch_prefix``, ``paratrooper``
by default — threaded in from the worker. Every check, message and branch count
below reads that one value (:data:`BRANCH_PREFIX` is only the fallback for
callers that pass none), so the ``paratrooper/*`` in the prose below is simply
what the default renders.

Three layers of enforcement on every ``Bash`` command, and a deny wins even
under ``bypassPermissions`` (hooks evaluate before permission mode):

1. **A pure allowlist** (:func:`git_violation`). The agent may create, switch
   to, push, rename, and delete only ``paratrooper/*`` branches. The single
   carve-out is the workflow's local reset of the default branch, accepted only
   in its exact shape ``git checkout -B <default> origin/<default>``. Merges,
   ``gh pr merge``, ``gh api``, force pushes and ``push --all/--mirror`` stay
   forbidden as before; fetches, adds, commits and the pathspec forms of
   checkout (``git checkout -- .``) stay allowed.

2. **One road to GitHub**. The session env hands the shell a real GitHub token
   (``GH_TOKEN`` for ``gh``, ``PARATROOPER_GIT_ASKPASS_TOKEN`` for git), so a
   plain ``curl`` is a fully authorised API client and would sail straight past
   the branch allowlist — it isn't a git command. Three rules close that:

   * a command that names ``github.com`` / ``githubusercontent.com`` is refused
     unless its head token is ``git`` (its own allowlist then applies) or
     ``gh`` (:func:`_check_gh` then applies);
   * ``gh`` itself is an allowlist: ``gh pr list|view|create|status|checks``,
     ``gh auth status`` and the version/help forms. ``gh api``, ``gh pr merge``,
     ``gh repo``, ``gh release``, ``gh secret``, ``gh auth login`` and the rest
     are refused;
   * nothing may read the token back out of the environment — the var names
     themselves (outside git/gh), ``env`` / ``printenv`` / bare ``set`` /
     ``export -p``, and any ``/proc/*/environ`` read.

   Every one of these denials names the sanctioned route, so the agent can
   recover on the next turn instead of inventing another way around.

3. **A branch cap** (:func:`cap_violation`, the only effectful step). When a
   command would create a paratrooper/* branch that does not already exist
   locally, the hook counts the site checkout's local paratrooper/* branches
   and denies the creation once 7 exist, telling the agent to reuse or clean
   up instead. The count is a single quick ``git for-each-ref`` subprocess in
   the configured checkout root; with no root configured the cap is skipped
   entirely, so the string-analysis core stays pure and unit-testable.

Compound commands are **decomposed** (split on ``;`` ``&&`` ``||`` ``|`` and
newlines, each piece tokenized) so a forbidden op can't be smuggled inside a
chain like ``git checkout x && git push origin main``, and each piece is judged
by its own head token — with any leading ``VAR=value`` assignments stripped
first, so ``FOO=bar git push origin main`` is read as the git command it is. A
whole-string regex backstop catches nestings the splitter might miss (``bash
-c``, ``python -c``, backticks, ``$(...)``).

Push refspecs are judged by their **destination**: the part after the last
``:`` (the whole token if there is none) with a leading ``refs/heads/``
stripped, so ``HEAD:refs/heads/main`` and ``refs/heads/main`` are as forbidden
as ``main``, and every destination (including ``--delete`` / ``:branch``
deletions) must be a paratrooper/* branch.

This is a fence, not a security boundary: it constrains a cooperative agent's
shell, and a determined adversary with arbitrary code execution can encode its
way around any string check. The token's own scopes and GitHub's branch
protection are what actually bound the damage.
"""

from __future__ import annotations

import re
import shlex
import subprocess
from collections.abc import Awaitable, Callable, Iterator
from pathlib import Path
from typing import Any

# split a shell line into sequential sub-commands
_SPLIT_RE = re.compile(r"\s*(?:&&|\|\||;|\||\n|&)\s*")

# the default namespace the agent owns; everything branch-shaped must live under
# it. The worker passes the site's configured word instead (see the module
# docstring); this constant is what callers that configure nothing still get.
BRANCH_PREFIX = "paratrooper/"
# hygiene cap: at most this many local paratrooper/* branches in the checkout
MAX_AGENT_BRANCHES = 7

# branch-creation flags per subcommand (the shapes the workflow uses, plus the
# long/orphan spellings so they can't sidestep the allowlist)
_CREATION_FLAGS = {
    "checkout": {"-b", "-B", "--orphan"},
    "switch": {"-c", "-C", "--create", "--force-create", "--orphan"},
}
# `git branch` flags that rename/copy/delete (their name arguments are all
# branch names) vs. flags that merely list/query (never touch a branch)
_BRANCH_MODIFY_FLAGS = {"-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy"}
_BRANCH_COPY_FLAGS = {"-c", "-C", "--copy"}
_BRANCH_LIST_FLAGS = {
    "-l", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose",
    "--show-current", "--contains", "--no-contains", "--merged", "--no-merged",
    "--points-at", "--column", "--sort", "--format",
}

# --- the one road to GitHub ---------------------------------------------------

# named in every refusal below so the agent learns the way through, not just the
# way blocked: a denial it can't act on is a denial it will try to route around
GITHUB_ROUTE = (
    "reach GitHub only through git or `gh pr create`/`gh pr list`/`gh pr view`"
)

# every GitHub host the token would authenticate against: the API, the web app,
# and the two content hosts that serve raw blobs and release assets
_GITHUB_HOSTS_PATTERN = r"github\.com|githubusercontent\.com"
_GITHUB_HOST_RE = re.compile(_GITHUB_HOSTS_PATTERN, re.IGNORECASE)

# the token variables the worker puts in the session env (see worker.py). Any
# spelling — $VAR, ${VAR}, os.environ["VAR"], process.env.VAR, the bare word —
# contains the name, so a substring match covers them all.
TOKEN_VARS = ("GH_TOKEN", "GITHUB_TOKEN", "PARATROOPER_GIT_ASKPASS_TOKEN")
_TOKEN_VAR_RE = re.compile("|".join(TOKEN_VARS))

# `cat /proc/self/environ`, `tr -d '\0' < /proc/1/environ`, open() from python:
# the file, not the reader, is what the rule names
_PROC_ENVIRON_RE = re.compile(r"/proc/[^/\s'\"]+/environ")

# command substitution bodies — `$(...)` and backticks — are inspected even when
# the outer command is an allowed git/gh one, so `gh pr create --body "$(...)"`
# can't smuggle a fetch or the token out through an argument
_SUBSTITUTION_RE = re.compile(r"\$\([^)]*\)|`[^`]*`")

# binaries that can speak HTTP or run arbitrary code; paired with a GitHub host
# in the whole-string backstop, for nestings the token splitter can't decompose.
# Kept to what a shell could plausibly reach for — a longer list would only add
# false denials, since the per-piece check already refuses any head token that
# names a GitHub host.
_REACH_BINARIES = r"curl|wget|python3?|node|deno|bun|perl|ruby|php|nc|ssh|scp|rsync"

# `gh` is an allowlist of its own: exactly the pull-request reads and the one
# write (create) the prompt's workflow asks for, plus auth/version diagnostics
_GH_ALLOWED = {
    ("pr", "list"), ("pr", "view"), ("pr", "create"), ("pr", "status"), ("pr", "checks"),
    ("auth", "status"),
}
_GH_INFO = {"version", "--version", "-v", "help", "--help", "-h"}
_GH_ALLOWED_TEXT = (
    "only `gh pr list`, `gh pr view`, `gh pr create`, `gh pr status`, "
    "`gh pr checks`, `gh auth status` and `gh --version` are allowed"
)

# commands whose whole purpose is to print the environment the token lives in
_ENV_DUMP_HEADS = {"env", "printenv"}

# a head token worth quoting back at the agent. Splitting a nested one-liner can
# leave a "head" that is really half a python expression; naming that in the
# denial reads as noise, so those messages say "this command" instead.
_PLAIN_WORD_RE = re.compile(r"[\w./-]{1,20}")

# `FOO=bar git push ...` is a git command with a one-shot env var in front of it.
# Without stripping those the head token reads as `FOO=bar`, the git allowlist
# never runs, and the whole fence is one assignment away from being off.
_ASSIGNMENT_RE = re.compile(r"[A-Za-z_]\w*=[\s\S]*")


def normalize_prefix(branch_prefix: str) -> str:
    """The prefix in matching form: exactly one trailing ``/``. The site config
    holds the bare word (``paratrooper``) while every check here wants
    ``paratrooper/``, so the entry points accept either spelling."""
    return branch_prefix if branch_prefix.endswith("/") else f"{branch_prefix}/"


def _is_agent_branch(name: str, branch_prefix: str = BRANCH_PREFIX) -> bool:
    """True for a non-empty branch name under the agent's <prefix>/* namespace."""
    return name.startswith(branch_prefix) and len(name) > len(branch_prefix)


def _regex_backstop(command: str, default_branch: str) -> str | None:
    """Catch the dangerous shapes even inside substitutions/quoting the token
    splitter can't fully resolve."""
    db = re.escape(default_branch)
    checks = [
        (r"\bgit\s+merge\b", "git merge is forbidden (the agent never merges)"),
        (r"\bgh\s+pr\s+merge\b", f"gh pr merge is forbidden: {GITHUB_ROUTE}"),
        (
            r"\bgh\s+api\b",
            f"raw GitHub API calls are forbidden: {GITHUB_ROUTE}",
        ),
        (r"\bgit\s+push\b.*--force\b", "force-push is forbidden"),
        (
            r"\bgit\s+push\b.*--(?:all|mirror|branches)\b",
            "git push --all/--mirror is forbidden",
        ),
        (
            rf"\bgit\s+push\b.*(?:\s|:|refs/heads/){db}\b",
            f"pushing to '{default_branch}' is forbidden",
        ),
        # a fetcher or an interpreter in the same line as a GitHub host: catches
        # `bash -c "curl ..."`, `python -c "...urlopen(...)"` and friends even
        # when the splitter can't expose the inner command as a head token
        (
            rf"(?i)\b(?:{_REACH_BINARIES})\b[^\n]{{0,400}}?(?:{_GITHUB_HOSTS_PATTERN})",
            f"reaching GitHub outside git/gh is forbidden: {GITHUB_ROUTE}",
        ),
        (
            _PROC_ENVIRON_RE.pattern,
            "reading /proc/*/environ is forbidden: it would dump the GitHub token "
            f"out of the worker's environment — git and gh read it themselves, so {GITHUB_ROUTE}",
        ),
    ]
    for pattern, reason in checks:
        if re.search(pattern, command):
            return reason
    return _substitution_violation(command)


def _substitution_violation(command: str) -> str | None:
    """Command substitutions are judged on their own, whatever the outer head
    token is: ``gh pr create --body "$(printenv GH_TOKEN)"`` is an allowed gh
    command wrapped around a forbidden one."""
    for body in _SUBSTITUTION_RE.findall(command):
        if _GITHUB_HOST_RE.search(body):
            return (
                "reaching GitHub from inside a command substitution is forbidden: "
                f"{GITHUB_ROUTE}"
            )
        if _TOKEN_VAR_RE.search(body):
            return (
                "reading the GitHub token from inside a command substitution is "
                "forbidden: git and gh already read it from the environment, and "
                f"nothing else may see it — {GITHUB_ROUTE}"
            )
    return None


def _check_gh(tokens: list[str]) -> str | None:
    """Allowlist for ``gh``: the pull-request commands the workflow needs, plus
    auth/version diagnostics. Everything else — ``api``, ``repo``, ``release``,
    ``secret``, ``auth login``, ``run``, ``workflow``, ``pr merge/close/edit`` —
    is refused, because ``gh`` holds the same token a raw API call would."""
    rest = tokens[1:]
    if not rest or rest[0] in _GH_INFO:
        return None
    if tuple(rest[:2]) in _GH_ALLOWED:
        return None
    if rest[:2] == ["pr", "merge"]:
        return (
            "gh pr merge is forbidden: merging is the web service's job, after Akash "
            f"taps Publish — {GITHUB_ROUTE}"
        )
    if rest[0] == "api":
        return (
            "gh api is forbidden: a raw GitHub API call is not a route the agent has "
            f"— {GITHUB_ROUTE}"
        )
    named = " ".join(rest[:2])
    return f"'gh {named}' is forbidden: {_GH_ALLOWED_TEXT} — {GITHUB_ROUTE}"


def _strip_assignments(tokens: list[str]) -> list[str]:
    """Drop the leading ``VAR=value`` tokens so the real command is the head.
    Returns an empty list for a piece that is nothing but assignments."""
    i = 0
    while i < len(tokens) and _ASSIGNMENT_RE.fullmatch(tokens[i]):
        i += 1
    return tokens[i:]


def _check_env_dump(tokens: list[str]) -> str | None:
    """Refuse the commands that print the whole environment. The GitHub token
    lives there; dumping it puts a live credential into the model's context (and
    from there into a message, a commit, or a PR body)."""
    if not tokens:
        return None
    head = tokens[0]
    dumps = (
        head in _ENV_DUMP_HEADS
        or (head == "export" and (len(tokens) == 1 or "-p" in tokens))
        or (head == "set" and len(tokens) == 1)
    )
    if not dumps:
        return None
    return (
        f"'{' '.join(tokens[:2])}' is forbidden: it would dump the environment, and the "
        "GitHub token lives there — git and gh read it themselves, so "
        f"{GITHUB_ROUTE}"
    )


def _check_github_reach(head: str, tokens: list[str]) -> str | None:
    """Refuse a non-git/gh command that names a GitHub host or a token variable.
    Judged per decomposed piece, so the second half of a pipe or an ``&&`` chain
    is checked on its own head token rather than the whole line's. ``tokens`` is
    the whole piece, assignments included — ``HOST=api.github.com`` on its own is
    still a GitHub reach even though it runs nothing."""
    if head in ("git", "gh"):
        return None  # their own allowlists decide (see _check_subcommand)
    piece = " ".join(tokens)
    named = f"'{head}'" if _PLAIN_WORD_RE.fullmatch(head) else "this command"
    if _GITHUB_HOST_RE.search(piece):
        return (
            f"reaching GitHub with {named} is forbidden: the shell's GitHub token "
            f"is for git and gh only — {GITHUB_ROUTE}"
        )
    if _TOKEN_VAR_RE.search(piece):
        return (
            f"referencing the GitHub token in {named} is forbidden: git and gh "
            "already read it from the environment, and nothing else may see it — "
            f"{GITHUB_ROUTE}"
        )
    return None


def _push_destination(token: str) -> str:
    """Resolve a push refspec token to the branch it would write: the part
    after the last ``:`` (the whole token if there is none), minus a leading
    ``refs/heads/``. So ``main``, ``HEAD:main``, ``refs/heads/main`` and
    ``HEAD:refs/heads/main`` all resolve to ``main``."""
    dest = token.rsplit(":", 1)[-1]
    return dest.removeprefix("refs/heads/")


def _split_flags(rest: list[str]) -> tuple[set[str], list[str]]:
    """Separate option tokens from positional tokens. A lone ``-`` (git's
    "previous branch") counts as a positional, not a flag."""
    flags = {t for t in rest if t.startswith("-") and t != "-"}
    positionals = [t for t in rest if not t.startswith("-") or t == "-"]
    return flags, positionals


def _check_checkout_switch(
    sub: str, rest: list[str], default_branch: str, branch_prefix: str = BRANCH_PREFIX
) -> str | None:
    """Allowlist for ``git checkout`` / ``git switch``."""
    if "--" in rest:
        return None  # pathspec/file checkout (e.g. `git checkout -- .`), not a branch op
    # creation: `-b/-B/--orphan <name>` (checkout), `-c/-C <name>` (switch)
    for i, tok in enumerate(rest):
        if tok in _CREATION_FLAGS[sub]:
            name = rest[i + 1] if i + 1 < len(rest) else ""
            if _is_agent_branch(name, branch_prefix):
                return None  # (the cap, if configured, is checked separately)
            if sub == "checkout" and rest == ["-B", default_branch, f"origin/{default_branch}"]:
                return None  # THE carve-out: reset local default from origin, exact shape only
            if name == default_branch:
                return (
                    f"resetting '{default_branch}' is allowed only as the exact "
                    f"'git checkout -B {default_branch} origin/{default_branch}'"
                )
            return (
                f"creating branch '{name}' is forbidden: the agent may only create "
                f"{branch_prefix}* branches"
            )
    # plain switch: the first positional is the target branch
    for tok in rest:
        if tok == "-" or not tok.startswith("-"):
            target = tok
            break
    else:
        return None  # no target at all (e.g. bare `git checkout`)
    if target == "." or target.startswith(("./", "../", "/")):
        return None  # a path, not a branch: file/pathspec checkout stays allowed
    if _is_agent_branch(target, branch_prefix):
        return None
    return (
        f"checking out '{target}' is forbidden: the agent works only on "
        f"{branch_prefix}* branches (to refresh the local default branch use "
        f"'git checkout -B {default_branch} origin/{default_branch}')"
    )


def _check_push(rest: list[str], branch_prefix: str = BRANCH_PREFIX) -> str | None:
    """Allowlist for ``git push``: force/--all rules as before, then every
    refspec destination (deletions included) must be a <prefix>/* branch."""
    if "--force" in rest or "-f" in rest or any(t.startswith("+") for t in rest):
        return "force-push is forbidden"
    if "--all" in rest or "--mirror" in rest or "--branches" in rest:
        return "git push --all/--mirror is forbidden — push a single feature branch"
    _, positionals = _split_flags(rest)
    refspecs = positionals[1:]  # the first positional is the remote
    if not refspecs:
        return (
            "git push without an explicit refspec is forbidden: name the branch, "
            f"e.g. git push -u origin {branch_prefix}<slug>"
        )
    for tok in refspecs:
        dest = _push_destination(tok)
        if not _is_agent_branch(dest, branch_prefix):
            return (
                f"pushing to '{dest}' is forbidden: only {branch_prefix}* branches "
                "may be pushed or deleted on the remote"
            )
    return None


def _check_branch(rest: list[str], branch_prefix: str = BRANCH_PREFIX) -> str | None:
    """Allowlist for ``git branch``: delete/rename/copy may name only
    <prefix>/* branches (both sides of a rename/copy), and bare creation
    (`git branch <name>`) must target the prefix. Listing/query forms pass."""
    flags, positionals = _split_flags(rest)
    if flags & _BRANCH_MODIFY_FLAGS:
        for name in positionals:
            if not _is_agent_branch(name, branch_prefix):
                return (
                    f"git branch on '{name}' is forbidden: only {branch_prefix}* "
                    "branches may be created, renamed, copied, or deleted"
                )
        return None
    if positionals and not (flags & _BRANCH_LIST_FLAGS):
        name = positionals[0]  # `git branch <name> [<start>]`
        if not _is_agent_branch(name, branch_prefix):
            return (
                f"creating branch '{name}' is forbidden: the agent may only create "
                f"{branch_prefix}* branches"
            )
    return None


def _check_subcommand(
    tokens: list[str], default_branch: str, branch_prefix: str = BRANCH_PREFIX
) -> str | None:
    if not tokens:
        return None
    # `FOO=bar git push ...`: the assignments are a prefix, not the command
    command = _strip_assignments(tokens)
    head = command[0] if command else ""
    reason = _check_env_dump(command) or _check_github_reach(head, tokens)
    if reason:
        return reason
    if head == "gh":
        return _check_gh(command)
    if head != "git":
        return None
    sub = command[1] if len(command) > 1 else ""
    rest = command[2:]
    if sub == "merge":
        return "git merge is forbidden — the agent never merges"
    if sub == "push":
        return _check_push(rest, branch_prefix)
    if sub in ("checkout", "switch"):
        return _check_checkout_switch(sub, rest, default_branch, branch_prefix)
    if sub == "branch":
        return _check_branch(rest, branch_prefix)
    return None


def _subcommands(command: str) -> Iterator[list[str]]:
    """Decompose a shell line into token lists, one per sequential piece."""
    for piece in _SPLIT_RE.split(command):
        piece = piece.strip()
        if not piece:
            continue
        try:
            yield shlex.split(piece)
        except ValueError:
            yield piece.split()  # unbalanced quotes: fall back to naive split


def git_violation(
    command: str, default_branch: str = "main", branch_prefix: str = BRANCH_PREFIX
) -> str | None:
    """Return a denial reason if ``command`` (a Bash command string) steps
    outside the <prefix>/* branch allowlist, touches the default branch, merges,
    reaches GitHub by any road other than git/``gh``, or reads the token out of
    the environment; else ``None``. ``branch_prefix`` takes the bare configured
    word or the slash-terminated form. Pure function — the unit of the hook,
    tested directly. The branch-count cap is deliberately NOT here (see
    :func:`cap_violation`)."""
    branch_prefix = normalize_prefix(branch_prefix)
    for tokens in _subcommands(command):
        reason = _check_subcommand(tokens, default_branch, branch_prefix)
        if reason:
            return reason
    return _regex_backstop(command, default_branch)


def branch_creation_targets(command: str) -> list[str]:
    """Pure: the branch names ``command`` would create — via ``checkout
    -b/-B/--orphan``, ``switch -c/-C``, bare ``git branch <name>``, or a
    ``git branch -c/-C`` copy (renames/deletes never grow the count and are
    excluded). Feeds the cap check; extraction only, no policy."""
    targets: list[str] = []
    for piece in _subcommands(command):
        tokens = _strip_assignments(piece)  # `FOO=bar git checkout -b ...` counts too
        if len(tokens) < 3 or tokens[0] != "git":
            continue
        sub, rest = tokens[1], tokens[2:]
        if sub in ("checkout", "switch"):
            if "--" in rest:
                continue
            for i, tok in enumerate(rest):
                if tok in _CREATION_FLAGS[sub] and i + 1 < len(rest):
                    targets.append(rest[i + 1])
                    break
        elif sub == "branch":
            flags, positionals = _split_flags(rest)
            if not positionals:
                continue
            if flags & _BRANCH_COPY_FLAGS:
                targets.append(positionals[-1])  # copy: the new name is last
            elif not flags & (_BRANCH_MODIFY_FLAGS | _BRANCH_LIST_FLAGS):
                targets.append(positionals[0])  # bare creation: `git branch <name>`
    return targets


def _local_agent_branches(
    repo_root: str | Path, branch_prefix: str = BRANCH_PREFIX
) -> set[str] | None:
    """The checkout's local <prefix>/* branch names, via one quick
    ``git for-each-ref``. Returns ``None`` when git can't answer (no repo,
    git missing): the cap is a hygiene limit, not a security boundary, so it
    fails open rather than blocking recovery in a broken checkout."""
    try:
        proc = subprocess.run(
            ["git", "for-each-ref", "--format=%(refname:short)",
             f"refs/heads/{branch_prefix.rstrip('/')}"],
            cwd=repo_root,
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    if proc.returncode != 0:
        return None
    return {
        line.strip() for line in proc.stdout.splitlines()
        if line.strip().startswith(branch_prefix)
    }


def cap_violation(
    command: str, repo_root: str | Path, branch_prefix: str = BRANCH_PREFIX
) -> str | None:
    """The one effectful check: deny a command that would create a NEW
    <prefix>/* branch while the checkout already holds
    :data:`MAX_AGENT_BRANCHES` of them. Re-creating or switching to an
    existing agent branch never triggers the cap."""
    branch_prefix = normalize_prefix(branch_prefix)
    targets = [t for t in branch_creation_targets(command) if _is_agent_branch(t, branch_prefix)]
    if not targets:
        return None
    existing = _local_agent_branches(repo_root, branch_prefix)
    if existing is None:
        return None
    if len(existing) < MAX_AGENT_BRANCHES:
        return None
    if all(t in existing for t in targets):
        return None  # only touching branches that already exist
    return (
        f"the checkout already has {len(existing)} local {branch_prefix}* branches "
        f"(the limit is {MAX_AGENT_BRANCHES}): reuse an existing "
        f"{branch_prefix.rstrip('/')} branch for this work, or clean up stale ones "
        "first (git branch -D <branch>, then git push origin --delete <branch> if "
        "it was pushed) before creating a new one"
    )


def make_main_guard_hook(
    default_branch: str = "main",
    repo_root: str | Path | None = None,
    branch_prefix: str = BRANCH_PREFIX,
) -> Callable[[dict[str, Any], str | None, Any], Awaitable[dict[str, Any]]]:
    """Build the PreToolUse hook (closes over the default branch name, the
    agent's branch prefix and, optionally, the site checkout root). With a
    ``repo_root`` the hook also enforces the <prefix>/* branch cap by counting
    local branches there; without one the cap is skipped and the hook stays
    fully pure. ``branch_prefix`` takes the site config's bare word
    (``paratrooper``) or the slash-terminated form. Register via
    ``HookMatcher(matcher="Bash", hooks=[hook])``."""
    branch_prefix = normalize_prefix(branch_prefix)

    async def hook(input_data: dict[str, Any], tool_use_id: str | None, context: Any) -> dict:
        if input_data.get("tool_name") != "Bash":
            return {}
        command = (input_data.get("tool_input") or {}).get("command", "")
        reason = git_violation(command, default_branch, branch_prefix)
        if reason is None and repo_root is not None:
            reason = cap_violation(command, repo_root, branch_prefix)
        if reason is None:
            return {}
        return {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"{reason}. Paratrooper pushes feature branches and opens PRs only; "
                    "publishing to the live site is a separate human-approved step."
                ),
            }
        }

    return hook
