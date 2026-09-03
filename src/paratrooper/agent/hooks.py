"""PreToolUse hook: fence the agent's git/gh onto the agent's branch namespace.

The namespace is one configured word — ``[site] branch_prefix``, ``paratrooper``
by default — threaded in from the worker. Every check, message and branch count
below reads that one value (:data:`BRANCH_PREFIX` is only the fallback for
callers that pass none), so the ``paratrooper/*`` in the prose below is simply
what the default renders.

Two layers of enforcement on every ``Bash`` command, and a deny wins even under
``bypassPermissions`` (hooks evaluate before permission mode):

1. **A pure allowlist** (:func:`git_violation`). The agent may create, switch
   to, push, rename, and delete only ``paratrooper/*`` branches. The single
   carve-out is the workflow's local reset of the default branch, accepted only
   in its exact shape ``git checkout -B <default> origin/<default>``. Merges,
   ``gh pr merge``, ``gh api``, force pushes and ``push --all/--mirror`` stay
   forbidden as before; fetches, adds, commits and the pathspec forms of
   checkout (``git checkout -- .``) stay allowed.

2. **A branch cap** (:func:`cap_violation`, the only effectful step). When a
   command would create a paratrooper/* branch that does not already exist
   locally, the hook counts the site checkout's local paratrooper/* branches
   and denies the creation once 7 exist, telling the agent to reuse or clean
   up instead. The count is a single quick ``git for-each-ref`` subprocess in
   the configured checkout root; with no root configured the cap is skipped
   entirely, so the string-analysis core stays pure and unit-testable.

Compound commands are **decomposed** (split on ``;`` ``&&`` ``||`` ``|`` and
newlines, each piece tokenized) so a forbidden op can't be smuggled inside a
chain like ``git checkout x && git push origin main``. A whole-string regex
backstop catches nestings the splitter might miss (e.g. command substitution).

Push refspecs are judged by their **destination**: the part after the last
``:`` (the whole token if there is none) with a leading ``refs/heads/``
stripped, so ``HEAD:refs/heads/main`` and ``refs/heads/main`` are as forbidden
as ``main``, and every destination (including ``--delete`` / ``:branch``
deletions) must be a paratrooper/* branch.
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
        (r"\bgh\s+pr\s+merge\b", "gh pr merge is forbidden"),
        (r"\bgh\s+api\b", "raw GitHub API calls are forbidden — use the typed tools"),
        (r"\bgit\s+push\b.*--force\b", "force-push is forbidden"),
        (
            r"\bgit\s+push\b.*--(?:all|mirror|branches)\b",
            "git push --all/--mirror is forbidden",
        ),
        (
            rf"\bgit\s+push\b.*(?:\s|:|refs/heads/){db}\b",
            f"pushing to '{default_branch}' is forbidden",
        ),
    ]
    for pattern, reason in checks:
        if re.search(pattern, command):
            return reason
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
    head = tokens[0]
    if head == "gh":
        if "api" in tokens:
            return "raw GitHub API calls are forbidden — use the typed tools"
        if "pr" in tokens and "merge" in tokens:
            return "gh pr merge is forbidden — merging is the web service's job"
        return None
    if head != "git":
        return None
    sub = tokens[1] if len(tokens) > 1 else ""
    rest = tokens[2:]
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
    outside the <prefix>/* branch allowlist, touches the default branch, or
    merges, else ``None``. ``branch_prefix`` takes the bare configured word or
    the slash-terminated form. Pure function — the unit of the hook, tested
    directly. The branch-count cap is deliberately NOT here (see
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
    for tokens in _subcommands(command):
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
