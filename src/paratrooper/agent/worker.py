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
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
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

from . import images
from .auth import configure_auth
from .config import (
    Config,
    ConfigError,
    PinboardConfig,
    load_config,
    spotify_credentials,
    validate_branch_prefix,
)
from .github_app import installation_token
from .hooks import make_file_guard_hook, make_main_guard_hook
from .memory import Changelog, format_digest
from .prompt import build_system_prompt
from .siterepo import SiteRepo
from .tools import SERVER_NAME, ToolContext, build_plain_tool_server, build_tool_server

logger = logging.getLogger(__name__)

# headless built-ins the agent needs; Bash is gated by the main-guard hook and
# the three file tools by the file guard
BUILTIN_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
# The plain profile's whole base tool set, declared as `tools` so it REPLACES the
# CLI's default set rather than sitting beside it: web search and page reading,
# and that is all a plain session has. There is no shell to fence and no file
# tool to guard, so there are no hooks either.
PLAIN_TOOLS = ["WebSearch", "WebFetch"]
# Named refusals on top of the short base set. `tools` already leaves these out,
# so this is the second fence rather than the only one: the CLI refuses a name on
# this list before anything is asked of the session, whatever a settings file,
# a preset or a later SDK default might otherwise reintroduce.
PLAIN_DENIED_TOOLS = [
    "Bash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "Task",
]
# How many bytes of base64 image data one plain turn may carry, shared between
# its photos. This input policy is separate from the SDK's CLI-output buffer.
PLAIN_VISION_BASE64_BUDGET = 6 * 1024 * 1024
# the CLI's own refusal of the two secret-bearing roots, in its permission-rule
# syntax. The file guard denies the same two; this one does not depend on the
# hook being reached at all.
DENIED_READS = ["Read(//proc/**)", "Read(//etc/secrets/**)"]
# Claude Code's own switch for stripping provider credentials from the
# subprocesses it opens; carried by the bundled CLI from 2.1.83, which the
# pinned SDK version is checked against in the tests. Every session pins it to a
# value — see the comment on session_env in run_job for which value and why.
SCRUB_VAR = "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"
# What the permission gate says this session holds. Each profile names its own
# set: a plain session refused a tool used to be told it lacked "the pinboard
# tools", which is a sentence about a deployment it is not.
_PINBOARD_TOOLS = "the pinboard tools, the shell and the file tools"
_PLAIN_TOOLS_PHRASE = (
    "web search and page reading, and on this deployment nothing else: no shell, "
    "no file tools"
)

EventCallback = Callable[[dict], Awaitable[None] | None]


def make_tool_gate(session_tools: list[str], *, what_this_session_has: str = _PINBOARD_TOOLS):
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
                f"agent has {what_this_session_has}, and nothing else; there is "
                "no way to widen that from inside a turn."
            )
        )

    return gate


async def run_session(
    *, prompt: str | AsyncIterable[dict], options: ClaudeAgentOptions
):
    """Drive one turn and yield the messages it produces.

    A streaming client rather than ``query()``: the control stream carries the
    hook decisions, the in-process tool calls and the permission answers, and it
    has to stay open for as long as the turn is running (see the module
    docstring). ``receive_response()`` ends at the turn's result, and leaving the
    context closes stdin and the CLI with it.

    ``prompt`` is a string on pinboard and an async stream of user messages on
    plain. The string is the whole message; the stream is how an image block is
    attached at all, since single-message input does not take attachments. Both
    go to the same client call, which accepts either."""
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


def _build_plain_text(job: Job) -> str:
    """The plain turn's text block: the message and the recent thread, nothing else.

    No inbox key line. On pinboard a key is the only way the agent can reach a
    photo, through a tool that reads it; on plain the photo is already in the
    message as an image block, so a key would name a file the session cannot open
    and has no reason to know about."""
    parts = [job.text.strip()]
    if job.context:
        parts.append("\n[recent thread]\n" + "\n".join(job.context))
    return "\n".join(parts)


def _vision_images(job: Job, config: Config) -> list[images.VisionImage]:
    """Read this job's materialized photos into image data, within one budget.

    The worker has already copied each attachment out of the shared store into
    its own inbox, so these are local files. The per-photo ceiling is the shared
    budget divided by however many arrived. If an image cannot fit its share at
    usable dimensions, preparation fails before starting a model session."""
    if not job.attachments:
        return []
    inbox = config.require_inbox()
    share = PLAIN_VISION_BASE64_BUDGET // len(job.attachments)
    budget = min(images.VISION_MAX_BASE64, share)
    return [images.for_vision(inbox / key, max_base64=budget) for key in job.attachments]


def _plain_user_message(job: Job, vision: list[images.VisionImage]) -> dict:
    """One user message, images first and then the text.

    Images before text is the documented preference, and it is also the honest
    order: the text usually refers to the photo ("what is this?"), so the photo
    should already be in front of the model when the sentence arrives."""
    content: list[dict] = [image.block for image in vision]
    content.append({"type": "text", "text": _build_plain_text(job)})
    return {"type": "user", "message": {"role": "user", "content": content}}


async def _plain_stream(message: dict) -> AsyncIterator[dict]:
    """The streamed input for one plain turn: exactly one message.

    Streaming input is the only documented mode that accepts image attachments,
    which is the whole reason a plain turn is a stream rather than a string. A
    plain job is still one message and one reply."""
    yield message


async def _emit(cb: EventCallback | None, event: dict) -> None:
    if cb is None:
        return
    res = cb(event)
    if hasattr(res, "__await__"):
        await res


def session_env(config: Config) -> dict[str, str]:
    """The environment overrides one session's CLI runs with.

    Merged by the SDK over the worker's inherited environment, never replacing
    it: this adds and overrides, it cannot subtract. Keeping a secret out of the
    agent's shells is done by removing it from ``os.environ`` at boot (see
    ``config.take_github_app`` / ``take_spotify_credentials``), not here. Claude's
    own credential deliberately stays reachable, because the CLI needs it.

    ``CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`` is written explicitly either way rather
    than left unset, because unset means "whatever this host happened to be
    configured with" and this is the one place that question should be answered.
    With it on, the pinned CLI strips provider credentials from every Bash shell,
    hook and stdio MCP subprocess it opens — but on Linux it implements that by
    running each of those under bubblewrap, and the sandbox is then mandatory: a
    shell that cannot be sandboxed does not run. A probe of the running worker
    found its container policy refusing the mount the sandbox makes first
    (``mount(MS_SLAVE|MS_REC)`` on ``/``), so with the switch on every shell
    command answered that it failed to initialize and the agent reported having
    no shell at all. That is why ``shell_isolation`` defaults to false.

    When a deployer sets it true and the platform refuses, the failure surfaces:
    nothing here rewrites it back to "0". What it costs while off is real and is
    not nothing — the CLI still keeps the Claude credential out of an ordinary
    shell's own environment, but nothing sandboxes that shell, so the fences that
    remain are the tool gate, the allowed-tools list, the two denied read roots,
    the guard hooks, and a worker that hands the session no GitHub token.

    This switch is deployer configuration. No tool and no product control
    changes it from inside a turn — but it is an ordinary variable in the CLI's
    environment, so it is visible runtime data rather than something hidden.
    """
    return {
        SCRUB_VAR: "1" if config.shell_isolation else "0",
        "GIT_TERMINAL_PROMPT": "0",  # fail fast, never hang on a prompt
    }


def _refresh_checkout(pinboard: PinboardConfig, token: str) -> None:
    """Bring ``origin/*`` up to date before a turn starts.

    A failure warns and lets the turn run. This is a refresh of state the agent
    used to refresh for itself, and when its own ``git fetch`` failed the turn
    carried on; turning a network blip into a failed message would be a new way
    for every request to die, which is not what taking a credential away is
    supposed to cost. Anything that actually needs the remote — the push, the
    pull request — fails loudly on its own with the same cause."""
    try:
        SiteRepo(
            pinboard.site_root,
            default_branch=pinboard.default_branch,
            github_token=token,
            remote=pinboard.remote,
            git_name=pinboard.git_name,
            git_email=pinboard.git_email,
        ).fetch()
    except Exception as exc:
        logger.warning("could not refresh the site checkout before the turn: %s", exc)


async def run_job(
    job: Job,
    *,
    config: Config | None = None,
    auth_mode: str | None = None,
    on_event: EventCallback | None = None,
) -> JobResult:
    """Run one job end-to-end, on whichever profile this deployment is.

    Auth is locked in first (loud failure, no fallback). Returns a
    :class:`JobResult`; never raises for ordinary tool failures (those reach the
    agent), but a config/auth error propagates — by design it should crash the
    job visibly. The model is the configured one: there is no code default left
    to fall back to, so a deployment runs the model its source names.
    """
    configure_auth(auth_mode)  # subscription|api, hard-error if misconfigured
    # require_site_root is a pinboard question: the loader only asks for one when
    # the source has a pinboard block, so a plain deployment passes straight
    # through it rather than being asked for a checkout it has no repository for.
    config = config or load_config(require_site_root=True)
    if config.is_pinboard:
        return await _run_pinboard_job(job, config=config, on_event=on_event)
    return await _run_plain_job(job, config=config, on_event=on_event)


async def _run_pinboard_job(
    job: Job,
    *,
    config: Config,
    on_event: EventCallback | None = None,
) -> JobResult:
    """The full deployment's turn: site checkout, pin tools, guard hooks."""
    pinboard = config.require_pinboard()
    # one word fences the guard, names the branches the prompt asks for, and
    # filters the Publish PR lookup: check it here, before any git or agent work,
    # so a bad one is a loud failure and never a quiet fall back to the default
    validate_branch_prefix(pinboard.branch_prefix)

    async def emit(kind: str, payload: object) -> None:
        await _emit(on_event, {"job_id": job.job_id, "kind": kind, "payload": payload})

    changelog = Changelog(pinboard.changelog)

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
    # The isolation switch and the git prompt setting, written out explicitly —
    # see session_env for what each costs and why neither is left unset.
    env = session_env(config)

    # The agent used to run `git fetch` itself. It cannot now, so the worker
    # refreshes origin/* before the session: without this the agent branches off
    # whatever the default branch looked like at boot and never sees the branch
    # of a pull request it is meant to continue.
    if gh_token:
        await anyio.to_thread.run_sync(_refresh_checkout, pinboard, gh_token)

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
        pinboard.default_branch,
        repo_root=pinboard.site_root,
        branch_prefix=pinboard.branch_prefix,
        owner=pinboard.owner,
    )
    # the shell guard's twin for the tools that open files without a command
    # line: one Read of /proc/1/environ would hand over the whole environment
    file_guard = make_file_guard_hook()

    # the one list of what this session may run: it is declared to the CLI as
    # allow rules AND is the answer the permission gate gives, so there is a
    # single place that says what the agent has
    session_tools = tool_names + BUILTIN_TOOLS

    options = ClaudeAgentOptions(
        model=config.model,
        system_prompt=build_system_prompt(
            config, digest_text=format_digest(changelog.hot_digest())
        ),
        cwd=str(pinboard.site_root),
        # extra vars for the CLI subprocess (and so the agent's Bash shells);
        # merged over the inherited worker env by the SDK transport
        env=env,
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


async def _run_plain_job(
    job: Job,
    *,
    config: Config,
    on_event: EventCallback | None = None,
) -> JobResult:
    """The plain deployment's turn: a chat with photos, web search and page reading.

    What it declares, and why each line is there rather than left to a default:

    * ``tools`` is the base set, exactly the two web built-ins, so the shell and
      the file tools are not in the session's context at all;
    * ``disallowed_tools`` names them anyway, because a refusal the CLI applies
      before it asks is a fence that does not depend on this list being the only
      thing that shaped the set;
    * ``can_use_tool`` is still registered, from this session's own list: the CLI
      does not always keep the mode a session asked for, and a session that
      cannot answer a permission question is a broken session rather than a
      stricter one (see :func:`make_tool_gate`);
    * ``hooks`` is empty, because there is no shell to fence and no file tool to
      guard — there is nothing for a PreToolUse matcher to match;
    * ``cwd`` is this worker's own inbox scratch folder, never a repository,
      because a plain deployment has no checkout and the CLI still needs a
      working directory that exists;
    * ``env`` writes the isolation switch explicitly either way, exactly as the
      pinboard session does, from the same shared setting.

    Claude's own credential stays reachable for the CLI, deliberately. The GitHub
    App and the worker-only secrets are not in ``os.environ`` by the time any
    session exists (the boot took them out), and on plain the App was never read
    at all.
    """

    async def emit(kind: str, payload: object) -> None:
        await _emit(on_event, {"job_id": job.job_id, "kind": kind, "payload": payload})

    try:
        spotify_creds = spotify_credentials()
    except ConfigError:
        spotify_creds = None  # optional on both profiles, exactly as before

    inbox = config.require_inbox()
    # the CLI is started with this as its working directory, so it has to exist;
    # the folder is this worker's own scratch space and may be empty
    inbox.mkdir(parents=True, exist_ok=True)

    try:
        vision = await anyio.to_thread.run_sync(_vision_images, job, config)
    except images.VisionBudgetError:
        logger.warning("job %s photos exceed the image budget", job.job_id)
        message = (
            "Those photos are too large to send together. "
            "Please send fewer or smaller photos."
        )
        await emit("error", message)
        return JobResult(job.job_id, "error", error=message)
    except Exception:
        # A photo that cannot be read is the person's photo, so the failure is
        # theirs to hear about in their own words. The log keeps the real cause.
        logger.exception("job %s could not prepare its photos", job.job_id)
        message = (
            "I couldn't open that photo. Please send it again, or tell me what is in it."
        )
        await emit("error", message)
        return JobResult(job.job_id, "error", error=message)
    if vision:
        logger.info(
            "job %s carries %d photo(s), %d KiB of image data",
            job.job_id, len(vision), sum(len(v.data) for v in vision) // 1024,
        )

    server, tool_names = build_plain_tool_server(spotify_creds)
    # the one list of what this session may run, declared to the CLI AND used as
    # the permission gate's answer, same as pinboard
    session_tools = PLAIN_TOOLS + tool_names

    options = ClaudeAgentOptions(
        model=config.model,
        system_prompt=build_system_prompt(config, spotify=bool(tool_names)),
        cwd=str(inbox),
        env=session_env(config),
        mcp_servers={SERVER_NAME: server} if server is not None else {},
        tools=list(PLAIN_TOOLS),
        allowed_tools=session_tools,
        disallowed_tools=list(PLAIN_DENIED_TOOLS),
        permission_mode="dontAsk",
        can_use_tool=make_tool_gate(session_tools, what_this_session_has=_PLAIN_TOOLS_PHRASE),
        # no hooks: nothing this session can run opens a shell or a file
        max_buffer_size=10 * 1024 * 1024,
        include_partial_messages=True,
    )

    result_text = ""
    typing_announced = False
    try:
        stream = _plain_stream(_plain_user_message(job, vision))
        async for message in run_session(prompt=stream, options=options):
            if isinstance(message, StreamEvent):
                if not typing_announced and _is_text_delta(message.event):
                    typing_announced = True  # once per composition
                    await emit("typing", None)
            elif isinstance(message, AssistantMessage):
                typing_announced = False
            elif isinstance(message, ResultMessage):
                result_text = getattr(message, "result", "") or ""
                if message.is_error:
                    error = result_text or "I couldn't finish that reply. Please try again."
                    await emit("error", error)
                    return JobResult(job.job_id, "error", error=error)
    except Exception as exc:  # SDK/transport error -> visible job failure
        await emit("error", str(exc))
        return JobResult(job.job_id, "error", error=str(exc))

    await emit("done", result_text)  # the ONE reply bubble for this job
    return JobResult(job_id=job.job_id, status="done", result_text=result_text)


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
