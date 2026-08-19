"""The agent's custom in-process tools (checklist 3.1).

Each tool is a thin async ``@tool`` wrapper around the SDK-independent core
modules, bundled into one in-process MCP server via ``create_sdk_mcp_server``.
The wrappers close over a :class:`ToolContext` (config + changelog + artifacts)
so the handlers stay arg-only as the SDK expects. Git lives elsewhere: the agent
runs git/gh through its own Bash (fenced by the main-guard hook) and reports the
resulting PR back through ``report_pr``. Synchronous core work is offloaded to a
thread so the event loop isn't blocked; tools return
``{"content": [...], "is_error"?: bool}``.

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
from . import images, pins, screenshot, spotify
from .config import OPENED_ASSET, PREVIEW_ASSET, Config
from .memory import Changelog, ChangelogEntry

SERVER_NAME = "paratrooper"


@dataclass
class ToolContext:
    config: Config
    changelog: Changelog
    # The PR's head branch as reported by the report_pr tool — bookkeeping for
    # the worker's "pr" event and JobResult, not a gate. The agent branches in
    # its own shell; a purely conversational message never touches git.
    branch: str | None = None
    spotify_creds: tuple[str, str] | None = None
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

    @tool("report_pr", "Report the PR for this update so the app can show its link and "
          "Publish button. Call it after opening a new PR, AND after pushing more "
          "commits to an already-open one. Args: url (the PR link), branch (the PR's "
          "head branch).", {"url": str, "branch": str})
    async def report_pr_tool(args: dict) -> dict:
        url = str(args.get("url", "")).strip()
        branch = str(args.get("branch", "")).strip()
        if not url or not branch:
            return _err("report_pr needs both url and branch")
        ctx.last_pr = url
        ctx.branch = branch
        return _ok({"recorded": {"pr": url, "branch": branch}})

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
        report_pr_tool,
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
