"""The agent's custom in-process tools (checklist 3.1, extended at 2.1).

Each tool is a thin async ``@tool`` wrapper around the SDK-independent core
modules, bundled into one in-process MCP server via ``create_sdk_mcp_server``.
The wrappers close over a :class:`ToolContext` (config + changelog + credential
+ artifacts) so the handlers stay arg-only as the SDK expects. Synchronous core
work is offloaded to a thread so the event loop isn't blocked; tools return
``{"content": [...], "is_error"?: bool}``.

**The GitHub handoff.** Local git (branch, add, commit) stays in the agent's own
Bash, fenced by the main-guard hook. Everything that reaches GitHub —
``push_branch``, ``open_pull_request``, ``list_pull_requests`` — is a tool here
instead, run by the worker with a credential the agent never sees and cannot
read out of its environment, because it is not in it. That is the whole point of
the three: with no token in the session, the agent has nothing to authenticate
with, so these are not a convenience over ``gh``, they are the only road.
``report_pr`` is gone; ``open_pull_request`` records the pull request itself, so
the Publish button no longer depends on the agent remembering a second call.

Tool names the agent sees are ``mcp__paratrooper__<name>`` — :func:`build_tool_server`
returns both the server and the matching ``allowed_tools`` list.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC
from typing import Any

import anyio
from claude_agent_sdk import create_sdk_mcp_server, tool

from ..placement import NewItem, check_overlaps, place_pin, sanity_check
from . import github, images, pins, screenshot, spotify
from .config import OPENED_ASSET, PREVIEW_ASSET, Config
from .hooks import base_denial, normalize_prefix, push_denial
from .memory import Changelog, ChangelogEntry
from .siterepo import SiteRepo

SERVER_NAME = "paratrooper"

# what a tool says when it is asked to reach GitHub on a run that has no
# credential (local CLI use). Not a fallback: there is no second road to try.
NO_CREDENTIAL = (
    "this worker has no GitHub credential configured, so nothing can be pushed "
    "or opened from here"
)


@dataclass
class ToolContext:
    config: Config
    changelog: Changelog
    # The head branch of the work in flight, set by push_branch and
    # open_pull_request — bookkeeping for the worker's "pr" event and JobResult,
    # not a gate. The agent branches in its own shell; a purely conversational
    # message never touches git.
    branch: str | None = None
    spotify_creds: tuple[str, str] | None = None
    # the GitHub credential the worker holds. It reaches the three handoff tools
    # and nothing else — never ClaudeAgentOptions.env, never a shell.
    github_token: str | None = None
    now: Any = None  # callable -> ISO timestamp; injectable for tests
    # artifacts captured as the tools run, so the worker can relay them to the
    # thread (screenshot, PR url) without parsing SDK message internals
    last_pr: str | None = None
    last_screenshot: str | None = None
    # live channel to the phone: async callable(text) publishing an 'update'
    # result mid-job. None on offline/CLI runs — post_update degrades to a no-op.
    emit_update: Any = None


def _ok(payload: dict) -> dict:
    return {"content": [{"type": "text", "text": json.dumps(payload)}]}


def _err(message: str) -> dict:
    return {"content": [{"type": "text", "text": message}], "is_error": True}


def _site_repo(ctx: ToolContext) -> SiteRepo:
    """The worker's own git handle on the checkout, carrying the credential."""
    return SiteRepo(
        ctx.config.site_root,
        default_branch=ctx.config.default_branch,
        github_token=ctx.github_token,
        remote=ctx.config.remote,
        git_name=ctx.config.git_name,
        git_email=ctx.config.git_email,
    )


def _agent_branch_violation(ctx: ToolContext, branch: str) -> str | None:
    """The branch fence, in the guard's own wording, checked where the
    credential actually is. The shell hook says the same thing about a
    ``git push``; this is the copy that matters, because this is the one with a
    token behind it."""
    prefix = normalize_prefix(ctx.config.branch_prefix)
    if not branch:
        return "name the branch to push, e.g. " + f"{prefix}<slug>"
    if not branch.startswith(prefix) or len(branch) == len(prefix):
        return push_denial(branch, prefix)
    return None


def build_tool_server(ctx: ToolContext):
    """Construct the in-process MCP server + the ``allowed_tools`` names."""

    @tool("place_pin", "Compute non-overlapping {position,size} for a pin. Args: pin_id, "
          "aspect (asset width/height), optional rotation, optional sample(bool).",
          {"pin_id": str, "aspect": float, "rotation": float, "sample": bool})
    async def place_pin_tool(args: dict) -> dict:
        pin_id = args["pin_id"]
        aspect = float(args["aspect"])
        rotation = float(args.get("rotation", 0.0))

        def _run() -> dict:
            board = pins.load_board(ctx.config.pins_dir, exclude=pin_id)
            sil = None
            preview = pins.preview_path(ctx.config.pins_dir, pin_id)
            # a frameless cutout placing itself uses exact-silhouette feasibility
            data = None
            try:
                data = pins.read_pin(ctx.config.pins_dir, pin_id)
            except pins.PinError:
                data = None
            if data and data.get("frameless") and preview.is_file():
                from ..placement import load_silhouette

                sil = load_silhouette(preview)
            item = NewItem(aspect=aspect, rotation=rotation, silhouette=sil)
            result = place_pin(board, item, sample=bool(args.get("sample", False)))
            check = sanity_check(result, board, item)
            return {**result.as_pin_fields(), "score": round(result.score, 4), "valid": check.ok}

        try:
            return _ok(await anyio.to_thread.run_sync(_run))
        except Exception as exc:  # surface "doesn't fit" etc. to the agent
            return _err(f"place_pin failed: {exc}")

    @tool("check_overlaps", "Validate the whole board: no overlaps (alpha-aware), all in "
          "bounds. No args.", {})
    async def check_overlaps_tool(args: dict) -> dict:
        def _run() -> dict:
            report = check_overlaps(pins.load_board(ctx.config.pins_dir))
            return {
                "ok": report.ok,
                "overlaps": report.overlaps,
                "out_of_bounds": report.out_of_bounds,
                "message": report.message(),
            }

        return _ok(await anyio.to_thread.run_sync(_run))

    def _stage_dir(stage: str):
        dirs = {
            "on-display": ctx.config.pins_dir,
            "off-display": ctx.config.archive_dir,
            "for-later": ctx.config.later_dir,
        }
        if stage not in dirs:
            raise ValueError(f"unknown stage {stage!r} (use on-display|off-display|for-later)")
        return dirs[stage]

    @tool("process_image", "Optimize a staged upload into a pin's preview.webp (or "
          "opened.webp). Args: inbox_key, pin_id, optional opened(bool), optional "
          "stage ('on-display' default | 'for-later').",
          {"inbox_key": str, "pin_id": str, "opened": bool, "stage": str})
    async def process_image_tool(args: dict) -> dict:
        def _run() -> dict:
            src = ctx.config.inbox / args["inbox_key"]
            asset = OPENED_ASSET if args.get("opened") else PREVIEW_ASSET
            stage_dir = _stage_dir(args.get("stage", "on-display"))
            dest = pins.pin_folder(stage_dir, args["pin_id"]) / asset
            res = images.process_image(src, dest)
            return {
                "asset": asset,
                "aspect": res.aspect,
                "width": res.width,
                "height": res.height,
                "has_alpha": res.has_alpha,
            }

        try:
            return _ok(await anyio.to_thread.run_sync(_run))
        except Exception as exc:
            return _err(f"process_image failed: {exc}")

    @tool("resolve_spotify", "Resolve a Spotify track link or song name to an embed URL. "
          "Args: query, optional is_link(bool).", {"query": str, "is_link": bool})
    async def resolve_spotify_tool(args: dict) -> dict:
        query = args["query"]
        is_link = bool(args.get("is_link", "open.spotify.com" in query))

        def _run() -> dict:
            if is_link:
                r = spotify.resolve_link(query)
            else:
                if not ctx.spotify_creds:
                    raise RuntimeError("Spotify credentials not configured for name search")
                r = spotify.resolve_name(query, *ctx.spotify_creds)
            return {"embed": r.embed, "track_id": r.track_id, "title": r.title, "artist": r.artist}

        try:
            return _ok(await anyio.to_thread.run_sync(_run))
        except Exception as exc:
            return _err(f"resolve_spotify failed: {exc}")

    @tool("move_pin", "Move a pin folder between stages. Archive = to='off-display'; "
          "publish a staged pin = to='on-display' (then place_pin + update its JSON). "
          "Args: pin_id, to ('on-display'|'off-display'|'for-later'). Source is "
          "auto-detected.", {"pin_id": str, "to": str})
    async def move_pin_tool(args: dict) -> dict:
        def _run() -> dict:
            pin_id, to = args["pin_id"], args["to"]
            dst_dir = _stage_dir(to)
            src_dir = next(
                (d for s, d in (
                    ("on-display", ctx.config.pins_dir),
                    ("off-display", ctx.config.archive_dir),
                    ("for-later", ctx.config.later_dir),
                ) if d != dst_dir and pins.pin_folder(d, pin_id).is_dir()),
                None,
            )
            if src_dir is None:
                raise pins.PinError(f"pin '{pin_id}' not found in any other stage")
            dst = pins.move_pin(src_dir, dst_dir, pin_id)
            return {"moved": pin_id, "to": to, "path": str(dst)}

        try:
            return _ok(await anyio.to_thread.run_sync(_run))
        except Exception as exc:
            return _err(f"move_pin failed: {exc}")

    @tool("push_branch", "Push the branch you committed on to GitHub. Your shell cannot "
          "reach GitHub at all, so this is the only way a commit leaves this machine. "
          "Args: branch (the branch you are on).", {"branch": str})
    async def push_branch_tool(args: dict) -> dict:
        branch = str(args.get("branch", "")).strip()
        violation = _agent_branch_violation(ctx, branch)
        if violation:
            return _err(violation)
        if not ctx.github_token:
            return _err(NO_CREDENTIAL)

        def _run() -> dict:
            repo = _site_repo(ctx)
            owner, name = github.owner_repo(repo.configured_remote())
            repo.push_branch(branch)
            return {"pushed": branch, "url": github.branch_url(owner, name, branch)}

        try:
            payload = await anyio.to_thread.run_sync(_run)
        except Exception as exc:
            return _err(f"push_branch failed: {exc}")
        ctx.branch = branch
        return _ok(payload)

    @tool("open_pull_request", "Open the pull request for a branch you pushed, so Akash "
          "gets his Publish button. Call it every time you push, including on a branch "
          "that already has one: it hands back the open pull request instead of making "
          "a second. Args: branch, title, body.",
          {"branch": str, "title": str, "body": str})
    async def open_pull_request_tool(args: dict) -> dict:
        branch = str(args.get("branch", "")).strip()
        violation = _agent_branch_violation(ctx, branch)
        if violation:
            return _err(violation)
        # the base is the site's default branch, always. It is read out of the
        # arguments only so that a request naming a different one is refused
        # rather than quietly retargeted.
        base = str(args.get("base") or ctx.config.default_branch).strip()
        if base != ctx.config.default_branch:
            return _err(base_denial(base, ctx.config.default_branch))
        title = str(args.get("title", "")).strip()
        if not title:
            return _err("open_pull_request needs a title")
        body = str(args.get("body", "")).strip()
        if not ctx.github_token:
            return _err(NO_CREDENTIAL)

        def _run() -> dict:
            repo = _site_repo(ctx)
            owner, name = github.owner_repo(repo.configured_remote())
            existing = github.find_open_pull_request(
                owner, name, branch=branch, token=ctx.github_token
            )
            if existing is not None:
                return {**existing, "existing": True}
            opened = github.create_pull_request(
                owner, name, branch=branch, base=base, title=title, body=body,
                token=ctx.github_token,
            )
            return {**opened, "existing": False}

        try:
            entry = await anyio.to_thread.run_sync(_run)
        except Exception as exc:
            return _err(f"open_pull_request failed: {exc}")
        # what the app's PR bubble and Publish button are built from. Recorded
        # here rather than by a separate call the agent has to remember.
        ctx.last_pr = entry["url"]
        ctx.branch = branch
        return _ok(entry)

    @tool("list_pull_requests", "The open pull requests Paratrooper has waiting. Check "
          "this FIRST on any board change: an open one means unpublished work to "
          "continue on its branch rather than start again. No args.", {})
    async def list_pull_requests_tool(args: dict) -> dict:
        if not ctx.github_token:
            return _err(NO_CREDENTIAL)

        def _run() -> dict:
            repo = _site_repo(ctx)
            owner, name = github.owner_repo(repo.configured_remote())
            return {
                "pull_requests": github.open_pull_requests(
                    owner, name, token=ctx.github_token,
                    branch_prefix=normalize_prefix(ctx.config.branch_prefix),
                )
            }

        try:
            return _ok(await anyio.to_thread.run_sync(_run))
        except Exception as exc:
            return _err(f"list_pull_requests failed: {exc}")

    @tool("screenshot_board", "Build the site and screenshot the board (.cloth). Optional "
          "pin_id: click that polaroid open and capture the opened view instead. Returns "
          "a PNG path.", {"pin_id": str})
    async def screenshot_board_tool(args: dict) -> dict:
        try:
            pin_id = str(args.get("pin_id") or "").strip() or None
            out = ctx.config.site_root / "_paratrooper_board.png"
            path = await screenshot.screenshot_board(ctx.config.site_root, out, pin_id=pin_id)
            ctx.last_screenshot = str(path)
            return _ok({"screenshot": str(path)})
        except Exception as exc:
            return _err(f"screenshot_board failed: {exc}")

    @tool("post_update", "Text Akash ONE short interim message right now, while the job "
          "is still running (your final reply is separate and stays the single closing "
          "message). Only for: a brief ack before starting a multi-step board change, or "
          "a heads-up when something failed or is taking longer. Args: text.",
          {"text": str})
    async def post_update_tool(args: dict) -> dict:
        text = str(args.get("text", "")).strip()
        if not text:
            return _err("post_update needs non-empty text")
        if ctx.emit_update is None:
            return _ok({"sent": False, "note": "no live channel on this run"})
        try:
            await ctx.emit_update(text)
            return _ok({"sent": True})
        except Exception as exc:
            return _err(f"post_update failed: {exc}")

    @tool("fetch_history", "Read older changelog entries. Args: optional n, optional "
          "start, optional end.", {"n": int, "start": int, "end": int})
    async def fetch_history_tool(args: dict) -> dict:
        entries = ctx.changelog.fetch_history(
            n=args.get("n"), start=args.get("start"), end=args.get("end")
        )
        return _ok({"entries": entries})

    @tool("append_changelog", "Record one update in the changelog (rides the PR branch). "
          "Args: pin_id, action, summary, optional pr, optional branch (the branch "
          "you're committing on).",
          {"pin_id": str, "action": str, "summary": str, "pr": str, "branch": str})
    async def append_changelog_tool(args: dict) -> dict:
        ts = ctx.now() if callable(ctx.now) else _utc_now()
        entry = ChangelogEntry(
            ts=ts,
            pin_id=args["pin_id"],
            action=args["action"],
            summary=args["summary"],
            pr=args.get("pr"),
            branch=args.get("branch"),
        )
        written = ctx.changelog.append(entry)
        return _ok({"recorded": written})

    handlers = [
        place_pin_tool,
        check_overlaps_tool,
        process_image_tool,
        resolve_spotify_tool,
        move_pin_tool,
        push_branch_tool,
        open_pull_request_tool,
        list_pull_requests_tool,
        screenshot_board_tool,
        post_update_tool,
        fetch_history_tool,
        append_changelog_tool,
    ]
    server = create_sdk_mcp_server(name=SERVER_NAME, version="0.1.0", tools=handlers)
    # SDK convention: a tool registered on server "paratrooper" is "mcp__paratrooper__<name>"
    names = [f"mcp__{SERVER_NAME}__{h.name}" for h in handlers]
    return server, names


def _utc_now() -> str:
    from datetime import datetime

    return datetime.now(UTC).isoformat()
