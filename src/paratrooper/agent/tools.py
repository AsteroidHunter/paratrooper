"""The agent's custom in-process tools (checklist 3.1).

Each tool is a thin async ``@tool`` wrapper around the SDK-independent core
modules, bundled into one in-process MCP server via ``create_sdk_mcp_server``.
The wrappers close over a :class:`ToolContext` (config + repo + changelog +
the request's feature branch) so the handlers stay arg-only as the SDK expects.
Synchronous core work is offloaded to a thread so the event loop isn't blocked;
tools return ``{"content": [...], "is_error"?: bool}``.

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
from .siterepo import SiteRepo

SERVER_NAME = "paratrooper"


@dataclass
class ToolContext:
    config: Config
    repo: SiteRepo
    changelog: Changelog
    branch: str  # the feature branch this request works on (set by the worker)
    spotify_creds: tuple[str, str] | None = None
    now: Any = None  # callable -> ISO timestamp; injectable for tests
    # artifacts captured as the tools run, so the worker can relay them to the
    # thread (screenshot, PR url) without parsing SDK message internals
    last_pr: str | None = None
    last_screenshot: str | None = None


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

    @tool("process_image", "Optimize a staged upload into a pin's preview.webp (or "
          "opened.webp). Args: inbox_key, pin_id, optional opened(bool).",
          {"inbox_key": str, "pin_id": str, "opened": bool})
    async def process_image_tool(args: dict) -> dict:
        def _run() -> dict:
            src = ctx.config.inbox / args["inbox_key"]
            asset = OPENED_ASSET if args.get("opened") else PREVIEW_ASSET
            dest = pins.pin_folder(ctx.config.pins_dir, args["pin_id"]) / asset
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

    @tool("archive_pin", "Archive a pin (move its folder out of the board). Args: pin_id.",
          {"pin_id": str})
    async def archive_pin_tool(args: dict) -> dict:
        def _run() -> dict:
            dst = pins.archive_pin(ctx.config.pins_dir, ctx.config.archive_dir, args["pin_id"])
            return {"archived": args["pin_id"], "to": str(dst)}

        try:
            return _ok(await anyio.to_thread.run_sync(_run))
        except Exception as exc:
            return _err(f"archive_pin failed: {exc}")

    @tool("git_commit", "Stage the worktree and commit. Args: message.", {"message": str})
    async def git_commit_tool(args: dict) -> dict:
        try:
            sha = await anyio.to_thread.run_sync(ctx.repo.commit_all, args["message"])
            return _ok({"sha": sha})
        except Exception as exc:
            return _err(f"git_commit failed: {exc}")

    @tool("git_push", "Push the current feature branch to origin (never main). No args.", {})
    async def git_push_tool(args: dict) -> dict:
        try:
            await anyio.to_thread.run_sync(ctx.repo.push_branch, ctx.branch)
            return _ok({"pushed": ctx.branch})
        except Exception as exc:
            return _err(f"git_push failed: {exc}")

    @tool("open_pr", "Open a PR from the feature branch into the default branch. "
          "Args: title, optional body.", {"title": str, "body": str})
    async def open_pr_tool(args: dict) -> dict:
        try:
            url = await anyio.to_thread.run_sync(
                ctx.repo.open_pr, ctx.branch, args["title"], args.get("body", "")
            )
            ctx.last_pr = url
            return _ok({"pr": url})
        except Exception as exc:
            return _err(f"open_pr failed: {exc}")

    @tool("screenshot_board", "Build the site and screenshot the board (.cloth). Returns a "
          "PNG path. No args.", {})
    async def screenshot_board_tool(args: dict) -> dict:
        try:
            out = ctx.config.site_root / "_paratrooper_board.png"
            path = await screenshot.screenshot_board(ctx.config.site_root, out)
            ctx.last_screenshot = str(path)
            return _ok({"screenshot": str(path)})
        except Exception as exc:
            return _err(f"screenshot_board failed: {exc}")

    @tool("fetch_history", "Read older changelog entries. Args: optional n, optional "
          "start, optional end.", {"n": int, "start": int, "end": int})
    async def fetch_history_tool(args: dict) -> dict:
        entries = ctx.changelog.fetch_history(
            n=args.get("n"), start=args.get("start"), end=args.get("end")
        )
        return _ok({"entries": entries})

    @tool("append_changelog", "Record one update in the changelog (rides the PR branch). "
          "Args: pin_id, action, summary, optional pr.",
          {"pin_id": str, "action": str, "summary": str, "pr": str})
    async def append_changelog_tool(args: dict) -> dict:
        ts = ctx.now() if callable(ctx.now) else _utc_now()
        entry = ChangelogEntry(
            ts=ts,
            pin_id=args["pin_id"],
            action=args["action"],
            summary=args["summary"],
            pr=args.get("pr"),
            branch=ctx.branch,
        )
        written = ctx.changelog.append(entry)
        return _ok({"recorded": written})

    handlers = [
        place_pin_tool,
        check_overlaps_tool,
        process_image_tool,
        resolve_spotify_tool,
        archive_pin_tool,
        git_commit_tool,
        git_push_tool,
        open_pr_tool,
        screenshot_board_tool,
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
