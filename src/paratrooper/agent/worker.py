"""The worker entry point: run one pin-update job through the Agent SDK.

Ties Phase 3 together. Per request: lock in auth (subscription/api, no fallback),
refresh the checkout from the remote, build the in-process tool server + the
custom system prompt (with the hot memory digest) + the main-guard PreToolUse
hook, then drive a headless streaming session. The agent does its own local git
through Bash (branch off origin/main or continue an open PR's branch; the hook
fences main/merges); everything that reaches GitHub is a worker-owned tool, with
the credential held here and kept out of the session's environment. Progress
(logs, screenshot, PR) is streamed to an optional callback so the web service can
relay it over the socket; the final result + artifacts are returned.

One session per request, started fresh — matching the task-based session model.

**Why a streaming client and not the one-shot ``query()``.** Everything this
session guards runs over one channel: the CLI asks *back* down its own stdin for
every PreToolUse hook decision, every in-process tool call and every permission
question. ``query()`` with a string prompt closes that channel the moment the
first result arrives (``wait_for_result_and_end_input`` in the SDK), and the CLI
then answers its own questions with ``Error("Stream closed")``: hook callbacks
are skipped, so the branch fence and the secret-file refusals quietly stop
running, and any tool call the CLI's rules do not settle is refused with "Tool
permission request failed", which is a turn in which nothing the agent touches
works. :func:`run_session` uses ``ClaudeSDKClient``, which holds stdin open for
the life of the turn and closes it on the way out.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

import anyio
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    StreamEvent,
)

from .auth import configure_auth
from .config import (
    Config,
    ConfigError,
    load_config,
    spotify_credentials,
    validate_branch_prefix,
)
from .github_app import installation_token
from .hooks import make_file_guard_hook, make_main_guard_hook
from .memory import Changelog, format_digest
from .prompt import build_system_prompt
from .siterepo import SiteRepo
from .tools import SERVER_NAME, ToolContext, build_tool_server

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "claude-opus-4-8"
# headless built-ins the agent needs; Bash is gated by the main-guard hook and
# the three file tools by the file guard
BUILTIN_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
# the CLI's own refusal of the two secret-bearing roots, in its permission-rule
# syntax. The file guard denies the same two; this one does not depend on the
# hook being reached at all.
DENIED_READS = ["Read(//proc/**)", "Read(//etc/secrets/**)"]
# Claude Code's own switch for stripping provider credentials from the
# subprocesses it opens; carried by the bundled CLI from 2.1.83, which the
# pinned SDK version is checked against in the tests. Every session pins it to a
# value — see the comment on session_env in run_job for which value and why.
SCRUB_VAR = "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"

EventCallback = Callable[[dict], Awaitable[None] | None]


def make_tool_gate(session_tools: list[str]):
    """Answer the CLI's permission questions from the session's own tool list.

    The CLI does not always keep the mode the session asked for: it was the
    scrub switch that reset it to ``default``, the mode that *asks*, and a reset
    from any cause has the same consequence. Any tool call the CLI's own rules do
    not settle becomes a question put to this session over the control stream. A
    session that cannot answer is not a stricter session, it is a broken one —
    the CLI turns an unanswered question into "Tool permission request failed",
    so the agent's shell and file tools fail one after another and it reports
    that it has no shell. Nothing here depends on which mode is in force, which
    is the point: the answer is the same either way.

    This answers from :data:`session_tools`, the very list the session declares
    in ``allowed_tools``, so the set of tools the agent may run is exactly what
    that list says: a name on it runs, a name off it is refused. **It never
    approves by default** — there is no branch here that says yes to something
    unnamed, which is the whole reason the answer is derived from the list
    rather than from the question. The hooks still run first and a hook's deny
    still wins, and ``disallowed_tools`` is refused by the CLI before anything
    is asked, so neither fence depends on this."""
    names = {name.split("(", 1)[0] for name in session_tools}

    async def gate(tool_name: str, tool_input: dict, context: object):
        if tool_name in names:
            return PermissionResultAllow()
        return PermissionResultDeny(
            message=(
                f"{tool_name} is not one of this session's tools. Paratrooper's "
                "agent has the pinboard tools, the shell and the file tools, and "
                "nothing else; there is no way to widen that from inside a turn."
            )
        )

    return gate


async def run_session(*, prompt: str, options: ClaudeAgentOptions):
    """Drive one turn and yield the messages it produces.

    A streaming client rather than ``query()``: the control stream carries the
    hook decisions, the in-process tool calls and the permission answers, and it
    has to stay open for as long as the turn is running (see the module
    docstring). ``receive_response()`` ends at the turn's result, and leaving the
    context closes stdin and the CLI with it."""
    async with ClaudeSDKClient(options=options) as client:
        await client.query(prompt)
        async for message in client.receive_response():
            yield message


@dataclass
class Job:
    """Web -> worker job (architecture: web/worker message contract)."""

    job_id: str
    thread_id: str
    text: str
    attachments: list[str] = field(default_factory=list)  # inbox keys
    context: list[str] = field(default_factory=list)  # recent thread lines
    pin_hint: str | None = None  # optional pin id, for the branch name


@dataclass
class JobResult:
    job_id: str
    status: str  # "done" | "error"
    branch: str | None = None
    pr: str | None = None
    screenshot: str | None = None
    result_text: str = ""
    error: str | None = None


def _is_text_delta(raw_event: dict) -> bool:
    """True when a raw API stream event is the agent writing message text (as
    opposed to tool calls/thinking) — the moment the phone should show dots."""
    if raw_event.get("type") != "content_block_delta":
        return False
    return (raw_event.get("delta") or {}).get("type") == "text_delta"


def _build_prompt(job: Job) -> str:
    parts = [job.text.strip()]
    if job.attachments:
        parts.append(f"\n[attachments staged in the inbox, keys: {', '.join(job.attachments)}]")
    if job.context:
        parts.append("\n[recent thread]\n" + "\n".join(job.context))
    return "\n".join(parts)


async def _emit(cb: EventCallback | None, event: dict) -> None:
    if cb is None:
        return
    res = cb(event)
    if hasattr(res, "__await__"):
        await res


def _refresh_checkout(config: Config, token: str) -> None:
    """Bring ``origin/*`` up to date before a turn starts.

    A failure warns and lets the turn run. This is a refresh of state the agent
    used to refresh for itself, and when its own ``git fetch`` failed the turn
    carried on; turning a network blip into a failed message would be a new way
    for every request to die, which is not what taking a credential away is
    supposed to cost. Anything that actually needs the remote — the push, the
    pull request — fails loudly on its own with the same cause."""
    try:
        SiteRepo(
            config.site_root,
            default_branch=config.default_branch,
            github_token=token,
            remote=config.remote,
            git_name=config.git_name,
            git_email=config.git_email,
        ).fetch()
    except Exception as exc:
        logger.warning("could not refresh the site checkout before the turn: %s", exc)


async def run_job(
    job: Job,
    *,
    config: Config | None = None,
    auth_mode: str | None = None,
    model: str = DEFAULT_MODEL,
    on_event: EventCallback | None = None,
) -> JobResult:
    """Run one job end-to-end. Auth is locked in first (loud failure, no
    fallback). Returns a :class:`JobResult`; never raises for ordinary tool
    failures (those reach the agent), but a config/auth error propagates — by
    design it should crash the job visibly."""
    configure_auth(auth_mode)  # subscription|api, hard-error if misconfigured
    config = config or load_config()
    # one word fences the guard, names the branches the prompt asks for, and
    # filters the Publish PR lookup: check it here, before any git or agent work,
    # so a bad one is a loud failure and never a quiet fall back to the default
    validate_branch_prefix(config.branch_prefix)

    async def emit(kind: str, payload: object) -> None:
        await _emit(on_event, {"job_id": job.job_id, "kind": kind, "payload": payload})

    changelog = Changelog(config.changelog)

    try:
        spotify_creds = spotify_credentials()
    except ConfigError:
        spotify_creds = None  # Spotify name-search is optional; links still resolve

    # The GitHub credential the worker holds: an installation token for the
    # paratrooper-98cc App, minted here and good for an hour. It reaches the
    # three handoff tools and stops there. It is deliberately NOT in session_env
    # below: the SDK builds the CLI's environment from os.environ plus that
    # dict, so a token placed there is a token in every shell the agent opens,
    # which is the whole thing this phase removes.
    #
    # ConfigError means the App is not configured at all, which is a local run:
    # the tools say so and the rest of the session behaves as before. A refusal
    # from GitHub is not caught — there is no second credential to try, and a
    # turn that quietly ran without one would look like it had pushed.
    try:
        gh_token = installation_token(config)
    except ConfigError:
        gh_token = None
    # Anthropic's scrub switch, pinned OFF. With it on, the pinned CLI deletes
    # the Claude credential and the other provider keys from the environment of
    # every Bash shell, hook and stdio MCP subprocess it opens — but on Linux it
    # implements that by running each of those shells under bubblewrap, and the
    # sandbox is then mandatory: a shell that cannot be sandboxed does not run.
    # On this host it cannot be. A probe of the running worker found its
    # container policy refusing the mount the sandbox makes first
    # (`mount(MS_SLAVE|MS_REC)` on `/`), so with the switch on every shell
    # command the agent tries answers that it failed to initialize and the agent
    # reports it has no shell at all. Off, the shells run.
    #
    # What that costs is real and is not nothing: the pinned CLI still keeps the
    # Claude credential out of an ordinary shell's own environment, but nothing
    # sandboxes that shell any more, so code running in it can go looking for
    # other processes' environments and only the kernel's own checks stand in
    # the way. The fences that remain are the tool gate, the allowed-tools list,
    # the two denied read roots, the guard hooks, and a worker that hands the
    # session no GitHub token.
    #
    # Written out rather than left unset on purpose: the SDK merges this dict
    # over the worker's inherited environment, so an explicit value is the only
    # form that answers the question here instead of wherever the host's
    # environment was configured.
    session_env: dict[str, str] = {
        SCRUB_VAR: "0",
        "GIT_TERMINAL_PROMPT": "0",  # fail fast, never hang on a prompt
    }

    # The agent used to run `git fetch` itself. It cannot now, so the worker
    # refreshes origin/* before the session: without this the agent branches off
    # whatever the default branch looked like at boot and never sees the branch
    # of a pull request it is meant to continue.
    if gh_token:
        await anyio.to_thread.run_sync(_refresh_checkout, config, gh_token)

    async def emit_update(text: str) -> None:
        # the post_update tool's live channel: an agent-authored interim bubble
        await emit("update", text)

    # No branch/PR yet: the agent branches (or continues an open PR's branch)
    # in its own shell only when it actually changes the board, and the push
    # and pull request tools record what they did — pure conversation never
    # touches git.
    ctx = ToolContext(
        config=config,
        changelog=changelog,
        spotify_creds=spotify_creds,
        emit_update=emit_update,
        github_token=gh_token,
    )
    server, tool_names = build_tool_server(ctx)
    # the guard fences the agent onto the configured <prefix>/* branches; the site
    # checkout root lets it also enforce the local agent-branch cap by counting there
    guard = make_main_guard_hook(
        config.default_branch,
        repo_root=config.site_root,
        branch_prefix=config.branch_prefix,
    )
    # the shell guard's twin for the tools that open files without a command
    # line: one Read of /proc/1/environ would hand over the whole environment
    file_guard = make_file_guard_hook()

    # the one list of what this session may run: it is declared to the CLI as
    # allow rules AND is the answer the permission gate gives, so there is a
    # single place that says what the agent has
    session_tools = tool_names + BUILTIN_TOOLS

    options = ClaudeAgentOptions(
        model=model,
        system_prompt=build_system_prompt(
            format_digest(changelog.hot_digest()), branch_prefix=config.branch_prefix
        ),
        cwd=str(config.site_root),
        # extra vars for the CLI subprocess (and so the agent's Bash shells);
        # merged over the inherited worker env by the SDK transport
        env=session_env,
        mcp_servers={SERVER_NAME: server},
        allowed_tools=session_tools,
        disallowed_tools=DENIED_READS,
        # headless least-privilege: listed tools run, unlisted are denied without
        # prompting; the main-guard hook denies dangerous Bash (deny beats this mode).
        # This is what the session asks for, not a guarantee of what the CLI runs
        # with — the scrub switch used to override it to `default` — so the gate
        # below produces the same behaviour by hand whatever the CLI settles on.
        permission_mode="dontAsk",
        # who answers when the CLI asks. Same list as allowed_tools above, so the
        # answer cannot widen what the session declared.
        can_use_tool=make_tool_gate(session_tools),
        hooks={
            "PreToolUse": [
                HookMatcher(matcher="Bash", hooks=[guard]),
                HookMatcher(matcher="Read", hooks=[file_guard]),
                HookMatcher(matcher="Glob", hooks=[file_guard]),
                HookMatcher(matcher="Grep", hooks=[file_guard]),
            ]
        },
        # a single oversized CLI message (e.g. an image read) overflows the
        # default 1MB json buffer and kills the whole job — give it headroom
        max_buffer_size=10 * 1024 * 1024,
        # stream partials so we can signal "composing text" (typing dots) as
        # distinct from "running tools" (status line)
        include_partial_messages=True,
    )

    result_text = ""
    typing_announced = False
    try:
        async for message in run_session(prompt=_build_prompt(job), options=options):
            if isinstance(message, StreamEvent):
                if not typing_announced and _is_text_delta(message.event):
                    typing_announced = True  # once per composition
                    await emit("typing", None)
            elif isinstance(message, AssistantMessage):
                # interim assistant text is the agent narrating its work — NOT a
                # message for Akash. Only the final reply (ResultMessage) is.
                typing_announced = False
            elif isinstance(message, ResultMessage):
                result_text = getattr(message, "result", "") or ""
    except Exception as exc:  # SDK/transport error -> visible job failure
        await emit("error", str(exc))
        return JobResult(job.job_id, "error", branch=ctx.branch, error=str(exc))

    if ctx.last_screenshot:
        await emit("screenshot", ctx.last_screenshot)
    if ctx.last_pr:
        await emit("pr", {"branch": ctx.branch, "url": ctx.last_pr})
    await emit("done", result_text)  # the ONE reply bubble for this job

    return JobResult(
        job_id=job.job_id,
        status="done",
        branch=ctx.branch,
        pr=ctx.last_pr,
        screenshot=ctx.last_screenshot,
        result_text=result_text,
    )


def main() -> None:
    """CLI: run a job from a JSON blob on argv[1] (smoke/manual use)."""
    import asyncio
    import sys

    payload = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    job = Job(
        job_id=payload.get("job_id", "local"),
        thread_id=payload.get("thread_id", "local"),
        text=payload.get("text", ""),
        attachments=payload.get("attachments", []),
        context=payload.get("context", []),
        pin_hint=payload.get("pin_hint"),
    )
    result = asyncio.run(run_job(job))
    print(json.dumps(result.__dict__, indent=2))


if __name__ == "__main__":
    main()
