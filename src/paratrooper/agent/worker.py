"""The worker entry point: run one pin-update job through the Agent SDK.

Ties Phase 3 together. Per request: lock in auth (subscription/api, no fallback),
build the in-process tool server + the custom system prompt (with the hot memory
digest) + the main-guard PreToolUse hook, then drive a headless ``query()``
session. The agent does its own git/gh through Bash (branch off origin/main or
continue an open PR's branch; the hook fences main/merges) and reports the PR
back via the report_pr tool. Progress (logs, screenshot, PR) is streamed to an
optional callback so the web service can relay it over the socket; the final
result + artifacts are returned.

One session per request, started fresh — matching the task-based session model.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    ResultMessage,
    StreamEvent,
    query,
)

from .auth import configure_auth
from .config import Config, ConfigError, github_token, load_config, spotify_credentials
from .hooks import make_main_guard_hook
from .memory import Changelog, format_digest
from .prompt import build_system_prompt
from .siterepo import write_askpass_helper
from .tools import SERVER_NAME, ToolContext, build_tool_server

DEFAULT_MODEL = "claude-opus-4-8"
# headless built-ins the agent needs; Bash is gated by the main-guard hook
BUILTIN_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]

EventCallback = Callable[[dict], Awaitable[None] | None]


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

    async def emit(kind: str, payload: object) -> None:
        await _emit(on_event, {"job_id": job.job_id, "kind": kind, "payload": payload})

    changelog = Changelog(config.changelog)

    try:
        spotify_creds = spotify_credentials()
    except ConfigError:
        spotify_creds = None  # Spotify name-search is optional; links still resolve

    # GitHub auth for the agent's shell: `gh` reads GH_TOKEN directly, and git
    # authenticates through the same askpass helper the clone bootstrap uses
    # (token rides only in env values — never argv, never the helper file).
    # Without a configured token (local dev) the session env stays empty and
    # the session runs exactly as before.
    try:
        gh_token = github_token()
    except ConfigError:
        gh_token = None
    session_env: dict[str, str] = {}
    if gh_token:
        session_env = {
            "GH_TOKEN": gh_token,
            "GIT_ASKPASS": write_askpass_helper(),
            "PARATROOPER_GIT_ASKPASS_TOKEN": gh_token,
            "GIT_TERMINAL_PROMPT": "0",  # fail fast, never hang on a prompt
        }

    async def emit_update(text: str) -> None:
        # the post_update tool's live channel: an agent-authored interim bubble
        await emit("update", text)

    # No branch/PR yet: the agent branches (or continues an open PR's branch)
    # in its own shell only when it actually changes the board, then records
    # the PR via report_pr — pure conversation never touches git.
    ctx = ToolContext(
        config=config,
        changelog=changelog,
        spotify_creds=spotify_creds,
        emit_update=emit_update,
    )
    server, tool_names = build_tool_server(ctx)
    # the guard fences the agent onto paratrooper/* branches; the site checkout
    # root lets it also enforce the local paratrooper-branch cap by counting there
    guard = make_main_guard_hook(config.default_branch, repo_root=config.site_root)

    options = ClaudeAgentOptions(
        model=model,
        system_prompt=build_system_prompt(format_digest(changelog.hot_digest())),
        cwd=str(config.site_root),
        # extra vars for the CLI subprocess (and so the agent's Bash shells);
        # merged over the inherited worker env by the SDK transport
        env=session_env,
        mcp_servers={SERVER_NAME: server},
        allowed_tools=tool_names + BUILTIN_TOOLS,
        # headless least-privilege: listed tools run, unlisted are denied without
        # prompting; the main-guard hook denies dangerous Bash (deny beats this mode)
        permission_mode="dontAsk",
        hooks={"PreToolUse": [HookMatcher(matcher="Bash", hooks=[guard])]},
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
        async for message in query(prompt=_build_prompt(job), options=options):
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
