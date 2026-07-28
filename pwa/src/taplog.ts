// TEMPORARY instrumentation for the iOS shell bugs (branch bug/plustap).
// Captures every raw signal iOS delivers around a ＋ tap or a keyboard
// transition — pointerdown/up, click, focus traffic, picker cancel/change,
// window focus/blur, visibility, visual-viewport geometry — plus the shell's
// decision lines (wired via setShellLogger). Each line carries a relative
// timestamp and the activeElement at that instant.
//
// There is deliberately NO on-screen panel: the log exists so the SERVER logs
// carry the evidence, not so it can be read on the phone. Lines batch to
// /api/taplog, which echoes them to stdout for Render to keep.
// Delete this module when the bugs are dead.

function desc(t: EventTarget | null): string {
  if (t === window) return "window";
  if (t === document) return "doc";
  if (!(t instanceof Element)) return String(t);
  const cls =
    typeof t.className === "string" && t.className ? `.${t.className.split(" ")[0]}` : "";
  return `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : cls}`;
}

// Attaches the raw-event listeners and returns the log fn.
// MUST run before initShell(): at-target listeners fire in registration
// order, so registering first is what puts each raw line ABOVE the shell
// decision it triggered.
export function initTapLog(): (ev: string, detail?: string) => void {
  const t0 = performance.now();

  // auto-ship: batches POST to /api/taplog (server echoes to stdout, so
  // Render's service logs carry the evidence). Failed batches re-queue and
  // ride the next tick.
  let pending: string[] = [];
  const ship = (): void => {
    if (!pending.length) return;
    const token = localStorage.getItem("paratrooper_token");
    if (!token) return;
    const batch = pending;
    pending = [];
    fetch("/api/taplog", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lines: batch }),
      keepalive: true, // survives backgrounding mid-flight
    }).then(
      (r) => {
        if (!r.ok) pending = batch.concat(pending);
      },
      () => {
        pending = batch.concat(pending);
      },
    );
  };
  setInterval(ship, 3000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") ship(); // flush before iOS freezes us
  });

  const log = (ev: string, detail = ""): void => {
    const t = ((performance.now() - t0) / 1000).toFixed(3);
    pending.push(`+${t} ${ev}${detail ? ` ${detail}` : ""} act=${desc(document.activeElement)}`);
  };

  // the raw feed: capture phase at document = earliest possible sighting,
  // and it survives renderChat recreating the file input (no rebinding)
  for (const ev of ["pointerdown", "pointerup", "click", "focusin", "focusout", "cancel", "change"]) {
    document.addEventListener(ev, (e) => log(ev, desc(e.target)), true);
  }
  // bubble-phase on window: element focus events don't bubble, so these
  // lines mean the WINDOW itself (the settle racers' trigger), not a field
  window.addEventListener("focus", () => log("win.focus"));
  window.addEventListener("blur", () => log("win.blur"));
  window.addEventListener("pageshow", () => log("pageshow"));
  window.addEventListener("pagehide", () => log("pagehide"));
  document.addEventListener("visibilitychange", () => log("vis", document.visibilityState));
  // keyboard forensics: the raw viewport numbers the shell decides from
  const vv = window.visualViewport;
  vv?.addEventListener("resize", () =>
    log("vv.resize", `h=${Math.round(vv.height)} top=${Math.round(vv.offsetTop)} inner=${window.innerHeight}`));
  vv?.addEventListener("scroll", () => log("vv.scroll", `top=${Math.round(vv.offsetTop)}`));

  log("taplog ready");
  return log;
}
