"""Tests for ``screenshot_board`` — real headless captures over a fixture board.

The fixture fakes the *built* site: a handwritten ``dist/index.html`` (served
with ``build=False``, so no npm) that mirrors the markup of the real board
(``src/pages/index.astro`` in the site repo): a square ``.cloth`` holding
clickable ``.board-pin`` divs keyed by ``data-pin-id``, and the
``.polaroid-overlay`` lightbox whose ``.polaroid-card`` zooms in on open and
gets its artwork injected at that moment. Solid marker colors make each layer
pixel-checkable: grey cloth, blue pins, red overlay backdrop, green card,
purple injected artwork.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from PIL import Image

from paratrooper.agent import memory, screenshot
from paratrooper.agent.config import Config
from paratrooper.agent.screenshot import ScreenshotError
from paratrooper.agent.tools import ToolContext

FIXTURE_HTML = """<!DOCTYPE html>
<html>
<head>
<style>
  body { margin: 0; }
  .cloth { position: relative; width: 600px; height: 600px; background: rgb(200,200,200); }
  .board-pin {
    position: absolute; width: 60px; height: 60px; background: rgb(0,0,255);
    transform: translate(-50%, -50%);
  }
  .polaroid-overlay {
    position: fixed; inset: 0; display: none; align-items: center;
    justify-content: center; background: rgb(255,0,0);
  }
  .polaroid-overlay.open { display: flex; }
  .polaroid-card { position: relative; width: 400px; height: 400px; background: rgb(0,255,0); }
  .polaroid-card.zooming-in { animation: polaroid-zoom-in 0.35s ease-out forwards; }
  @keyframes polaroid-zoom-in {
    from { transform: scale(0.5); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }
  .polaroid-content img { position: absolute; top: 20px; left: 20px; width: 40px; height: 40px; }
</style>
</head>
<body>
<div class="cloth">
  <div class="board-pin" data-pin-id="twen" style="left: 25%; top: 25%;"></div>
  <div class="board-pin" data-pin-id="desert-not-barren" style="left: 75%; top: 75%;"></div>
</div>
<div class="polaroid-overlay" id="polaroid-overlay">
  <div class="polaroid-card" id="polaroid-card">
    <div class="polaroid-content" id="polaroid-content"></div>
  </div>
</div>
<script>
  // mirrors the real openPolaroid: artwork injected on open, overlay shown,
  // card zoomed in, pin id mirrored onto the card
  document.querySelectorAll('.board-pin').forEach(pin => {
    pin.addEventListener('click', () => {
      const card = document.getElementById('polaroid-card');
      card.setAttribute('data-pin-id', pin.dataset.pinId);
      document.getElementById('polaroid-content').innerHTML =
        '<img src="opened.png" alt="" />';
      document.getElementById('polaroid-overlay').classList.add('open');
      card.classList.add('zooming-in');
    });
  });
</script>
</body>
</html>
"""


def _fixture_site(tmp_path: Path) -> Path:
    site = tmp_path / "site"
    dist = site / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text(FIXTURE_HTML)
    Image.new("RGB", (40, 40), (128, 0, 128)).save(dist / "opened.png")
    return site


def _shot(site: Path, out: Path, **kw) -> Image.Image:
    path = asyncio.run(screenshot.screenshot_board(site, out, build=False, **kw))
    return Image.open(path).convert("RGB")


def test_screenshot_without_pin_id_captures_cloth(tmp_path):
    """No pin_id -> today's behavior: the .cloth element shot, not the viewport."""
    img = _shot(_fixture_site(tmp_path), tmp_path / "board.png")
    assert img.size == (600, 600)
    assert img.getpixel((300, 300)) == (200, 200, 200)  # cloth, no overlay
    assert img.getpixel((150, 150)) == (0, 0, 255)  # the twen pin at 25%/25%


def test_screenshot_with_pin_id_captures_opened_view(tmp_path):
    """pin_id -> click the matching .board-pin and shoot the viewport once the
    lightbox card has finished zooming and its injected artwork has loaded."""
    img = _shot(_fixture_site(tmp_path), tmp_path / "open.png", pin_id="twen")
    assert img.size == screenshot.DEFAULT_VIEWPORT  # the overlay is full-viewport
    assert img.getpixel((10, 10)) == (255, 0, 0)  # overlay backdrop
    # pure green only at animation end (opacity ramps 0 -> 1): an early shot
    # would blend the card into the red backdrop
    assert img.getpixel((720, 720)) == (0, 255, 0)
    assert img.getpixel((555, 555)) == (128, 0, 128)  # injected artwork loaded


def test_screenshot_pin_id_match_is_normalized(tmp_path):
    """A humanized name resolves to its slug when the match is unambiguous."""
    img = _shot(_fixture_site(tmp_path), tmp_path / "open.png", pin_id="Desert Not Barren")
    assert img.getpixel((720, 720)) == (0, 255, 0)


def test_screenshot_unknown_pin_id_lists_available(tmp_path):
    """A miss must name the polaroids that do exist so the agent can retry."""
    with pytest.raises(ScreenshotError) as err:
        _shot(_fixture_site(tmp_path), tmp_path / "open.png", pin_id="nope")
    msg = str(err.value)
    assert "'nope'" in msg
    assert "twen" in msg and "desert-not-barren" in msg


# --- the tool wrapper (tools.py) ---------------------------------------------

def _tool_handlers(ctx) -> dict:
    """Build the tool server while capturing each handler by bare name (same
    trick as test_agent.py) so the wrapper can be called directly."""
    import paratrooper.agent.tools as tools_mod

    handlers = {}
    orig = tools_mod.create_sdk_mcp_server

    def capture(name, version, tools):
        for t in tools:
            handlers[t.name] = t.handler
        return orig(name=name, version=version, tools=tools)

    tools_mod.create_sdk_mcp_server = lambda name, version, tools: capture(name, version, tools)
    try:
        tools_mod.build_tool_server(ctx)
    finally:
        tools_mod.create_sdk_mcp_server = orig
    return handlers


def test_screenshot_tool_forwards_pin_id(tmp_path, monkeypatch):
    """The tool hands pin_id through to the capture; an absent or blank arg
    degrades to the plain board call (pin_id=None), keeping today's path."""
    calls = []

    async def fake_shot(site_root, out_path, *, pin_id=None):
        calls.append(pin_id)
        return Path(out_path)

    monkeypatch.setattr("paratrooper.agent.screenshot.screenshot_board", fake_shot)
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
    ctx = ToolContext(config=cfg, changelog=memory.Changelog(cfg.changelog))
    handlers = _tool_handlers(ctx)

    out = asyncio.run(handlers["screenshot_board"]({"pin_id": "twen"}))
    assert not out.get("is_error"), out
    asyncio.run(handlers["screenshot_board"]({}))
    asyncio.run(handlers["screenshot_board"]({"pin_id": "   "}))
    assert calls == ["twen", None, None]
    assert ctx.last_screenshot == str(cfg.site_root / "_paratrooper_board.png")
