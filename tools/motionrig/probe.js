// The motion rig's in-page half, installed before any of the app's own code
// runs (rig.py hands it to the page as an init script). Three jobs:
//
// 1. Make the page believe it is the installed phone app: a signed-in token,
//    navigator.standalone, a visual viewport whose height the driver can set
//    (the keyboard), and a visibility the driver can flip (the home button).
// 2. Record the frames: every requestAnimationFrame timestamp while a flow is
//    being measured, and every long animation frame (LoAF) with its scripts.
// 3. Only when asked (the attribute flag in the config the driver prepends):
//    wrap the APIs that can force a synchronous style or layout pass, and keep
//    the stack of every call that took long enough to have done one. This
//    changes timings a little, so the frame numbers come from runs without it.
(() => {
  const cfg = window.__rigConfig || {};
  try {
    if (cfg.token) localStorage.setItem("paratrooper_token", cfg.token);
  } catch {}
  Object.defineProperty(Navigator.prototype, "standalone", { get: () => true, configurable: true });

  // the keyboard: iOS shrinks the visual viewport only, never the layout one
  const vvHeight = Object.getOwnPropertyDescriptor(VisualViewport.prototype, "height");
  Object.defineProperty(VisualViewport.prototype, "height", {
    configurable: true,
    get() {
      return typeof window.__rigVV === "number" ? window.__rigVV : vvHeight.get.call(this);
    },
  });
  // the home button: a page iOS sends away reads hidden until it comes back
  for (const [name, value] of [["visibilityState", (h) => (h ? "hidden" : "visible")], ["hidden", (h) => h]]) {
    Object.defineProperty(Document.prototype, name, {
      configurable: true,
      get: () => value(!!window.__rigHidden),
    });
  }

  const rig = {
    on: false,
    t0: 0,
    frames: [],
    loaf: [],
    forced: [],
    calls: {},
  };
  window.__rig = rig;

  const tick = (now) => {
    if (!rig.on) return;
    rig.frames.push(now);
    requestAnimationFrame(tick);
  };
  rig.start = () => {
    rig.on = true;
    rig.t0 = performance.now();
    rig.frames = [];
    rig.loaf = [];
    rig.forced = [];
    rig.calls = {};
    performance.mark("rig-start");
    requestAnimationFrame(tick);
  };
  rig.stop = () => {
    performance.mark("rig-end");
    rig.on = false;
    return {
      t0: rig.t0,
      t1: performance.now(),
      frames: rig.frames,
      loaf: rig.loaf,
      forced: rig.forced,
      calls: rig.calls,
    };
  };

  try {
    new PerformanceObserver((list) => {
      if (!rig.on) return;
      for (const e of list.getEntries()) {
        rig.loaf.push({
          start: e.startTime,
          dur: e.duration,
          blocking: e.blockingDuration,
          renderStart: e.renderStart,
          styleLayoutStart: e.styleAndLayoutStart,
          scripts: (e.scripts || []).map((s) => ({
            invoker: s.invoker,
            type: s.invokerType,
            fn: s.sourceFunctionName,
            url: s.sourceURL,
            pos: s.sourceCharPosition,
            dur: s.duration,
            forced: s.forcedStyleAndLayoutDuration,
          })),
        });
      }
    }).observe({ type: "long-animation-frame", buffered: false });
  } catch {}

  // the cold open: the driver leaves this flag and reloads, and the recording
  // starts on the new document's first line
  let autostart = !!cfg.autostart;
  try {
    autostart = autostart || sessionStorage.getItem("rig-autostart") === "1";
    sessionStorage.removeItem("rig-autostart");
  } catch {}
  if (autostart) rig.start();

  // an experiment's stylesheet (rig.py --css), laid over the app's own
  if (cfg.css) {
    const add = () => {
      const style = document.createElement("style");
      style.textContent = cfg.css;
      document.head.appendChild(style);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add, { once: true });
  }

  if (!cfg.attribute) return;

  // --- attribution: who forced a style or layout pass, and for how long ------
  const THRESHOLD_MS = 0.3;
  const note = (api, dt) => {
    if (!rig.on) return;
    rig.calls[api] = (rig.calls[api] || 0) + 1;
    if (dt < THRESHOLD_MS) return;
    const stack = (new Error().stack || "").split("\n").slice(3, 9).map((l) => l.trim());
    rig.forced.push({ api, dt, t: performance.now() - rig.t0, stack });
  };
  const wrapGetter = (proto, prop, api, setter) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get() {
        const t = performance.now();
        const v = d.get.call(this);
        note(api, performance.now() - t);
        return v;
      },
      set: d.set && setter
        ? function (v) {
            const t = performance.now();
            d.set.call(this, v);
            note(api + "=", performance.now() - t);
          }
        : d.set,
    });
  };
  const wrapMethod = (proto, name, api) => {
    const f = proto[name];
    if (typeof f !== "function") return;
    proto[name] = function (...args) {
      const t = performance.now();
      const r = f.apply(this, args);
      note(api, performance.now() - t);
      return r;
    };
  };
  for (const p of ["clientTop", "clientLeft", "clientWidth", "clientHeight", "scrollWidth", "scrollHeight"]) {
    wrapGetter(Element.prototype, p, p, false);
  }
  for (const p of ["scrollTop", "scrollLeft"]) wrapGetter(Element.prototype, p, p, true);
  for (const p of ["offsetTop", "offsetLeft", "offsetWidth", "offsetHeight", "offsetParent", "innerText"]) {
    wrapGetter(HTMLElement.prototype, p, p, false);
  }
  for (const m of ["getBoundingClientRect", "getClientRects", "scrollIntoView", "scrollTo", "scrollBy"]) {
    wrapMethod(Element.prototype, m, m);
  }
  wrapMethod(HTMLElement.prototype, "focus", "focus");
  wrapMethod(Range.prototype, "getBoundingClientRect", "range.getBoundingClientRect");
  wrapMethod(Range.prototype, "getClientRects", "range.getClientRects");
  wrapMethod(Document.prototype, "elementFromPoint", "elementFromPoint");
  const gcs = window.getComputedStyle;
  window.getComputedStyle = function (el, pseudo) {
    const style = gcs.call(window, el, pseudo);
    return new Proxy(style, {
      get(target, key) {
        const t = performance.now();
        const v = Reflect.get(target, key, target);
        if (typeof v !== "function") {
          note("getComputedStyle", performance.now() - t);
          return v;
        }
        return (...args) => {
          const t1 = performance.now();
          const r = v.apply(target, args);
          note("getComputedStyle", performance.now() - t1);
          return r;
        };
      },
    });
  };
})();
