"""Tests for the agent layer — SDK-independent internals + the security pieces.

Heaviest coverage on the two boundaries: ``git_violation`` (the main/merge
hook, 3.2b) and ``configure_auth`` (no-fallback auth, 3.2).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from paratrooper.agent import images, memory, pins, spotify
from paratrooper.agent.auth import configure_auth
from paratrooper.agent.config import (
    DEFAULT_GIT_EMAIL,
    DEFAULT_GIT_NAME,
    ConfigError,
    load_config,
    require_env,
    validate_branch_prefix,
)
from paratrooper.agent.hooks import (
    file_read_violation,
    git_violation,
    make_file_guard_hook,
    make_main_guard_hook,
)
from paratrooper.agent.siterepo import SiteRepo
from paratrooper.agent.tools import ToolContext, build_tool_server

# --- hooks (3.2b): the main/merge boundary -----------------------------------

@pytest.mark.parametrize(
    "command",
    [
        "git push origin main",
        "git push -u origin main",
        "git push origin HEAD:main",
        "git merge feature",
        "git merge origin/main",
        "gh pr merge 5",
        "git push --force origin paratrooper/x",
        "git push -f origin paratrooper/x",
        "git checkout main && git push origin main",  # compound
        "cd src/content && git push origin main",  # compound
        'bash -c "git push origin main"',  # nested -> regex backstop
        "git branch -D main",
        "git push origin HEAD:refs/heads/main",  # full-ref refspec destination
        "git push origin refs/heads/main",  # bare full-ref token
        'bash -c "git push origin HEAD:refs/heads/main"',  # nested -> regex backstop
        "gh api --method PUT repos/OWNER/REPO/pulls/5/merge",  # raw API merge
        "gh api repos/OWNER/REPO/merges",  # any raw API call
        "git push --all origin",
        "git push --mirror origin",
        "git push --branches origin",  # --all's alias
        "echo hi && git push --all origin",  # compound
        "git push origin --delete main",  # remote-delete is still a push to main
        "git push origin :main",  # old-style remote delete of main
        # the paratrooper/* allowlist: creation outside the prefix
        "git checkout -B feature/x",
        "git checkout -b hotfix",
        "git switch -c develop",
        "git checkout --orphan gh-pages",
        "git branch new-branch",  # bare creation must target the prefix too
        # plain branch switching outside the prefix (bare main included)
        "git checkout main",
        "git switch main",
        "git checkout feature/x",
        "git checkout -",  # previous branch: unverifiable target
        # the reset carve-out is exact-shape only
        "git checkout -B main origin/master",  # wrong start point
        "git checkout -B main",  # missing start point
        # push destinations must all be paratrooper/*
        "git push origin somebranch",
        "git push -u origin feature/x",
        "git push origin --delete develop",
        "git push",  # no refspec: implicit upstream could be anything
        # git branch delete/rename outside the prefix
        "git branch -D develop",
        "git branch -m paratrooper/keep renamed",  # rename away from the prefix
        "git branch -M main paratrooper/sneak",  # rename of main, even into the prefix
    ],
)
def test_git_violation_denies(command):
    assert git_violation(command, "main") is not None


@pytest.mark.parametrize(
    "command",
    [
        "git push origin paratrooper/twen-new-band",
        "git push --set-upstream origin paratrooper/foo",
        "git add -A && git commit -m 'add pin'",
        "git checkout -b paratrooper/foo",
        "npm run build",
        "ls -la && cat index.json",
        "git status",
        "git log --oneline -5",
        "git push --set-upstream origin paratrooper/foo:paratrooper/foo",
        "git push origin HEAD:refs/heads/paratrooper/foo",  # full ref, feature dest
        "git fetch origin",
        "git fetch origin main",
        "git switch paratrooper/foo",
        "git switch -c paratrooper/foo",
        "git checkout .",  # pathspec, not a branch: file restore stays allowed
        "git branch -m paratrooper/old paratrooper/new",  # rename inside the prefix
        "git branch --list",  # listing/query forms never touch a branch
        # the prompt-driven workflow: the agent's own branch/push/PR commands
        "git checkout -B main origin/main",  # reset local default to origin tip
        "git checkout -B paratrooper/twen-new-photo origin/paratrooper/twen-new-photo",
        "git push -u origin paratrooper/twen-new-photo",
        "gh pr list --json title,headRefName,url",
        'gh pr create --title "add twen pin" --body "adds the new twen photo"',
        "gh pr view 7 --json url",
        # step 1c's interrupted-attempt sweep: feature-branch cleanup, local + remote
        "git checkout -- .",
        "git clean -fd",
        "git branch -D paratrooper/stale-attempt",
        "git push origin --delete paratrooper/stale-attempt",
        # the fresh-fork chain, compounded the way the agent actually runs it
        "git fetch origin main && git checkout -B main origin/main"
        " && git checkout -B paratrooper/twen-new-photo",
        "git checkout -- . && git clean -fd",
    ],
)
def test_git_violation_allows(command):
    assert git_violation(command, "main") is None


def test_git_violation_respects_default_branch_name():
    # the carve-out and the push rules follow whatever the default branch is
    # named; the paratrooper/* allowlist holds regardless
    assert git_violation("git push origin trunk", "trunk") is not None
    assert git_violation("git push origin main", "trunk") is not None  # not paratrooper/*
    assert git_violation("git push origin paratrooper/x", "trunk") is None
    assert git_violation("git checkout -B trunk origin/trunk", "trunk") is None  # carve-out
    assert git_violation("git checkout -B main origin/main", "trunk") is not None


def test_hook_returns_deny_shape():
    hook = make_main_guard_hook("main")

    def call(tool_name, command=""):
        payload = {"tool_name": tool_name, "tool_input": {"command": command}}
        return asyncio.run(hook(payload, None, None))

    deny = call("Bash", "git push origin main")
    assert deny["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert deny["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    assert call("Bash", "git status") == {}
    assert call("Write") == {}  # non-Bash tools pass through untouched


# --- the file tools: the launch record and the secret mount ------------------
#
# Read, Glob and Grep open files with no command line, so the shell guard's
# /proc/*/environ rule never ran for any of them: one Read of /proc/1/environ
# hands over every value the worker started with, the Claude token included.

def _call_file_hook(hook, tool_name, tool_input):
    return asyncio.run(hook({"tool_name": tool_name, "tool_input": tool_input}, None, None))


@pytest.mark.parametrize(
    ("tool_name", "tool_input"),
    [
        ("Read", {"file_path": "/proc/1/environ"}),
        ("Read", {"file_path": "/proc/self/environ"}),
        ("Read", {"file_path": "/etc/secrets/paratrooper-98cc-github-app.pem"}),
        ("Read", {"file_path": "/etc/secrets/x"}),
        ("Read", {"file_path": "../../proc/self/environ"}),  # a relative spelling
        ("Read", {"file_path": "'/proc/1/environ'"}),  # quoted
        ("Glob", {"pattern": "/proc/**"}),  # the whole root, not just the file
        ("Glob", {"pattern": "/proc/*/environ"}),
        ("Glob", {"pattern": "/etc/secrets/*"}),
        ("Grep", {"pattern": "PARATROOPER", "path": "/proc"}),
        ("Grep", {"pattern": "ghp_", "path": "/proc/1/environ"}),
        ("Grep", {"pattern": "BEGIN RSA", "path": "/etc/secrets"}),
    ],
)
def test_file_guard_denies_the_secret_files(tool_name, tool_input):
    out = _call_file_hook(make_file_guard_hook(), tool_name, tool_input)["hookSpecificOutput"]
    assert out["permissionDecision"] == "deny"
    assert out["hookEventName"] == "PreToolUse"


def test_file_guard_denial_names_the_file_and_the_way_on():
    """A refusal the agent can't act on is one it will route around, so each
    names what it refused and where the agent's work actually lives."""
    hook = make_file_guard_hook()
    record = _call_file_hook(hook, "Read", {"file_path": "/proc/1/environ"})
    reason = record["hookSpecificOutput"]["permissionDecisionReason"]
    assert "launch record" in reason, reason
    assert "site checkout" in reason, reason
    key = _call_file_hook(hook, "Read", {"file_path": "/etc/secrets/key.pem"})
    assert "/etc/secrets" in key["hookSpecificOutput"]["permissionDecisionReason"]


@pytest.mark.parametrize(
    ("tool_name", "tool_input"),
    [
        ("Read", {"file_path": "/app/site_checkout/src/content/pins/twen.json"}),
        ("Read", {"file_path": "package.json"}),
        ("Glob", {"pattern": "src/content/**/*.json"}),
        ("Grep", {"pattern": "tangerine", "path": "src/content"}),
        ("Grep", {"pattern": "processing"}),  # the word starts with proc; not a path
        ("Read", {"file_path": "docs/etc/secrets-notes.md"}),  # nor is this the mount
        # a tool the guard is not registered for passes through, the way the
        # shell guard passes everything that isn't Bash
        ("Write", {"file_path": "/proc/1/environ"}),
    ],
)
def test_file_guard_leaves_ordinary_reads_alone(tool_name, tool_input):
    assert _call_file_hook(make_file_guard_hook(), tool_name, tool_input) == {}


def test_file_read_violation_is_pure_and_reads_either_root():
    assert file_read_violation("/proc/1/environ") is not None
    assert file_read_violation("/etc/secrets/key.pem") is not None
    assert file_read_violation("/proc") is not None  # the root itself
    assert file_read_violation("") is None
    assert file_read_violation("src/content/pins/twen.json") is None


def test_shell_guard_also_refuses_the_secret_mount():
    """The same folder closed on the other road. The shell guard already refused
    /proc/*/environ; the GitHub App's private key lands in /etc/secrets, and the
    site build runs repo code the agent edits, so the shell has to be shut too."""
    for command in (
        "cat /etc/secrets/paratrooper-98cc-github-app.pem",
        "ls /etc/secrets",
        "ls -la /etc/secrets/",
        """python -c "print(open('/etc/secrets/key.pem').read())" """,
        "cp /etc/secrets/key.pem /tmp/k && echo done",
    ):
        reason = git_violation(command, "main")
        assert reason is not None, command
        assert "/etc/secrets" in reason, command


# --- the paratrooper/* branch cap (effectful: counts the site checkout) -------

def _seed_site_checkout(tmp_path, n_branches):
    """A temp git checkout holding ``n_branches`` local paratrooper/* branches
    (same `git init` bootstrap the siterepo tests use)."""
    root = tmp_path / "site"
    root.mkdir()
    subprocess.run(["git", "init", "-b", "main", str(root)], check=True, capture_output=True)
    subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.com",
         "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "seed"],
        cwd=root, check=True, capture_output=True,
    )
    for i in range(n_branches):
        subprocess.run(
            ["git", "branch", f"paratrooper/b{i}"], cwd=root, check=True, capture_output=True
        )
    return root


def _call_hook(hook, command):
    payload = {"tool_name": "Bash", "tool_input": {"command": command}}
    return asyncio.run(hook(payload, None, None))


def test_branch_cap_denies_eighth_creation(tmp_path):
    root = _seed_site_checkout(tmp_path, 7)
    hook = make_main_guard_hook("main", repo_root=root)
    out = _call_hook(hook, "git checkout -B paratrooper/new")
    assert out["hookSpecificOutput"]["permissionDecision"] == "deny"
    reason = out["hookSpecificOutput"]["permissionDecisionReason"]
    # the agent reads deny reasons: it must be told the way out
    assert "reuse" in reason and "clean up" in reason


def test_branch_cap_allows_seventh_creation(tmp_path):
    root = _seed_site_checkout(tmp_path, 6)
    hook = make_main_guard_hook("main", repo_root=root)
    assert _call_hook(hook, "git checkout -B paratrooper/new") == {}


def test_branch_cap_spares_existing_branches(tmp_path):
    root = _seed_site_checkout(tmp_path, 7)
    hook = make_main_guard_hook("main", repo_root=root)
    # re-creating / switching to an existing paratrooper branch never caps
    assert _call_hook(hook, "git checkout -B paratrooper/b0 origin/paratrooper/b0") == {}
    assert _call_hook(hook, "git checkout paratrooper/b3") == {}
    # non-creating commands are untouched by the cap
    assert _call_hook(hook, "git status") == {}
    # and the pure allowlist still runs ahead of the cap
    deny = _call_hook(hook, "git checkout -B feature/x")
    assert deny["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_branch_cap_skipped_without_repo_root():
    # no site checkout configured: the hook stays fully pure, cap disabled
    hook = make_main_guard_hook("main")
    assert _call_hook(hook, "git checkout -B paratrooper/anything") == {}


# --- the one road to GitHub: git, and the gh pull-request commands ------------
#
# The session env hands the shell a live GitHub token, so anything that can
# speak HTTP is an authorised API client. The branch allowlist never saw those
# commands (they aren't git), which is how PRs ended up being opened by raw REST.

_GITHUB_DENIED = [
    # --- reaching a GitHub host with something that isn't git or gh ---
    "curl -s https://api.github.com/repos/o/r/pulls",
    'curl -X POST -H "Authorization: bearer $GH_TOKEN" https://api.github.com/repos/o/r/pulls',
    "wget -qO- https://api.github.com/user",
    "curl https://raw.githubusercontent.com/o/r/main/index.json",
    "curl https://objects.githubusercontent.com/blob",
    "curl https://github.com/o/r/pull/7",
    """python -c "import requests; requests.post('https://api.github.com/repos/o/r/pulls')" """,
    """python3 -c "import httpx; httpx.get('https://github.com/o/r')" """,
    """node -e "fetch('https://api.github.com/user')" """,
    'bash -c "curl https://api.github.com/repos/o/r/pulls"',  # nested wrapper
    "sh -c 'wget https://api.github.com/user'",
    "git log --oneline | curl -X POST -d @- https://api.github.com/gists",  # pipe
    "git status && curl https://api.github.com/user",  # chained after a legal git
    'gh pr list && curl https://api.github.com/user',  # chained after a legal gh
    "HOST=api.github.com; curl https://$HOST/user",  # assembled in a variable
    'gh pr create --title x --body "$(curl -s https://api.github.com/user)"',  # substitution
    # --- reading the token back out of the environment ---
    "echo $GH_TOKEN",
    "echo ${GITHUB_TOKEN}",
    "echo $PARATROOPER_GIT_ASKPASS_TOKEN",
    """python -c "import os; print(os.environ['GH_TOKEN'])" """,
    """node -e "console.log(process.env.GH_TOKEN)" """,
    "env",
    "env | grep TOKEN",
    "printenv",
    "printenv GH_TOKEN",
    "export -p",
    "export",
    "set",
    "cat /proc/self/environ",
    "tr -d '\\0' < /proc/1/environ",
    """python -c "print(open('/proc/self/environ').read())" """,
    'gh pr create --title x --body "$(printenv GH_TOKEN)"',  # substitution
    # --- gh outside its pull-request allowlist ---
    "gh api repos/o/r/pulls",
    "gh api --method POST repos/o/r/pulls -f title=x",
    "gh pr merge 5",
    "gh pr close 3",
    "gh pr edit 3 --base main",
    "gh repo delete o/r",
    "gh repo clone o/r",
    "gh release create v1",
    "gh secret set FOO",
    "gh auth login",
    "gh auth token",
    "gh auth refresh",
    "gh run list",
    "gh workflow run deploy",
]


@pytest.mark.parametrize("command", _GITHUB_DENIED)
def test_github_roads_other_than_git_and_gh_are_denied(command):
    assert git_violation(command, "main") is not None


@pytest.mark.parametrize("command", _GITHUB_DENIED)
def test_github_denials_name_the_sanctioned_route(command):
    """A denial the agent can't act on is one it will try to route around, so
    every refusal has to point at the way through."""
    reason = git_violation(command, "main")
    assert "gh pr create" in reason, reason
    assert "gh pr list" in reason, reason


@pytest.mark.parametrize(
    "command",
    [
        # the gh commands the prompt's workflow actually runs
        "gh pr list --json title,headRefName,url",
        "gh pr view 7 --json url",
        'gh pr create --title "add twen pin" --body "adds the new twen photo"',
        "gh pr status",
        "gh pr checks",
        "gh auth status",
        "gh --version",
        "gh version",
        "gh help",
        # git, fenced as before
        "git fetch origin main",
        "git push -u origin paratrooper/twen-new-photo",
        "git checkout -B paratrooper/twen-new-photo",
        # HTTP to anything that isn't GitHub stays open: the Astro dev server,
        # an image the user linked, a health check
        "curl -s http://localhost:4321/",
        "curl -sI https://images.unsplash.com/photo-1234",
        "curl -o /tmp/x.jpg https://upload.wikimedia.org/x.jpg",
        # interpreters with nothing to do with GitHub
        """python -c "import json; print(json.dumps({'a': 1}))" """,
        'node -e "console.log(1 + 1)"',
        "npm run build",
        # ordinary environment work
        "export FOO=bar",
        "export NODE_ENV=production && npm run build",
        "set -euo pipefail",
    ],
)
def test_the_sanctioned_routes_stay_open(command):
    assert git_violation(command, "main") is None


def test_gh_denial_names_what_gh_may_still_run():
    """`gh` is now an allowlist, so the refusal has to spell the allowlist out —
    the agent has no other way to learn which gh commands survived."""
    reason = git_violation("gh repo delete o/r", "main")
    for allowed in ("gh pr list", "gh pr view", "gh pr create", "gh auth status"):
        assert allowed in reason, reason


def test_a_leading_assignment_does_not_hide_the_command():
    """`FOO=bar git push ...` is a git command with a one-shot env var in front.
    Read literally its head token is `FOO=bar`, the allowlist never runs, and the
    whole fence is one assignment away from being off."""
    for command in (
        "FOO=bar git push origin feature/x",
        "FOO=bar git checkout -b feature/x",
        "GIT_ASKPASS=/tmp/x git push origin main",
        "FOO=bar gh api repos/o/r",
        "HOST=api.github.com",  # an assignment on its own still names the host
    ):
        assert git_violation(command, "main") is not None, command
    for command in (
        "FOO=bar git push origin paratrooper/x",
        "FOO=bar gh pr list",
        "NODE_ENV=production npm run build",
    ):
        assert git_violation(command, "main") is None, command
    # and the branch cap counts the branch such a command would create
    from paratrooper.agent.hooks import branch_creation_targets

    assert branch_creation_targets("FOO=bar git checkout -b paratrooper/x") == ["paratrooper/x"]


def test_github_fence_leaves_the_branch_prefix_alone():
    """The GitHub rules and the configured-namespace rules are independent: the
    new fence must not shift what counts as an agent branch."""
    assert git_violation("git push -u origin blimp/x", "main", "blimp") is None
    assert git_violation("gh pr create --title x --body y", "main", "blimp") is None
    assert git_violation("curl https://api.github.com", "main", "blimp") is not None


def test_worker_image_installs_the_github_cli():
    """The fence sends every PR through `gh`, so the worker image has to carry
    it — installed from GitHub's own signed apt repository, not a loose binary."""
    dockerfile = (Path(__file__).resolve().parents[1] / "Dockerfile.worker").read_text()
    assert "https://cli.github.com/packages/githubcli-archive-keyring.gpg" in dockerfile
    assert "/etc/apt/keyrings/githubcli-archive-keyring.gpg" in dockerfile
    assert "https://cli.github.com/packages stable main" in dockerfile
    assert re.search(r"apt-get install[^\n]*\bgh\b", dockerfile)
    assert "rm -rf /var/lib/apt/lists/*" in dockerfile  # the layer still cleans up


# --- the configured branch word ([site] branch_prefix) ------------------------

def test_git_violation_fences_the_configured_prefix():
    """The namespace the guard fences is the site's configured word. Configure
    'blimp' and blimp/* becomes the allowlist — the old paratrooper/* names are
    then as forbidden as any other stranger."""
    for command in (
        "git checkout -B blimp/twen-new-photo",
        "git switch -c blimp/x",
        "git push -u origin blimp/x",
        "git push origin HEAD:refs/heads/blimp/x",
        "git branch -D blimp/stale",
        "git push origin --delete blimp/stale",
        "git branch -m blimp/old blimp/new",
    ):
        assert git_violation(command, "main", "blimp") is None, command
    for command in (
        "git checkout -B paratrooper/x",
        "git switch -c paratrooper/x",
        "git push -u origin paratrooper/x",
        "git branch -D paratrooper/x",
        "git checkout paratrooper/x",
    ):
        assert git_violation(command, "main", "blimp") is not None, command
    # the default-branch and merge rules don't move with the prefix
    assert git_violation("git push origin main", "main", "blimp") is not None
    assert git_violation("git merge blimp/x", "main", "blimp") is not None
    assert git_violation("git checkout -B main origin/main", "main", "blimp") is None


def test_violation_messages_name_the_configured_prefix():
    """The deny reason is the only place the agent learns the namespace from, so
    it must quote the configured word and never the built-in default."""
    for command in (
        "git checkout -B feature/x",
        "git checkout feature/x",
        "git push origin feature/x",
        "git push origin",
        "git branch -D feature/x",
        "git branch feature/x",
    ):
        reason = git_violation(command, "main", "blimp")
        assert reason is not None, command
        assert "blimp/" in reason, reason
        assert "paratrooper" not in reason, reason


def test_configured_prefix_takes_either_spelling():
    """The config holds the bare word, the hook's own constant carries the
    slash; both must name the same namespace."""
    for spelling in ("blimp", "blimp/"):
        assert git_violation("git checkout -B blimp/x", "main", spelling) is None
        assert git_violation("git checkout -B blimpx", "main", spelling) is not None


def test_omitted_prefix_is_exactly_the_default():
    """Existing callers pass no prefix: that path must stay bit-for-bit what it
    was, verdict and wording alike."""
    for command in (
        "git checkout -B paratrooper/x", "git checkout -B feature/x",
        "git push -u origin paratrooper/x", "git push origin main",
        "git branch -D paratrooper/x", "git branch -D feature/x",
        "git checkout -B main origin/main", "git status",
    ):
        assert git_violation(command, "main") == git_violation(command, "main", "paratrooper")


def test_hook_with_configured_prefix_denies_the_default_namespace():
    hook = make_main_guard_hook("main", branch_prefix="blimp")
    assert _call_hook(hook, "git checkout -B blimp/x") == {}
    deny = _call_hook(hook, "git checkout -B paratrooper/x")
    assert deny["hookSpecificOutput"]["permissionDecision"] == "deny"
    assert "blimp/" in deny["hookSpecificOutput"]["permissionDecisionReason"]


def test_branch_cap_counts_the_configured_prefix(tmp_path):
    """The cap counts the namespace actually in use: with 'blimp' configured,
    paratrooper/* branches sitting in the same checkout don't fill it, and seven
    blimp/* ones do."""
    root = _seed_site_checkout(tmp_path, 7)  # seven paratrooper/* branches
    hook = make_main_guard_hook("main", repo_root=root, branch_prefix="blimp")
    assert _call_hook(hook, "git checkout -B blimp/new") == {}  # none of ITS branches exist
    for i in range(7):
        subprocess.run(
            ["git", "branch", f"blimp/b{i}"], cwd=root, check=True, capture_output=True
        )
    deny = _call_hook(hook, "git checkout -B blimp/new")
    reason = deny["hookSpecificOutput"]["permissionDecisionReason"]
    assert "7 local blimp/* branches" in reason
    assert "reuse" in reason and "clean up" in reason
    assert _call_hook(hook, "git checkout -B blimp/b0") == {}  # existing: never caps


def test_prompt_first_look_sweeps_interrupted_leftovers():
    """WORKFLOW step 1c: an interrupted earlier run (a mid-run cancel kills the
    session wherever it stood) can strand a dirty tree or a pushed-but-PR-less
    branch. The standing first look must tell the agent to sweep both — and to
    spare the open PR's branch it is continuing."""
    from paratrooper.agent.prompt import SYSTEM_PROMPT

    assert "1c." in SYSTEM_PROMPT
    assert "`git checkout -- .`" in SYSTEM_PROMPT  # dirty tree: discard
    assert "`git clean -fd`" in SYSTEM_PROMPT
    assert "`git branch -D <branch>`" in SYSTEM_PROMPT  # stray local branch
    assert "`git push origin --delete <branch>`" in SYSTEM_PROMPT  # pushed, no PR
    assert "never clean up" in SYSTEM_PROMPT  # the open PR's branch is spared


def test_system_prompt_branch_instructions_follow_the_configured_prefix():
    """The prompt is the only thing telling the agent what to name its branch,
    so it has to agree with the guard: configure 'blimp' and every branch
    instruction says blimp/, with no paratrooper/ name left to trip the hook."""
    from paratrooper.agent.prompt import SYSTEM_PROMPT, build_system_prompt

    rendered = build_system_prompt(branch_prefix="blimp")
    assert "blimp/<short-slug>" in rendered
    assert "blimp/twen-new-photo" in rendered  # the worked example
    assert "`blimp/*` branch" in rendered  # step 1c's stray-branch sweep
    assert "paratrooper/" not in rendered
    assert build_system_prompt(branch_prefix="blimp/") == rendered  # either spelling
    # and nothing BUT the branch instructions moved
    assert rendered == SYSTEM_PROMPT.replace("paratrooper/", "blimp/")


def test_default_system_prompt_is_unchanged():
    """Default config = the prompt exactly as it read before the prefix became
    configurable: the same three branch instructions, byte for byte."""
    from paratrooper.agent.prompt import SYSTEM_PROMPT, build_system_prompt

    assert build_system_prompt() == SYSTEM_PROMPT
    assert build_system_prompt(branch_prefix="paratrooper") == SYSTEM_PROMPT
    assert build_system_prompt("digest") == (
        SYSTEM_PROMPT + "\n\n--- SESSION CONTEXT ---\ndigest"
    )
    assert "paratrooper/<short-slug>` (e.g. paratrooper/twen-new-photo)" in SYSTEM_PROMPT
    assert "`paratrooper/*` branch that is NOT the open PR's branch" in SYSTEM_PROMPT
    assert SYSTEM_PROMPT.count("paratrooper/") == 3
    assert "{prefix}" not in SYSTEM_PROMPT  # the slot is always filled


# --- the prompt's GitHub route -----------------------------------------------

# the one paragraph added when gh went into the worker image and the guard
# closed every other road; quoted here so the test can subtract it
_GITHUB_RULE = (
    "GITHUB IS REACHABLE ONLY THROUGH git AND `gh`. Open a pull request with "
    "`gh pr create` and look at pull requests with `gh pr list` / `gh pr view` — "
    "never call the GitHub API yourself: no `gh api`, no curl or wget, no Python "
    "or Node request to github.com or api.github.com, and never read the token "
    "out of the environment. The shell refuses all of those, so going around "
    "`gh` only costs you a turn."
)


def test_system_prompt_forbids_calling_the_github_api_directly():
    """The guard refuses a raw API call, but a refusal the agent never expected
    costs it a turn — the instruction has to say so up front, and name the tool
    that does work."""
    from paratrooper.agent.prompt import SYSTEM_PROMPT

    assert _GITHUB_RULE in SYSTEM_PROMPT
    assert "`gh api`" in SYSTEM_PROMPT
    assert "api.github.com" in SYSTEM_PROMPT
    # the gh commands it IS told to use are still the ones the guard allows
    assert "`gh pr list --json title,headRefName,url`" in SYSTEM_PROMPT
    assert 'gh pr create --title "..." --body "..."' in SYSTEM_PROMPT


def test_system_prompt_adds_only_the_github_rule():
    """One inserted paragraph and nothing else: subtract it and every branch-
    prefix invariant from the previous change has to still hold, word for word."""
    from paratrooper.agent.prompt import SYSTEM_PROMPT, render_system_prompt

    assert SYSTEM_PROMPT.count(_GITHUB_RULE) == 1
    before = SYSTEM_PROMPT.replace(f"\n\n{_GITHUB_RULE}", "")
    assert _GITHUB_RULE not in before
    assert "paratrooper/<short-slug>` (e.g. paratrooper/twen-new-photo)" in before
    assert "`paratrooper/*` branch that is NOT the open PR's branch" in before
    assert before.count("paratrooper/") == 3  # the added rule names no branch
    assert "{prefix}" not in before
    assert "\n\n\n" not in before  # the paragraph came out clean
    # and the templating itself is untouched: still one slot, both spellings
    assert render_system_prompt("blimp") == SYSTEM_PROMPT.replace("paratrooper/", "blimp/")
    assert render_system_prompt("blimp/") == render_system_prompt("blimp")
    assert _GITHUB_RULE in render_system_prompt("blimp")


# --- auth (3.2): manual mode, no fallback ------------------------------------

def test_auth_subscription_requires_token_and_clears_api_key(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "oat-123")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-be-cleared")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok-should-be-cleared")
    assert configure_auth("subscription") == "subscription"
    import os

    assert os.environ.get("ANTHROPIC_API_KEY") is None  # cleared so it can't win precedence
    assert os.environ.get("ANTHROPIC_AUTH_TOKEN") is None
    assert os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") == "oat-123"


def test_auth_subscription_missing_token_hard_errors(monkeypatch):
    monkeypatch.delenv("CLAUDE_CODE_OAUTH_TOKEN", raising=False)
    with pytest.raises(ConfigError, match="subscription"):
        configure_auth("subscription")


def test_auth_api_requires_key_and_clears_oauth(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-real")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "oat-should-be-cleared")
    assert configure_auth("api") == "api"
    import os

    assert os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") is None


def test_auth_invalid_mode_hard_errors(monkeypatch):
    monkeypatch.delenv("AGENT_AUTH", raising=False)
    with pytest.raises(ConfigError):
        configure_auth("")
    with pytest.raises(ConfigError):
        configure_auth("both")


def test_require_env_loud(monkeypatch):
    monkeypatch.delenv("SOME_SECRET", raising=False)
    with pytest.raises(ConfigError):
        require_env("SOME_SECRET")


# --- config (3.4) -------------------------------------------------------------

def test_load_config_resolves_paths(tmp_path):
    cfg_file = tmp_path / "paths.toml"
    cfg_file.write_text(
        '[paths]\nsite_root = "site"\ninbox = "inbox"\n[site]\ndefault_branch = "main"\n'
    )
    cfg = load_config(cfg_file)
    assert cfg.site_root == (tmp_path / "site").resolve()
    content = cfg.site_root / "src" / "content"
    assert cfg.pins_dir == content / "pins-on-display"
    # the other stages must be OUTSIDE pins_dir (Astro's glob would render them)
    assert cfg.archive_dir == content / "pins-off-display"
    assert cfg.later_dir == content / "pins-for-later"
    assert cfg.pins_dir not in cfg.archive_dir.parents
    assert cfg.pins_dir not in cfg.later_dir.parents
    assert cfg.inbox == (tmp_path / "inbox").resolve()
    assert cfg.default_branch == "main"
    assert cfg.branch_prefix == "paratrooper"


@pytest.mark.parametrize(
    "bad",
    ["", "paratrooper/", "para/trooper", "/", "para trooper", "para\ttrooper", " para", 7],
)
def test_load_config_rejects_an_unusable_branch_prefix(tmp_path, bad):
    """That one word feeds the guard, the prompt and the Publish PR lookup, so a
    word that can't name a branch is a loud config error at load — never a quiet
    fall back to the default that would leave the three disagreeing."""
    cfg_file = tmp_path / "paths.toml"
    cfg_file.write_text(
        '[paths]\nsite_root = "site"\ninbox = "inbox"\n'
        f"[site]\nbranch_prefix = {json.dumps(bad)}\n"
    )
    with pytest.raises(ConfigError, match="branch_prefix"):
        load_config(cfg_file)


def test_validate_branch_prefix_passes_ordinary_words():
    for good in ("paratrooper", "blimp", "bot-2", "a"):
        assert validate_branch_prefix(good) == good


def test_load_config_keeps_a_configured_branch_prefix(tmp_path):
    cfg_file = tmp_path / "paths.toml"
    cfg_file.write_text(
        '[paths]\nsite_root = "site"\ninbox = "inbox"\n[site]\nbranch_prefix = "blimp"\n'
    )
    assert load_config(cfg_file).branch_prefix == "blimp"  # stored bare, as publish reads it


def test_load_config_missing_file():
    with pytest.raises(ConfigError):
        load_config("/no/such/config.toml")


def test_load_config_env_overrides(tmp_path, monkeypatch):
    # render.yaml sets absolute paths via env; TOML need not carry them
    cfg_file = tmp_path / "paths.toml"
    cfg_file.write_text('[site]\ndefault_branch = "main"\n')
    monkeypatch.setenv("PARATROOPER_SITE_ROOT", str(tmp_path / "checkout"))
    monkeypatch.setenv("PARATROOPER_INBOX", str(tmp_path / "inbox"))
    cfg = load_config(cfg_file)
    assert cfg.site_root == tmp_path / "checkout"
    assert cfg.inbox == tmp_path / "inbox"
    # default pins_dir follows the env-provided site_root
    assert cfg.pins_dir == cfg.site_root / "src" / "content" / "pins-on-display"


def test_ensure_checkout_noop_and_no_remote(tmp_path):
    from paratrooper.agent.siterepo import GitError, SiteRepo

    subprocess.run(["git", "init", "-b", "main", str(tmp_path)], check=True, capture_output=True)
    existing = SiteRepo(tmp_path, remote="https://github.com/o/r.git")
    existing.ensure_checkout()  # already a checkout: no clone, no raise
    fresh = tmp_path / "fresh"
    with pytest.raises(GitError, match="no remote"):
        SiteRepo(fresh).ensure_checkout()


# --- pins ---------------------------------------------------------------------

def _make_pin(pins_dir, pin_id, data, *, image=None):
    folder = pins_dir / pin_id
    folder.mkdir(parents=True)
    (folder / "index.json").write_text(json.dumps(data))
    if image is not None:
        image.save(folder / "preview.webp", format="WEBP")
    return folder


def test_load_board_reads_size_and_cutout(tmp_path):
    pins_dir = tmp_path / "pins"
    pins_dir.mkdir()
    _make_pin(pins_dir, "earthrise", {
        "type": "image", "position": {"x": 49, "y": 64}, "size": {"w": 16, "h": 10.67},
    })
    # a cutout: RGBA with a transparent corner
    arr = np.zeros((64, 64, 4), dtype=np.uint8)
    arr[16:48, 16:48] = [255, 0, 0, 255]  # opaque square center
    cutout_img = Image.fromarray(arr, mode="RGBA")
    _make_pin(pins_dir, "ram", {
        "type": "image", "position": {"x": 50, "y": 45}, "size": {"w": 18, "h": 18},
        "frameless": True,
    }, image=cutout_img)

    board = pins.load_board(pins_dir)
    by_id = {p.id: p for p in board}
    assert by_id["earthrise"].w == 16 and by_id["earthrise"].h == pytest.approx(10.67)
    assert by_id["ram"].is_cutout and by_id["ram"].silhouette is not None
    # exclude works
    assert "ram" not in {p.id for p in pins.load_board(pins_dir, exclude="ram")}


def test_to_engine_pin_missing_size_raises(tmp_path):
    pins_dir = tmp_path / "pins"
    pins_dir.mkdir()
    _make_pin(pins_dir, "bad", {"type": "text", "position": {"x": 50, "y": 50}})
    with pytest.raises(pins.PinError):
        pins.load_board(pins_dir)


def test_write_and_archive_pin(tmp_path):
    pins_dir = tmp_path / "pins"
    archive = tmp_path / "archive"
    pins.write_pin(
        pins_dir, "twen",
        {"type": "image", "position": {"x": 20, "y": 80}, "size": {"w": 12, "h": 12}},
    )
    assert (pins_dir / "twen" / "index.json").is_file()
    dst = pins.archive_pin(pins_dir, archive, "twen")
    assert dst.is_dir() and not (pins_dir / "twen").exists()
    # archiving a non-existent pin is loud
    with pytest.raises(pins.PinError):
        pins.archive_pin(pins_dir, archive, "ghost")


def test_slugify():
    assert pins.slugify("New Favorite Band!") == "new-favorite-band"
    assert pins.slugify("   ") == "pin"


# --- images -------------------------------------------------------------------

def test_process_image_aspect_and_webp(tmp_path):
    src = tmp_path / "in.png"
    Image.new("RGB", (400, 200), "navy").save(src)
    res = images.process_image(src, tmp_path / "pin" / "preview.webp", max_dim=100)
    assert res.path.is_file()
    assert res.aspect == pytest.approx(2.0)
    assert max(res.width, res.height) <= 100  # downscaled
    assert not res.has_alpha


def test_process_image_preserves_alpha(tmp_path):
    src = tmp_path / "in.png"
    Image.new("RGBA", (120, 120), (255, 0, 0, 0)).save(src)
    res = images.process_image(src, tmp_path / "out.webp")
    assert res.has_alpha


# --- spotify (pure URL logic; no network) ------------------------------------

def test_spotify_url_helpers():
    tid = "48kjJJiIOGBhCX3Bnz8qJe"
    assert spotify.track_id_from_url(f"https://open.spotify.com/track/{tid}") == tid
    embed = "https://open.spotify.com/embed/track/ABC?utm_source=generator"
    assert spotify.track_id_from_url(embed) == "ABC"
    assert spotify.track_id_from_url("https://example.com/foo") is None
    assert spotify.embed_url("XYZ") == "https://open.spotify.com/embed/track/XYZ?utm_source=generator"


def test_resolve_link_rejects_non_track():
    with pytest.raises(ValueError):
        spotify.resolve_link("https://open.spotify.com/album/123")


# --- memory (3.3) -------------------------------------------------------------

def test_changelog_digest_and_fetch(tmp_path):
    cl = memory.Changelog(tmp_path / "changelog.jsonl")
    for i in range(12):
        cl.append(memory.ChangelogEntry(
            ts=f"2026-06-{i+1:02d}T00:00:00Z", pin_id=f"p{i}", action="add", summary=f"s{i}"
        ))
    digest = cl.hot_digest(10)
    assert len(digest) == 10
    assert digest[0]["pin_id"] == "p11"  # most recent first
    assert len(cl.fetch_history(n=3)) == 3
    assert cl.fetch_history(start=0, end=2) == cl.read_all()[:2]
    assert "p11" in memory.format_digest(digest)
    assert memory.format_digest([]) == "No prior pinboard updates recorded."


# --- tools: server construction ----------------------------------------------

def test_build_tool_server(tmp_path):
    from paratrooper.agent.config import Config

    cfg = Config(
        inbox=tmp_path / "inbox",
        site_root=tmp_path / "site",
        pins_dir=tmp_path / "pins",
        archive_dir=tmp_path / "arch",
        later_dir=tmp_path / "later",
        changelog=tmp_path / "cl.jsonl",
        remote=None,
        default_branch="main",
        branch_prefix="paratrooper",
    )
    ctx = ToolContext(
        config=cfg,
        changelog=memory.Changelog(cfg.changelog),
    )
    server, names = build_tool_server(ctx)
    assert server["name"] == "paratrooper"
    assert "mcp__paratrooper__place_pin" in names
    assert "mcp__paratrooper__move_pin" in names
    assert "mcp__paratrooper__report_pr" in names
    assert "mcp__paratrooper__post_update" in names
    # the git tools are gone — the agent runs git/gh through its own shell now
    for gone in ("start_branch", "git_commit", "git_push", "open_pr"):
        assert f"mcp__paratrooper__{gone}" not in names
    assert len(names) == 10


# --- siterepo (bootstrap) ----------------------------------------------------

def test_git_auth_never_embeds_token(tmp_path, monkeypatch):
    """The PAT must never ride in git argv (visible in `ps`, persisted by clone
    into .git/config) — only in the askpass env; the helper file holds no secret."""
    calls = []

    def fake_run(cmd, **kw):
        calls.append((cmd, kw.get("env")))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr("paratrooper.agent.siterepo.subprocess.run", fake_run)
    repo = SiteRepo(
        tmp_path / "co", github_token="sekret",
        remote="https://github.com/o/r.git",
    )
    repo.ensure_checkout()
    # clone (authenticated), then the two identity config calls (local, no auth)
    assert [cmd[:2] for cmd, _ in calls] == [
        ["git", "clone"], ["git", "config"], ["git", "config"],
    ]
    for cmd, _ in calls:
        assert all("sekret" not in part for part in cmd)
    clone_env = calls[0][1]
    assert clone_env["PARATROOPER_GIT_ASKPASS_TOKEN"] == "sekret"
    askpass = Path(clone_env["GIT_ASKPASS"])
    assert askpass.exists() and "sekret" not in askpass.read_text()
    assert os.access(askpass, os.X_OK)
    assert calls[1][1] is None and calls[2][1] is None  # config runs env-untouched


def test_ensure_checkout_pins_bot_identity(tmp_path):
    """Identity is set once on the checkout (bootstrap), not per branch — a
    plain `git commit` from the agent's own shell must carry the linked bot
    attribution."""
    subprocess.run(["git", "init", "-b", "main", str(tmp_path)], check=True, capture_output=True)
    repo = SiteRepo(tmp_path)
    repo.ensure_checkout()
    assert repo._git("config", "user.name") == DEFAULT_GIT_NAME
    assert repo._git("config", "user.email") == DEFAULT_GIT_EMAIL
    # commit the way the agent does: plain git in the checkout, no env forcing
    clean_env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    subprocess.run(
        ["git", "commit", "--allow-empty", "-m", "add pin"],
        cwd=tmp_path, check=True, capture_output=True, env=clean_env,
    )
    author = repo._git("show", "-s", "--format=%an <%ae>", "HEAD")
    assert author == f"{DEFAULT_GIT_NAME} <{DEFAULT_GIT_EMAIL}>"

    # self-hosters can point commits at their own app/account
    custom = SiteRepo(tmp_path, git_name="other[bot]",
                      git_email="1+other[bot]@users.noreply.github.com")
    custom.ensure_checkout()
    assert custom._git("config", "user.name") == "other[bot]"


def test_move_pin_between_stages(tmp_path):
    on, off, later = tmp_path / "on", tmp_path / "off", tmp_path / "later"
    pins.write_pin(later, "future", {
        "type": "image", "notes": "goes up next month",
        "position": {"x": 50, "y": 50}, "size": {"w": 10, "h": 10},
    })
    # for-later -> on-display (publish)
    dst = pins.move_pin(later, on, "future")
    assert dst == on / "future" and not (later / "future").exists()
    # on-display -> off-display (archive)
    pins.move_pin(on, off, "future")
    assert (off / "future" / "index.json").is_file()
    # collision guard: put a fresh one on display, try to archive onto the old
    pins.write_pin(on, "future", {"type": "text", "text": "v2",
                                  "position": {"x": 50, "y": 50}, "size": {"w": 10, "h": 10}})
    with pytest.raises(pins.PinError, match="refusing to overwrite"):
        pins.move_pin(on, off, "future")


def _tool_handlers(ctx) -> dict:
    """Build the tool server while capturing each handler by bare name, so
    tests can call the tools directly."""
    import paratrooper.agent.tools as tools_mod
    from paratrooper.agent.tools import build_tool_server

    handlers = {}
    orig = tools_mod.create_sdk_mcp_server

    def capture(name, version, tools):
        for t in tools:
            handlers[t.name] = t.handler
        return orig(name=name, version=version, tools=tools)

    tools_mod.create_sdk_mcp_server = lambda name, version, tools: capture(name, version, tools)
    try:
        build_tool_server(ctx)
    finally:
        tools_mod.create_sdk_mcp_server = orig
    return handlers


def _tool_cfg(tmp_path):
    from paratrooper.agent.config import Config

    return Config(
        inbox=tmp_path / "inbox",
        site_root=tmp_path / "site",
        pins_dir=tmp_path / "pins",
        archive_dir=tmp_path / "arch",
        later_dir=tmp_path / "later",
        changelog=tmp_path / "cl.jsonl",
        remote=None,
        default_branch="main",
        branch_prefix="paratrooper",
    )


def test_edit_tools_run_without_branch(tmp_path):
    """Branching moved into the agent's own shell (prompt-driven), so the edit
    tools must run without any in-process branch state — no gate left."""
    cfg = _tool_cfg(tmp_path)
    cfg.inbox.mkdir(parents=True)
    Image.new("RGB", (64, 32), "navy").save(cfg.inbox / "k.png")
    pins.write_pin(cfg.later_dir, "future", {
        "type": "text", "text": "v",
        "position": {"x": 50, "y": 50}, "size": {"w": 10, "h": 10},
    })
    ctx = ToolContext(config=cfg, changelog=memory.Changelog(cfg.changelog))
    assert ctx.branch is None
    handlers = _tool_handlers(ctx)

    out = asyncio.run(handlers["process_image"]({"inbox_key": "k.png", "pin_id": "p1"}))
    assert not out.get("is_error"), out
    assert (cfg.pins_dir / "p1" / "preview.webp").is_file()

    out = asyncio.run(handlers["move_pin"]({"pin_id": "future", "to": "on-display"}))
    assert not out.get("is_error"), out
    assert (cfg.pins_dir / "future" / "index.json").is_file()


def test_report_pr_records_url_and_branch(tmp_path):
    """report_pr is the one seam left between the agent's shell git and the
    app: the url + branch it records are exactly what the worker's 'pr' event
    (and so the Publish button) is built from."""
    ctx = ToolContext(config=_tool_cfg(tmp_path), changelog=memory.Changelog(tmp_path / "cl.jsonl"))
    handlers = _tool_handlers(ctx)

    out = asyncio.run(handlers["report_pr"]({
        "url": "https://github.com/o/r/pull/7", "branch": "paratrooper/twen-new-photo",
    }))
    assert not out.get("is_error")
    assert ctx.last_pr == "https://github.com/o/r/pull/7"
    assert ctx.branch == "paratrooper/twen-new-photo"

    # missing pieces are loud — a silent no-op here kills the Publish button
    out = asyncio.run(handlers["report_pr"]({"url": "", "branch": "x"}))
    assert out.get("is_error")
    out = asyncio.run(handlers["report_pr"]({"url": "https://github.com/o/r/pull/7"}))
    assert out.get("is_error")


def test_append_changelog_branch_is_explicit(tmp_path):
    """The changelog no longer tags entries from in-process branch state — the
    agent passes the branch it created in its own shell (or omits it)."""
    cfg = _tool_cfg(tmp_path)
    ctx = ToolContext(
        config=cfg, changelog=memory.Changelog(cfg.changelog),
        now=lambda: "2026-08-17T00:00:00+00:00",
    )
    handlers = _tool_handlers(ctx)

    out = asyncio.run(handlers["append_changelog"]({
        "pin_id": "twen", "action": "add", "summary": "s",
        "branch": "paratrooper/twen-new-photo",
    }))
    assert not out.get("is_error")
    assert memory.Changelog(cfg.changelog).read_all()[-1]["branch"] == "paratrooper/twen-new-photo"

    # no branch passed -> untagged entry; ctx.branch must never leak in
    ctx.branch = "paratrooper/should-not-leak"
    asyncio.run(handlers["append_changelog"]({"pin_id": "twen", "action": "edit", "summary": "s2"}))
    assert "branch" not in memory.Changelog(cfg.changelog).read_all()[-1]


def test_post_update_tool(tmp_path):
    """post_update pushes an interim 'update' through the live channel; empty
    text is refused; without a channel (CLI/offline runs) it no-ops quietly."""
    sent: list[str] = []

    async def channel(text: str) -> None:
        sent.append(text)

    ctx = ToolContext(
        config=_tool_cfg(tmp_path),
        changelog=memory.Changelog(tmp_path / "cl.jsonl"),
        emit_update=channel,
    )
    handlers = _tool_handlers(ctx)

    out = asyncio.run(handlers["post_update"]({"text": "On it, adding the pin now."}))
    assert not out.get("is_error")
    assert sent == ["On it, adding the pin now."]

    out = asyncio.run(handlers["post_update"]({"text": "   "}))
    assert out.get("is_error")

    ctx.emit_update = None  # offline run: degrade, don't error the agent
    out = asyncio.run(handlers["post_update"]({"text": "hello"}))
    assert not out.get("is_error")
    assert sent == ["On it, adding the pin now."]


def test_run_job_wires_live_update_channel(tmp_path, monkeypatch):
    """run_job must hand the tool server a live emit_update channel: what
    post_update sends has to reach on_event as an 'update' result mid-job,
    before the final 'done'."""
    import paratrooper.agent.worker as worker_mod

    captured: dict = {}
    events: list[dict] = []

    def fake_build_tool_server(ctx):
        captured["ctx"] = ctx
        return {"name": "paratrooper"}, []

    async def fake_query(*, prompt, options):
        # stand-in for the agent calling post_update mid-session
        await captured["ctx"].emit_update("On it.")
        if False:
            yield

    monkeypatch.setattr(worker_mod, "configure_auth", lambda mode: "api")
    monkeypatch.setattr(worker_mod, "build_tool_server", fake_build_tool_server)
    monkeypatch.setattr(worker_mod, "query", fake_query)

    job = worker_mod.Job(job_id="j1", thread_id="t1", text="add the pin")
    result = asyncio.run(
        worker_mod.run_job(job, config=_tool_cfg(tmp_path), on_event=events.append)
    )

    assert result.status == "done"
    kinds = [e["kind"] for e in events]
    assert "update" in kinds
    assert kinds.index("update") < kinds.index("done")
    update = next(e for e in events if e["kind"] == "update")
    assert update == {"job_id": "j1", "kind": "update", "payload": "On it."}


def test_run_job_emits_pr_event_from_reported_pr(tmp_path, monkeypatch):
    """The Publish button path end to end at the worker seam: whatever the
    report_pr tool recorded on the context must leave run_job as a 'pr' event
    carrying {branch, url} and land on the JobResult."""
    import paratrooper.agent.worker as worker_mod

    captured: dict = {}
    events: list[dict] = []

    def fake_build_tool_server(ctx):
        captured["ctx"] = ctx
        return {"name": "paratrooper"}, []

    async def fake_query(*, prompt, options):
        # stand-in for the agent calling report_pr after its shell git/gh work
        captured["ctx"].last_pr = "https://github.com/o/r/pull/9"
        captured["ctx"].branch = "paratrooper/twen-new-photo"
        if False:
            yield

    monkeypatch.setattr(worker_mod, "configure_auth", lambda mode: "api")
    monkeypatch.setattr(worker_mod, "build_tool_server", fake_build_tool_server)
    monkeypatch.setattr(worker_mod, "query", fake_query)

    job = worker_mod.Job(job_id="j2", thread_id="t1", text="make it bigger")
    result = asyncio.run(
        worker_mod.run_job(job, config=_tool_cfg(tmp_path), on_event=events.append)
    )

    pr = next(e for e in events if e["kind"] == "pr")
    assert pr["payload"] == {
        "branch": "paratrooper/twen-new-photo",
        "url": "https://github.com/o/r/pull/9",
    }
    assert result.pr == "https://github.com/o/r/pull/9"
    assert result.branch == "paratrooper/twen-new-photo"


def test_run_job_hands_github_auth_to_the_session_env(tmp_path, monkeypatch):
    """With the PAT configured, the session options must carry what git/gh
    actually read — GH_TOKEN plus the askpass wiring — with the token only in
    env values, never inside the helper file (it echoes the var by name)."""
    import paratrooper.agent.worker as worker_mod

    captured: dict = {}

    def fake_build_tool_server(ctx):
        return {"name": "paratrooper"}, []

    async def fake_query(*, prompt, options):
        captured["options"] = options
        if False:
            yield

    monkeypatch.setenv("PARATROOPER_GITHUB_TOKEN", "ghp-sekret")
    monkeypatch.setattr(worker_mod, "configure_auth", lambda mode: "api")
    monkeypatch.setattr(worker_mod, "build_tool_server", fake_build_tool_server)
    monkeypatch.setattr(worker_mod, "query", fake_query)

    job = worker_mod.Job(job_id="j3", thread_id="t1", text="push the change")
    result = asyncio.run(worker_mod.run_job(job, config=_tool_cfg(tmp_path)))

    assert result.status == "done"
    env = captured["options"].env
    assert env["GH_TOKEN"] == "ghp-sekret"  # gh's native variable
    assert env["PARATROOPER_GIT_ASKPASS_TOKEN"] == "ghp-sekret"
    askpass = Path(env["GIT_ASKPASS"])
    assert askpass.exists() and os.access(askpass, os.X_OK)
    body = askpass.read_text()
    assert "PARATROOPER_GIT_ASKPASS_TOKEN" in body  # echoes by name...
    assert "ghp-sekret" not in body  # ...never by value


def test_run_job_without_github_token_skips_auth_env(tmp_path, monkeypatch):
    """No PAT (local dev) must mean no partial wiring: the session env stays
    empty and the job still runs cleanly."""
    import paratrooper.agent.worker as worker_mod

    captured: dict = {}

    def fake_build_tool_server(ctx):
        return {"name": "paratrooper"}, []

    async def fake_query(*, prompt, options):
        captured["options"] = options
        if False:
            yield

    monkeypatch.delenv("PARATROOPER_GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(worker_mod, "configure_auth", lambda mode: "api")
    monkeypatch.setattr(worker_mod, "build_tool_server", fake_build_tool_server)
    monkeypatch.setattr(worker_mod, "query", fake_query)

    job = worker_mod.Job(job_id="j4", thread_id="t1", text="just chatting")
    result = asyncio.run(worker_mod.run_job(job, config=_tool_cfg(tmp_path)))

    assert result.status == "done"
    env = captured["options"].env
    for key in ("GH_TOKEN", "GIT_ASKPASS", "PARATROOPER_GIT_ASKPASS_TOKEN", "GIT_TERMINAL_PROMPT"):
        assert key not in env


def test_run_job_hands_the_branch_word_to_both_the_prompt_and_the_guard(tmp_path, monkeypatch):
    """The configured word must reach BOTH ends of a session: the prompt that
    tells the agent what to name its branch, and the hook that decides whether
    that branch is allowed. Wired to only one of them, they disagree and every
    branch the agent makes gets denied."""
    import paratrooper.agent.worker as worker_mod

    captured: dict = {}

    def fake_build_tool_server(ctx):
        return {"name": "paratrooper"}, []

    async def fake_query(*, prompt, options):
        captured["options"] = options
        if False:
            yield

    monkeypatch.setattr(worker_mod, "configure_auth", lambda mode: "api")
    monkeypatch.setattr(worker_mod, "build_tool_server", fake_build_tool_server)
    monkeypatch.setattr(worker_mod, "query", fake_query)

    cfg = _tool_cfg(tmp_path)
    cfg.branch_prefix = "blimp"
    job = worker_mod.Job(job_id="j5", thread_id="t1", text="add the pin")
    assert asyncio.run(worker_mod.run_job(job, config=cfg)).status == "done"

    options = captured["options"]
    assert "blimp/<short-slug>" in options.system_prompt
    assert "paratrooper/" not in options.system_prompt
    guard = options.hooks["PreToolUse"][0].hooks[0]
    assert _call_hook(guard, "git checkout -B blimp/x") == {}
    denied = _call_hook(guard, "git checkout -B paratrooper/x")
    assert denied["hookSpecificOutput"]["permissionDecision"] == "deny"


def test_run_job_rejects_an_unusable_branch_word_before_starting(tmp_path, monkeypatch):
    """A word that can't name a branch stops the job at the door, not halfway
    through a session with a half-branched checkout."""
    import paratrooper.agent.worker as worker_mod

    ran: list[bool] = []

    async def fake_query(*, prompt, options):
        ran.append(True)
        if False:
            yield

    monkeypatch.setattr(worker_mod, "configure_auth", lambda mode: "api")
    monkeypatch.setattr(worker_mod, "query", fake_query)

    cfg = _tool_cfg(tmp_path)
    cfg.branch_prefix = "para/trooper"
    job = worker_mod.Job(job_id="j6", thread_id="t1", text="add the pin")
    with pytest.raises(ConfigError, match="branch_prefix"):
        asyncio.run(worker_mod.run_job(job, config=cfg))
    assert not ran


def test_run_job_closes_the_secret_files_to_the_file_tools(tmp_path, monkeypatch):
    """Both halves of the rule have to reach the session: the CLI's own refusal
    of the two roots, and the guard registered for the three tools that open
    files without a command line. With only the Bash matcher, as before, a Read
    of /proc/1/environ was an ordinary file read."""
    import paratrooper.agent.worker as worker_mod

    captured: dict = {}

    def fake_build_tool_server(ctx):
        return {"name": "paratrooper"}, []

    async def fake_query(*, prompt, options):
        captured["options"] = options
        if False:
            yield

    monkeypatch.setattr(worker_mod, "configure_auth", lambda mode: "api")
    monkeypatch.setattr(worker_mod, "build_tool_server", fake_build_tool_server)
    monkeypatch.setattr(worker_mod, "query", fake_query)

    job = worker_mod.Job(job_id="j7", thread_id="t1", text="read the pin file")
    assert asyncio.run(worker_mod.run_job(job, config=_tool_cfg(tmp_path))).status == "done"

    options = captured["options"]
    assert options.disallowed_tools == ["Read(//proc/**)", "Read(//etc/secrets/**)"]
    matchers = options.hooks["PreToolUse"]
    assert [m.matcher for m in matchers] == ["Bash", "Read", "Glob", "Grep"]
    # registered is not the same as working: each file matcher must really deny
    realistic = {
        "Read": {"file_path": "/proc/1/environ"},
        "Glob": {"pattern": "/proc/**"},
        "Grep": {"pattern": "TOKEN", "path": "/proc"},
    }
    for matcher in matchers[1:]:
        deny = _call_file_hook(matcher.hooks[0], matcher.matcher, realistic[matcher.matcher])
        assert deny["hookSpecificOutput"]["permissionDecision"] == "deny", matcher.matcher


def test_is_text_delta_classifier():
    """Typing dots must fire only on message-text streaming, not tool/thinking
    deltas."""
    from paratrooper.agent.worker import _is_text_delta

    text = {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "h"}}
    tool = {"type": "content_block_delta", "delta": {"type": "input_json_delta"}}
    assert _is_text_delta(text)
    assert not _is_text_delta(tool)
    assert not _is_text_delta({"type": "content_block_delta", "delta": {"type": "thinking_delta"}})
    assert not _is_text_delta({"type": "content_block_start"})
    assert not _is_text_delta({})
