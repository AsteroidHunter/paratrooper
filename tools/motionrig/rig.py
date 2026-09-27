#!/usr/bin/env python3
"""Drive the phone app through its motions and measure every frame of them.

The rig builds the app, starts its own copy of the web service over a seeded
thread (server.py, on 127.0.0.1 only), and plays the owner's day on an emulated
iPhone in headless Chromium: an iPhone 15 Pro screen (393x852 at 3x), touch
input, an iOS user agent, the installed-app flag, a keyboard that shrinks the
visual viewport the way iOS does, and the main thread slowed four times.

Every flow is measured three ways at once:

* the frames, from an in-page requestAnimationFrame recorder (probe.js): every
  gap between two frames over 16.7 ms is a frame the owner would have seen
  late, and the longest one is the worst hitch;
* the compositor's own verdict on each frame (the PipelineReporter events in a
  DevTools trace): presented, partially presented, or dropped;
* the main thread's work, from the same trace: long tasks (over 50 ms), style
  recalculations, layouts, and which of those layouts JavaScript forced
  synchronously, with the function that forced them (mapped back through the
  source map to pwa/src).

A second pass (--attribute) wraps the layout-reading APIs in the page and
records the stack of every call slow enough to have forced a layout, and takes
a V8 CPU profile of each flow. Both skew timings a little, so that pass's
numbers are for naming culprits, not for scoring.

Screenshots of the key moments of each flow go in the output folder when
--shots is given (small JPEGs at CSS size, so a whole set is a few hundred kB).

    .venv/bin/python tools/motionrig/rig.py --runs 3 --label before --out /tmp/rig
    .venv/bin/python tools/motionrig/rig.py compare /tmp/rig/before.json /tmp/rig/after.json

The CPU slowdown is applied to the renderer's main thread only (that is what
Chrome's throttling does), and headless Chrome ticks frames on a 60 Hz timer
rather than a display, so the numbers are a stress test to compare builds
against each other, not a prediction of what an iPhone will show.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import gzip
import json
import re
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PWA = REPO / "pwa"
DIST = PWA / "dist"

VIEW = {"width": 393, "height": 852}
DPR = 3
# the iPhone 15 Pro's portrait keyboard with its suggestion bar, in CSS px
KEYBOARD = 336
UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
)
TOKEN = "motionrig-token"
FRAME_MS = 1000 / 60
# a gap between two frames longer than this missed at least one vsync
SLOW_FRAME_MS = 17.5
LONG_TASK_MS = 50.0

CATEGORIES = [
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "disabled-by-default-devtools.timeline.stack",
    "v8.execute",
    "blink.user_timing",
    "toplevel",
]
# events that are JavaScript running: a layout or style pass nested inside
# one of these was forced synchronously by that script
JS_EVENTS = {
    "FunctionCall",
    "EvaluateScript",
    "v8.run",
    "v8.callFunction",
    "v8.evaluateModule",
    "TimerFire",
    "FireAnimationFrame",
    "RunMicrotasks",
    "FireIdleCallback",
}
DECODE_EVENTS = {"Decode Image", "ImageDecodeTask", "Decode LazyPixelRef"}


# --- source map: bundle positions back to pwa/src ------------------------------

_B64 = {
    c: i for i, c in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
}


class SourceMap:
    """Just enough of a source map reader to name a line of pwa/src."""

    def __init__(self, bundle: Path) -> None:
        self.bundle_name = bundle.name
        self.text = bundle.read_text("utf-8")
        data = json.loads(Path(str(bundle) + ".map").read_text("utf-8"))
        self.sources = [re.sub(r"^(\.\./)+", "", s) for s in data["sources"]]
        self.lines: list[list[tuple[int, int, int]]] = []
        src = line = col = 0
        for row in data["mappings"].split(";"):
            segs: list[tuple[int, int, int]] = []
            gen = 0
            for seg in row.split(","):
                if not seg:
                    continue
                vals = self._vlq(seg)
                gen += vals[0]
                if len(vals) >= 4:
                    src += vals[1]
                    line += vals[2]
                    col += vals[3]
                    segs.append((gen, src, line))
            self.lines.append(segs)
        self.line_starts = [0]
        for m in re.finditer("\n", self.text):
            self.line_starts.append(m.end())

    @staticmethod
    def _vlq(seg: str) -> list[int]:
        out, shift, value = [], 0, 0
        for ch in seg:
            digit = _B64[ch]
            value += (digit & 31) << shift
            if digit & 32:
                shift += 5
            else:
                out.append(-(value >> 1) if value & 1 else value >> 1)
                shift = value = 0
        return out

    def where(self, line0: int, col0: int) -> str | None:
        """0-based bundle line/column -> 'src/file.ts:line' (1-based)."""
        if not 0 <= line0 < len(self.lines):
            return None
        best = None
        for gen, src, line in self.lines[line0]:
            if gen > col0:
                break
            best = (src, line)
        if best is None:
            return None
        return f"{self.sources[best[0]].replace('pwa/', '')}:{best[1] + 1}"

    def where_char(self, pos: int) -> str | None:
        """a character offset into the bundle (LoAF's sourceCharPosition)"""
        import bisect

        if pos is None or pos < 0:
            return None
        i = bisect.bisect_right(self.line_starts, pos) - 1
        return self.where(i, pos - self.line_starts[i])

    def frame(self, text: str) -> str | None:
        """one line of an Error().stack -> 'fn @ src/file.ts:line'"""
        m = re.search(r"at (?:(.+?) \()?(\S+?):(\d+):(\d+)\)?$", text)
        if not m or self.bundle_name not in m.group(2):
            return None
        where = self.where(int(m.group(3)) - 1, int(m.group(4)) - 1)
        return f"{m.group(1) or '(anonymous)'} @ {where}"


# --- trace analysis -------------------------------------------------------------


def _pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def analyze_trace(events: list[dict], smap: SourceMap | None) -> dict[str, Any]:
    marks = [
        e
        for e in events
        if e.get("name") in ("rig-start", "rig-end") and "blink.user_timing" in e.get("cat", "")
    ]
    starts = [e for e in marks if e["name"] == "rig-start"]
    if not starts:
        return {"error": "no rig-start mark in the trace"}
    start = starts[-1]
    ends = [e for e in marks if e["name"] == "rig-end" and e["ts"] >= start["ts"]]
    pid, tid = start["pid"], start["tid"]
    t0 = start["ts"]
    t1 = ends[0]["ts"] if ends else max(e.get("ts", 0) for e in events)

    main = sorted(
        (
            e
            for e in events
            if e.get("pid") == pid
            and e.get("tid") == tid
            and e.get("ph") == "X"
            and t0 <= e.get("ts", 0) <= t1
        ),
        key=lambda e: (e["ts"], -e.get("dur", 0)),
    )

    def js_site(e: dict) -> str:
        data = (e.get("args") or {}).get("data") or {}
        fn = data.get("functionName") or e["name"]
        url = data.get("url") or ""
        line, col = data.get("lineNumber"), data.get("columnNumber")
        where = None
        if smap and smap.bundle_name in url and line is not None:
            # trace lines/columns are 1-based for FunctionCall
            where = smap.where(int(line) - 1, int(col or 1) - 1)
        return f"{fn or '(anonymous)'} @ {where or url.rsplit('/', 1)[-1] or '?'}"

    def stack_site(e: dict) -> str | None:
        stack = ((e.get("args") or {}).get("beginData") or {}).get("stackTrace") or []
        for f in stack:
            url = f.get("url") or ""
            if smap and smap.bundle_name in url:
                where = smap.where(
                    int(f.get("lineNumber", 1)) - 1, int(f.get("columnNumber", 1)) - 1
                )
                return f"{f.get('functionName') or '(anonymous)'} @ {where}"
        return None

    layouts: list[dict] = []
    styles: list[dict] = []
    tasks: list[dict] = []
    decode_main = 0.0
    paint = 0.0
    stack: list[dict] = []
    for e in main:
        while stack and stack[-1]["ts"] + stack[-1].get("dur", 0) <= e["ts"]:
            stack.pop()
        name = e["name"]
        if name == "RunTask" and "devtools.timeline" in e.get("cat", ""):
            tasks.append(e)
        elif name in ("Layout", "UpdateLayoutTree"):
            js = [s for s in stack if s["name"] in JS_EVENTS]
            entry = {
                "dur": e.get("dur", 0) / 1000,
                "forced": bool(js),
                "site": (stack_site(e) or js_site(js[-1])) if js else None,
            }
            (layouts if name == "Layout" else styles).append(entry)
        elif name in DECODE_EVENTS:
            decode_main += e.get("dur", 0) / 1000
        elif name == "Paint":
            paint += e.get("dur", 0) / 1000
        stack.append(e)

    def children(task: dict) -> list[str]:
        end = task["ts"] + task.get("dur", 0)
        kids: dict[str, float] = {}
        for e in main:
            if e["ts"] < task["ts"] or e["ts"] >= end or e is task:
                continue
            if e["name"] in ("FunctionCall", "EvaluateScript"):
                key = js_site(e)
            elif e["name"] in {"Layout", "UpdateLayoutTree", "Paint", "ParseHTML"} | DECODE_EVENTS:
                key = e["name"]
            else:
                continue
            kids[key] = kids.get(key, 0) + e.get("dur", 0) / 1000
        top = sorted(kids.items(), key=lambda kv: -kv[1])[:3]
        return [f"{k} {v:.0f}ms" for k, v in top]

    long_tasks = [t for t in tasks if t.get("dur", 0) / 1000 > LONG_TASK_MS]
    long_tasks.sort(key=lambda t: -t["dur"])

    # the compositor's verdict per frame (the key moved in 2025, read both)
    states: dict[str, int] = {}
    for e in events:
        if e.get("name") != "PipelineReporter" or e.get("ph") != "b" or e.get("pid") != pid:
            continue
        if not t0 <= e.get("ts", 0) <= t1:
            continue
        args = e.get("args") or {}
        rep = args.get("frame_reporter") or args.get("chrome_frame_reporter") or {}
        state = rep.get("state", "?").replace("STATE_", "").lower()
        states[state] = states.get(state, 0) + 1

    def forced_sites(entries: list[dict]) -> dict[str, list[float]]:
        sites: dict[str, list[float]] = {}
        for x in entries:
            if x["forced"]:
                sites.setdefault(x["site"] or "?", []).append(x["dur"])
        return sites

    f_lay = [x for x in layouts if x["forced"]]
    f_sty = [x for x in styles if x["forced"]]
    sites = forced_sites(layouts + styles)
    return {
        "window_ms": (t1 - t0) / 1000,
        "long_tasks": len(long_tasks),
        "longest_task_ms": max((t["dur"] / 1000 for t in tasks), default=0.0),
        "long_task_detail": [
            {
                "ms": round(t["dur"] / 1000, 1),
                "at_ms": round((t["ts"] - t0) / 1000),
                "inside": children(t),
            }
            for t in long_tasks[:5]
        ],
        "layouts": len(layouts),
        "layout_ms": sum(x["dur"] for x in layouts),
        "forced_layouts": len(f_lay),
        "forced_layout_ms": sum(x["dur"] for x in f_lay),
        "style_recalcs": len(styles),
        "style_ms": sum(x["dur"] for x in styles),
        "forced_styles": len(f_sty),
        "forced_style_ms": sum(x["dur"] for x in f_sty),
        "forced_sites": {
            k: {"n": len(v), "ms": round(sum(v), 2), "max_ms": round(max(v), 2)}
            for k, v in sorted(sites.items(), key=lambda kv: -sum(kv[1]))[:8]
        },
        "paint_ms": paint,
        "decode_main_ms": decode_main,
        "frame_states": states,
    }


def analyze_frames(rec: dict, smap: SourceMap | None) -> dict[str, Any]:
    frames = rec.get("frames") or []
    gaps = [b - a for a, b in zip(frames, frames[1:], strict=False)]
    slow = [g for g in gaps if g > SLOW_FRAME_MS]
    missed = sum(max(0, round(g / FRAME_MS) - 1) for g in gaps)
    worst = sorted(
        ((g, frames[i + 1] - rec.get("t0", 0)) for i, g in enumerate(gaps)), reverse=True
    )[:5]
    loaf = rec.get("loaf") or []
    scripts: dict[str, dict[str, float]] = {}
    for f in loaf:
        for s in f.get("scripts") or []:
            where = smap.where_char(s.get("pos")) if smap and s.get("pos") is not None else None
            key = f"{s.get('fn') or s.get('invoker') or '?'} @ {where or s.get('invoker') or '?'}"
            agg = scripts.setdefault(key, {"n": 0, "ms": 0.0, "forced_ms": 0.0})
            agg["n"] += 1
            agg["ms"] += s.get("dur") or 0
            agg["forced_ms"] += s.get("forced") or 0
    probe: dict[str, dict[str, Any]] = {}
    for f in rec.get("forced") or []:
        sites = [smap.frame(line) for line in f.get("stack", [])] if smap else []
        sites = [s for s in sites if s]
        key = f"{f['api']} <- {' <- '.join(sites[:3]) if sites else '?'}"
        agg = probe.setdefault(key, {"n": 0, "ms": 0.0, "max_ms": 0.0})
        agg["n"] += 1
        agg["ms"] += f["dt"]
        agg["max_ms"] = max(agg["max_ms"], f["dt"])
    return {
        "frames": len(frames),
        "slow_frames": len(slow),
        "missed_vsyncs": missed,
        "longest_frame_ms": max(gaps, default=0.0),
        "p95_frame_ms": _pct(gaps, 0.95),
        "worst_frames": [{"ms": round(g, 1), "at_ms": round(t)} for g, t in worst],
        "loafs": len(loaf),
        "loaf_ms_max": max((f["dur"] for f in loaf), default=0.0),
        "loaf_blocking_ms": sum(f.get("blocking") or 0 for f in loaf),
        "loaf_scripts": dict(sorted(scripts.items(), key=lambda kv: -kv[1]["ms"])[:8]),
        "probe_calls": rec.get("calls") or {},
        "probe_forced": dict(sorted(probe.items(), key=lambda kv: -kv[1]["ms"])[:12]),
    }


def analyze_profile(profile: dict, smap: SourceMap | None) -> dict[str, Any]:
    """A V8 CPU profile -> the app functions that held the main thread, by
    self time and by inclusive time, named through the source map."""
    nodes = {n["id"]: n for n in profile.get("nodes", [])}
    parent: dict[int, int] = {}
    for n in nodes.values():
        for c in n.get("children", []):
            parent[c] = n["id"]

    def key(node: dict) -> str:
        cf = node["callFrame"]
        fn = cf.get("functionName") or "(anonymous)"
        url = cf.get("url") or ""
        if smap and smap.bundle_name in url:
            return f"{fn} @ {smap.where(cf['lineNumber'], cf['columnNumber']) or '?'}"
        if not url:
            return fn  # (program), (garbage collector), native
        return f"{fn} @ {url.rsplit('/', 1)[-1]}"

    self_ms: dict[str, float] = {}
    incl_ms: dict[str, float] = {}
    for sample, delta in zip(
        profile.get("samples", []), profile.get("timeDeltas", []), strict=False
    ):
        ms = delta / 1000
        node = nodes.get(sample)
        if node is None:
            continue
        k = key(node)
        self_ms[k] = self_ms.get(k, 0) + ms
        seen = set()
        cur: int | None = sample
        while cur is not None:
            kk = key(nodes[cur])
            if kk not in seen:
                seen.add(kk)
                incl_ms[kk] = incl_ms.get(kk, 0) + ms
            cur = parent.get(cur)
    ours = {k: v for k, v in incl_ms.items() if "@ src/" in k}
    return {
        "self": {k: round(v, 1) for k, v in sorted(self_ms.items(), key=lambda kv: -kv[1])[:12]},
        "inclusive": {k: round(v, 1) for k, v in sorted(ours.items(), key=lambda kv: -kv[1])[:12]},
    }


# --- the app, its server and the browser ---------------------------------------


def build_app() -> None:
    """The app as it ships, only unminified and with a source map so a trace
    can name functions. Into pwa/dist, which is what the service serves."""
    subprocess.run(
        ["npx", "vite", "build", "--minify", "false", "--sourcemap"],
        cwd=PWA,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def bundle() -> Path:
    found = sorted((DIST / "assets").glob("index-*.js"))
    if not found:
        raise SystemExit("no built bundle in pwa/dist/assets (run without --no-build)")
    return found[0]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@contextlib.contextmanager
def rig_server(port: int, messages: int):
    data = tempfile.mkdtemp(prefix="motionrig-data-")
    # the service logs a line per socket frame: to a file, never to a pipe
    # nobody drains, which would fill and stall the server mid-flow
    log = open(Path(data) / "server.log", "wb")  # noqa: SIM115
    proc = subprocess.Popen(
        [
            sys.executable,
            str(HERE / "server.py"),
            "--port",
            str(port),
            "--data",
            data,
            "--messages",
            str(messages),
        ],
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    try:
        deadline = time.time() + 180
        while time.time() < deadline:
            if proc.poll() is not None:
                tail = (Path(data) / "server.log").read_text(errors="replace")[-2000:]
                raise SystemExit("rig server died:\n" + tail)
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1)
                break
            except OSError:
                time.sleep(0.5)
        else:
            raise SystemExit("rig server did not come up")
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.terminate()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(10)
        log.close()
        subprocess.run(["rm", "-rf", data], check=False)


def post(base: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body or {}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"{}")


def camera_photo(path: Path) -> Path:
    """A 12 MP JPEG like the one the phone's picker hands over."""
    if not path.exists():
        sys.path.insert(0, str(HERE))
        from server import photo  # the same generator the seeded thread uses

        path.write_bytes(photo(99, portrait=True))
    return path


@dataclass
class Phone:
    page: Any
    cdp: Any
    browser: Any
    base: str
    smap: SourceMap | None
    throttle: float
    shots: Path | None = None
    profile: bool = False
    traces: Path | None = None
    results: dict[str, Any] = field(default_factory=dict)

    async def js(self, script: str, arg: Any = None) -> Any:
        return await self.page.evaluate(script, arg)

    async def shot(self, name: str) -> None:
        if self.shots is None:
            return
        await self.page.screenshot(
            path=str(self.shots / f"{name}.jpg"), type="jpeg", quality=70, scale="css"
        )

    async def tap(self, selector: str) -> None:
        box = await self.page.locator(selector).bounding_box()
        assert box, f"nothing to tap at {selector}"
        await self.page.touchscreen.tap(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)

    async def fling(self, dy: float, speed: int = 2600, x: float = 196, y: float = 420) -> None:
        """A thumb flick with its momentum; dy > 0 pulls the history down into view."""
        await self.cdp.send(
            "Input.synthesizeScrollGesture",
            {
                "x": x,
                "y": y,
                "xDistance": 0,
                "yDistance": dy,
                "speed": speed,
                "gestureSourceType": "touch",
                "preventFling": False,
            },
        )

    async def drag(self, points: list[tuple[float, float]], step_ms: float = 16) -> None:
        """A finger on the glass: down at the first point, through the rest, up."""
        send = self.cdp.send
        await send(
            "Input.dispatchTouchEvent",
            {"type": "touchStart", "touchPoints": [{"x": points[0][0], "y": points[0][1]}]},
        )
        for x, y in points[1:]:
            await asyncio.sleep(step_ms / 1000)
            await send(
                "Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]}
            )
        await send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    async def keyboard(self, up: bool) -> None:
        """The iOS keyboard: the focus tap, then the visual viewport's one report
        about 80 ms later; the close starts at the focus loss."""
        if up:
            await self.tap("#text")
            await asyncio.sleep(0.08)
            await self.js(
                f"() => {{ window.__rigVV = {VIEW['height'] - KEYBOARD};"
                " visualViewport.dispatchEvent(new Event('resize')); }"
            )
        else:
            await self.js("() => document.getElementById('text').blur()")
            await asyncio.sleep(0.01)
            await self.js(
                "() => { window.__rigVV = undefined;"
                " visualViewport.dispatchEvent(new Event('resize')); }"
            )

    async def metrics(self) -> dict[str, float]:
        raw = await self.cdp.send("Performance.getMetrics")
        return {m["name"]: m["value"] for m in raw["metrics"]}

    async def measure(self, name: str, act, settle_ms: int, reload: bool = False) -> dict:
        before = await self.metrics() if not reload else None
        rows_before = await self.js("() => document.querySelectorAll('#thread .row').length")
        await self.browser.start_tracing(page=self.page, categories=CATEGORIES)
        profiling = self.profile and not reload
        if profiling:
            await self.cdp.send("Profiler.enable")
            await self.cdp.send("Profiler.setSamplingInterval", {"interval": 250})
            await self.cdp.send("Profiler.start")
        if reload:
            await self.js("() => sessionStorage.setItem('rig-autostart', '1')")
        else:
            await self.js("() => window.__rig.start()")
        await act()
        await self.page.wait_for_timeout(settle_ms)
        rec = await self.js("() => window.__rig.stop()")
        profile = (await self.cdp.send("Profiler.stop"))["profile"] if profiling else None
        raw = await self.browser.stop_tracing()
        if self.traces is not None:
            # gzipped, and loadable as is in the DevTools Performance panel
            (self.traces / f"{name}.json.gz").write_bytes(gzip.compress(raw))
        trace = json.loads(raw)
        events = trace["traceEvents"] if isinstance(trace, dict) else trace
        after = await self.metrics()
        result = {
            "flow": name,
            **analyze_frames(rec, self.smap),
            **analyze_trace(events, self.smap),
        }
        if profile is not None:
            result["profile"] = analyze_profile(profile, self.smap)
        if before is not None:
            for key in (
                "LayoutCount",
                "RecalcStyleCount",
                "LayoutDuration",
                "RecalcStyleDuration",
                "ScriptDuration",
                "TaskDuration",
            ):
                delta = after.get(key, 0) - before.get(key, 0)
                result[f"m_{key}"] = delta * 1000 if key.endswith("Duration") else delta
        result["rows"] = await self.js("() => document.querySelectorAll('#thread .row').length")
        # rows that arrived inside the window: a history page or a reply, named
        # so a number is never read as the flow's own when an insert rode along
        result["rows_added"] = result["rows"] - rows_before if not reload else 0
        self.results[name] = result
        print(
            f"  {name:<18} slow {result['slow_frames']:>3}"
            f"  longest {result['longest_frame_ms']:6.1f} ms"
            f"  long tasks {result.get('long_tasks', '?'):>2}"
            f"  forced layouts {result.get('forced_layouts', '?'):>3}"
            f" ({result.get('forced_layout_ms', 0):5.1f} ms)"
            f"  dropped {result.get('frame_states', {}).get('dropped', 0):>3}"
            f"  rows {result['rows']} (+{result['rows_added']})",
            flush=True,
        )
        return result


# --- the flows -------------------------------------------------------------------


async def settle_quiet(phone: Phone, ms: int = 600) -> None:
    await phone.page.wait_for_timeout(ms)


async def run_flows(phone: Phone, only: set[str] | None, photo: Path) -> None:
    page = phone.page
    want = (lambda n: True) if not only else (lambda n: n in only)

    async def cold_open():
        await page.reload(wait_until="commit")
        if phone.shots:
            await page.wait_for_timeout(250)
            await phone.shot("01-cold-open-250ms")

    await phone.measure("cold_open", cold_open, 3500, reload=True)
    await phone.shot("02-cold-open-settled")

    async def peek():
        pts = [(330 - i * 6, 430 - i * 0.4) for i in range(22)]
        if phone.shots:
            # hold at full pull for the picture, then let go
            send = phone.cdp.send
            await send(
                "Input.dispatchTouchEvent",
                {"type": "touchStart", "touchPoints": [{"x": pts[0][0], "y": pts[0][1]}]},
            )
            for x, y in pts[1:]:
                await asyncio.sleep(0.016)
                await send(
                    "Input.dispatchTouchEvent",
                    {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]},
                )
            await phone.shot("03-peek-held")
            await send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        else:
            await phone.drag(pts + [pts[-1]] * 10)

    if want("peek"):
        await phone.measure("peek", peek, 700)

    async def keyboard_open():
        await phone.keyboard(True)

    await phone.measure("keyboard_open", keyboard_open, 900)
    await phone.shot("04-keyboard-up")

    async def type_expand():
        await page.keyboard.type(
            "Can you move the hiking photo to the top and make its caption a little "
            "smaller? The second card also wraps onto three lines on my phone.",
            delay=45,
        )

    await phone.measure("type_expand", type_expand, 500)
    await phone.shot("05-compose-expanded")

    async def send_text():
        await phone.tap("#sendbtn")
        if phone.shots:
            await page.wait_for_timeout(120)
            await phone.shot("06-send-in-flight")

    await phone.measure("send", send_text, 1100)

    async def reply():
        # the scripted worker: Read at +0.4 s, dots at +1.4 s, the reply at +3.0 s
        if phone.shots:
            await page.wait_for_timeout(700)
            await phone.shot("07-reply-dots")

    await phone.measure("reply", reply, 2600)
    await phone.shot("08-reply-landed")

    async def keyboard_close():
        await phone.keyboard(False)

    await phone.measure("keyboard_close", keyboard_close, 900)

    async def attach_photo():
        async with page.expect_file_chooser() as chooser:
            await phone.tap("#attach")
        await (await chooser.value).set_files(str(photo))

    if want("attach_photo"):
        await phone.measure("attach_photo", attach_photo, 1500)
        await phone.shot("09-photo-tray")

        async def send_photo():
            await phone.tap("#sendbtn")
            if phone.shots:
                await page.wait_for_timeout(150)
                await phone.shot("10-photo-in-flight")

        await phone.measure("send_photo", send_photo, 2400)
        await phone.shot("11-photo-landed")
        await page.wait_for_timeout(2500)  # its scripted reply lands outside any window

    async def scroll_history():
        for _ in range(3):
            await phone.fling(650)
            await page.wait_for_timeout(700)

    await phone.measure("scroll_history", scroll_history, 1200)
    await phone.shot("12-history-scrolled")

    async def load_older():
        for _ in range(6):
            await phone.fling(900, speed=3200)
            await page.wait_for_timeout(650)

    await phone.measure("load_older", load_older, 1500)
    await phone.shot("13-older-loaded")
    # deeper, unmeasured, until the thread holds a few hundred rows
    for _ in range(40):
        if await phone.js("() => document.querySelectorAll('#thread .row').length") >= 300:
            break
        await phone.fling(1200, speed=4000)
        await page.wait_for_timeout(500)
    await settle_quiet(phone, 800)

    # the chevron surfaces after three still seconds away from the bottom
    await page.wait_for_timeout(3300)
    await phone.shot("14-chevron-shown")

    async def jump():
        await phone.tap("#jump")
        if phone.shots:
            await page.wait_for_timeout(300)
            await phone.shot("15-jump-gliding")

    await phone.measure("jump", jump, 2600)

    # back at the bottom of a deep thread: the keyboard up and down again
    await phone.measure("keyboard_open_deep", keyboard_open, 900)
    await phone.measure("keyboard_close_deep", keyboard_close, 900)

    # the peek a few hundred rows deep, at the bottom where the recent times
    # are (a peek near the top of the loaded history would also land a banked
    # page at its release, which is the history insert, measured above)
    if want("peek"):
        await page.wait_for_timeout(600)
        await phone.measure("peek_deep", peek, 700)

    async def reply_deep():
        post(phone.base, "/rig/reply")

    await phone.measure("reply_deep", reply_deep, 3600)

    async def background_return():
        await phone.js(
            "() => { window.__rigHidden = false;"
            " document.dispatchEvent(new Event('visibilitychange')); }"
        )
        await phone.cdp.send("Page.setWebLifecycleState", {"state": "active"})

    # away: hidden, frozen like iOS freezes it, the socket gone, and three
    # replies landing on the server meanwhile
    await phone.js(
        "() => { window.__rigHidden = true;"
        " document.dispatchEvent(new Event('visibilitychange')); }"
    )
    await phone.cdp.send("Page.setWebLifecycleState", {"state": "frozen"})
    post(phone.base, "/rig/drop")
    post(phone.base, "/rig/burst", {"n": 3})
    await asyncio.sleep(1.5)
    # the measured window has to open in the page, which is frozen: thaw first,
    # so the recorder starts on the return's own first task
    await phone.cdp.send("Page.setWebLifecycleState", {"state": "active"})
    await phone.measure("background_return", background_return, 3000)
    await phone.shot("16-back-from-background")


async def one_run(
    pw,
    base: str,
    smap: SourceMap | None,
    throttle: float,
    only: set[str] | None,
    shots: Path | None,
    attribute: bool,
    photo: Path,
    traces: Path | None = None,
    css: str | None = None,
) -> dict[str, Any]:
    browser = await pw.chromium.launch(headless=True, channel="chromium")
    try:
        ctx = await browser.new_context(
            viewport=VIEW,
            device_scale_factor=DPR,
            is_mobile=True,
            has_touch=True,
            user_agent=UA,
            # an experiment's stylesheet is an inline one, which the app's own
            # policy (rightly) refuses; only then is the policy set aside
            bypass_csp=css is not None,
        )
        config = {"token": TOKEN, "attribute": attribute, "css": css}
        await ctx.add_init_script(
            f"window.__rigConfig = {json.dumps(config)};\n" + (HERE / "probe.js").read_text("utf-8")
        )
        page = await ctx.new_page()
        cdp = await ctx.new_cdp_session(page)
        await cdp.send("Performance.enable")
        # first open, at full speed: installs the service worker and writes the
        # thread cache, so the measured cold open is the phone's everyday one
        await page.goto(base + "/")
        await page.wait_for_selector("#thread .row")
        await page.wait_for_timeout(2500)
        await cdp.send("Emulation.setCPUThrottlingRate", {"rate": throttle})
        phone = Phone(
            page, cdp, browser, base, smap, throttle, shots, profile=attribute, traces=traces
        )
        await run_flows(phone, only, photo)
        return phone.results
    finally:
        await browser.close()


def summarize(runs: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    keys = [
        "slow_frames",
        "missed_vsyncs",
        "longest_frame_ms",
        "long_tasks",
        "longest_task_ms",
        "forced_layouts",
        "forced_layout_ms",
        "forced_styles",
        "forced_style_ms",
        "layouts",
        "layout_ms",
        "style_recalcs",
        "style_ms",
        "loafs",
        "loaf_ms_max",
        "decode_main_ms",
        "paint_ms",
        "rows",
        "rows_added",
    ]
    out: dict[str, dict[str, float]] = {}
    flows = [f for f in runs[0]] if runs else []
    for flow in flows:
        row: dict[str, float] = {}
        for k in keys:
            vals = [r[flow].get(k, 0) for r in runs if flow in r]
            row[k] = statistics.median(vals) if vals else 0
        drops = [r[flow].get("frame_states", {}).get("dropped", 0) for r in runs if flow in r]
        partial = [
            r[flow].get("frame_states", {}).get("presented_partial", 0) for r in runs if flow in r
        ]
        row["dropped"] = statistics.median(drops) if drops else 0
        row["partial"] = statistics.median(partial) if partial else 0
        out[flow] = row
    return out


def table(summary: dict[str, dict[str, float]]) -> str:
    head = (
        "| flow | slow frames | longest frame ms | long tasks | forced layouts (ms) "
        "| style recalcs (forced) | compositor dropped / partial | rows |"
    )
    lines = [head, "|" + "---|" * 8]
    for flow, r in summary.items():
        lines.append(
            f"| {flow} | {r['slow_frames']:.0f} | {r['longest_frame_ms']:.0f} "
            f"| {r['long_tasks']:.0f} "
            f"| {r['forced_layouts']:.0f} ({r['forced_layout_ms']:.1f}) "
            f"| {r['style_recalcs']:.0f} ({r['forced_styles']:.0f}) "
            f"| {r['dropped']:.0f} / {r['partial']:.0f} "
            f"| {r['rows']:.0f} (+{r.get('rows_added', 0):.0f}) |"
        )
    return "\n".join(lines)


def compare(a_path: Path, b_path: Path) -> None:
    a = json.loads(a_path.read_text())["summary"]
    b = json.loads(b_path.read_text())["summary"]
    print(
        "| flow | slow frames | longest frame ms | forced layouts | forced layout ms | long tasks |"
    )
    print("|---|---|---|---|---|---|")
    for flow in a:
        if flow not in b:
            continue
        x, y = a[flow], b[flow]
        print(
            f"| {flow} | {x['slow_frames']:.0f} -> {y['slow_frames']:.0f} "
            f"| {x['longest_frame_ms']:.0f} -> {y['longest_frame_ms']:.0f} "
            f"| {x['forced_layouts']:.0f} -> {y['forced_layouts']:.0f} "
            f"| {x['forced_layout_ms']:.1f} -> {y['forced_layout_ms']:.1f} "
            f"| {x['long_tasks']:.0f} -> {y['long_tasks']:.0f} |"
        )


async def main_async(args: argparse.Namespace) -> None:
    from playwright.async_api import async_playwright

    if not args.no_build:
        print("building pwa/dist (unminified, with a source map)", flush=True)
        build_app()
    smap = SourceMap(bundle())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    photo = camera_photo(Path(tempfile.gettempdir()) / "motionrig-camera.jpg")
    only = set(args.flows.split(",")) if args.flows else None
    port = args.port or free_port()
    css = Path(args.css).read_text("utf-8") if args.css else None
    runs: list[dict[str, Any]] = []
    with rig_server(port, args.messages) as base:
        async with async_playwright() as pw:
            if args.shots:
                shots = out / f"shots-{args.label}"
                shots.mkdir(exist_ok=True)
                print(f"screenshots -> {shots}", flush=True)
                await one_run(pw, base, smap, args.throttle, only, shots, False, photo, None, css)
            for i in range(args.runs):
                print(f"run {i + 1}/{args.runs} ({args.throttle:g}x CPU)", flush=True)
                traces = None
                if args.traces and i == 0:
                    traces = out / f"traces-{args.label}"
                    traces.mkdir(exist_ok=True)
                runs.append(
                    await one_run(
                        pw, base, smap, args.throttle, only, None, False, photo, traces, css
                    )
                )
            attribution = None
            if args.attribute:
                print("attribution pass (layout APIs wrapped)", flush=True)
                attribution = await one_run(
                    pw, base, smap, args.throttle, only, None, True, photo, None, css
                )
    summary = summarize(runs)
    record = {
        "label": args.label,
        "throttle": args.throttle,
        "runs": runs,
        "summary": summary,
        "attribution": attribution,
    }
    path = out / f"{args.label}.json"
    path.write_text(json.dumps(record, indent=1))
    md = table(summary)
    (out / f"{args.label}.md").write_text(md + "\n")
    print(md)
    print(f"\nwrote {path}")


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "compare":
        compare(Path(sys.argv[2]), Path(sys.argv[3]))
        return
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--throttle", type=float, default=4.0)
    parser.add_argument("--label", default="run")
    parser.add_argument("--out", default=str(Path(tempfile.gettempdir()) / "motionrig"))
    parser.add_argument("--flows", help="comma list to run a subset (the setup flows always run)")
    parser.add_argument("--shots", action="store_true", help="one extra pass taking screenshots")
    parser.add_argument(
        "--attribute",
        action="store_true",
        help="one extra pass naming the code behind each forced layout,"
        " with a CPU profile of every flow",
    )
    parser.add_argument(
        "--traces",
        action="store_true",
        help="keep the first run's raw trace per flow (json.gz, opens in DevTools)",
    )
    parser.add_argument(
        "--css", help="a stylesheet to lay over the app, to try a CSS change without a rebuild"
    )
    parser.add_argument("--messages", type=int, default=400)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument(
        "--no-build", action="store_true", help="measure the pwa/dist already built"
    )
    args = parser.parse_args()
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
