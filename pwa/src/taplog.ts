// TEMPORARY instrumentation for the dead-＋-tap bug (branch bug/plustap).
// An on-screen event log: every raw signal iOS delivers around a ＋ tap —
// pointerdown/up, click, focus traffic, picker cancel/change, window
// focus/blur, visibility — plus the shell's decision lines (wired via
// setShellLogger). Each line carries a timestamp and the activeElement at
// that instant. One failing tap read from this log answers the open
// question: did the tap die page-side (pointerdown arrives, click never
// does / focus parked on the file input) or inside WebKit (click forwarded
// to the input, no menu presented)? Delete this module when the bug is dead.

const MAX_LINES = 400;

function desc(t: EventTarget | null): string {
  if (t === window) return "window";
  if (t === document) return "doc";
  if (!(t instanceof Element)) return String(t);
  const cls =
    typeof t.className === "string" && t.className ? `.${t.className.split(" ")[0]}` : "";
  return `${t.tagName.toLowerCase()}${t.id ? `#${t.id}` : cls}`;
}

// Builds the panel, attaches the raw-event listeners, returns the log fn.
// MUST run before initShell(): at-target listeners fire in registration
// order, so registering first is what puts each raw line ABOVE the shell
// decision it triggered.
export function initTapLog(): (ev: string, detail?: string) => void {
  const t0 = performance.now();
  const buf: string[] = [];

  // panel lives on <body>, not #app — renderChat wipes #app's innerHTML
  const panel = document.createElement("div");
  panel.id = "taplog";
  panel.style.cssText =
    "position:fixed;top:3.2rem;left:0.5rem;right:0.5rem;z-index:9999;" +
    "background:rgba(0,0,0,0.82);color:#9f9;border-radius:8px;padding:4px 6px;" +
    "font:10px/1.45 ui-monospace,SFMono-Regular,monospace";

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;align-items:center";
  const title = document.createElement("span");
  title.textContent = "＋tap log";
  title.style.cssText = "flex:1;color:#fff;opacity:0.7";
  const mkBtn = (label: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText =
      "background:#333;color:#fff;border:0;border-radius:4px;font:inherit;padding:2px 8px";
    return b;
  };
  const copyBtn = mkBtn("copy");
  const clearBtn = mkBtn("clear");
  const foldBtn = mkBtn("–");
  bar.append(title, copyBtn, clearBtn, foldBtn);

  const lines = document.createElement("div");
  lines.style.cssText =
    "max-height:30vh;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin-top:2px";

  panel.append(bar, lines);
  document.body.appendChild(panel);

  const flash = (b: HTMLButtonElement, text: string): void => {
    const prev = b.textContent;
    b.textContent = text;
    setTimeout(() => (b.textContent = prev), 800);
  };
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(buf.join("\n")).then(
      () => flash(copyBtn, "✓"),
      () => flash(copyBtn, "✗"),
    );
  });
  clearBtn.addEventListener("click", () => {
    buf.length = 0;
    lines.replaceChildren();
  });
  foldBtn.addEventListener("click", () => {
    const folded = lines.style.display === "none";
    lines.style.display = folded ? "" : "none";
    foldBtn.textContent = folded ? "–" : "+";
  });

  const log = (ev: string, detail = ""): void => {
    const t = ((performance.now() - t0) / 1000).toFixed(3);
    const line = `+${t} ${ev}${detail ? ` ${detail}` : ""} act=${desc(document.activeElement)}`;
    buf.push(line);
    const row = document.createElement("div");
    row.textContent = line;
    lines.appendChild(row);
    while (buf.length > MAX_LINES) {
      buf.shift();
      lines.firstChild?.remove();
    }
    lines.scrollTop = lines.scrollHeight;
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

  log("taplog ready");
  return log;
}
