"""PreToolUse hook: deny any git/gh op that touches the default branch or merges.

This is the in-process enforcement of Open Q#1's merge boundary. The agent may
push feature branches and open PRs; it may **never** push/merge the default
branch. The hook inspects every ``Bash`` command and returns ``permissionDecision:
"deny"`` for a violation — and **deny wins even under ``bypassPermissions``**
(hooks evaluate before permission mode), so this holds regardless of the
permission mode the worker runs under.

Compound commands are **decomposed** (split on ``;`` ``&&`` ``||`` ``|`` and
newlines, each piece tokenized) so a forbidden op can't be smuggled inside a
chain like ``git checkout x && git push origin main``. A whole-string regex
backstop catches nestings the splitter might miss (e.g. command substitution).
"""

from __future__ import annotations

import re
import shlex
from collections.abc import Awaitable, Callable
from typing import Any

# split a shell line into sequential sub-commands
_SPLIT_RE = re.compile(r"\s*(?:&&|\|\||;|\||\n|&)\s*")


def _regex_backstop(command: str, default_branch: str) -> str | None:
    """Catch the dangerous shapes even inside substitutions/quoting the token
    splitter can't fully resolve."""
    db = re.escape(default_branch)
    checks = [
        (r"\bgit\s+merge\b", "git merge is forbidden (the agent never merges)"),
        (r"\bgh\s+pr\s+merge\b", "gh pr merge is forbidden"),
        (r"\bgit\s+push\b.*--force\b", "force-push is forbidden"),
        (rf"\bgit\s+push\b.*(?:\s|:){db}\b", f"pushing to '{default_branch}' is forbidden"),
    ]
    for pattern, reason in checks:
        if re.search(pattern, command):
            return reason
    return None


def _check_subcommand(tokens: list[str], default_branch: str) -> str | None:
    if not tokens:
        return None
    head = tokens[0]
    if head == "gh":
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
        if "--force" in rest or "-f" in rest or any(t.startswith("+") for t in rest):
            return "force-push is forbidden"
        for t in rest:
            if t == default_branch or t.endswith(f":{default_branch}"):
                return f"pushing to '{default_branch}' is forbidden — push a feature branch"
        return None
    if sub == "branch" and default_branch in rest and (
        {"-D", "-d", "-m", "-M"} & set(rest)
    ):
        return f"modifying the '{default_branch}' branch is forbidden"
    return None


def git_violation(command: str, default_branch: str = "main") -> str | None:
    """Return a denial reason if ``command`` (a Bash command string) touches the
    default branch or merges, else ``None``. Pure function — the unit of the
    hook, tested directly."""
    for piece in _SPLIT_RE.split(command):
        piece = piece.strip()
        if not piece:
            continue
        try:
            tokens = shlex.split(piece)
        except ValueError:
            tokens = piece.split()  # unbalanced quotes: fall back to naive split
        reason = _check_subcommand(tokens, default_branch)
        if reason:
            return reason
    return _regex_backstop(command, default_branch)


def make_main_guard_hook(
    default_branch: str = "main",
) -> Callable[[dict[str, Any], str | None, Any], Awaitable[dict[str, Any]]]:
    """Build the PreToolUse hook (closes over the default branch name). Register
    via ``HookMatcher(matcher="Bash", hooks=[hook])``."""

    async def hook(input_data: dict[str, Any], tool_use_id: str | None, context: Any) -> dict:
        if input_data.get("tool_name") != "Bash":
            return {}
        command = (input_data.get("tool_input") or {}).get("command", "")
        reason = git_violation(command, default_branch)
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
