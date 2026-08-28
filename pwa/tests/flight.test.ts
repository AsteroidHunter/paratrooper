// Pins for the send-flight gate removal and the socket trail wiring. Both live
// in main.ts's DOM layer, which boots a real shell at import time and cannot
// load under node — so these pins read the source instead. What they hold:
// the standing order that the flight ALWAYS plays (no reduced-motion early
// return creeping back), that every flight leaves measured dx/dy and
// start/finish/cancel records on the trail, and that every socket frame
// passing the hold gate is recorded before applyEvent renders it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts"),
  "utf8",
);

function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("\n}", start);
  return src.slice(start, end);
}

describe("send flight (flyFromField)", () => {
  const body = fnBody("flyFromField");

  it("the prefers-reduced-motion early return is gone for good", () => {
    expect(body).not.toContain("prefers-reduced-motion");
    expect(body).not.toContain("matchMedia");
  });

  it("records invoke, per-bubble dx/dy at start, and finish/cancel on the trail", () => {
    expect(body).toContain('phase: "invoke"');
    expect(body).toContain('phase: "start"');
    expect(body).toMatch(/dx:.*dy:/s);
    expect(body).toContain('phase: "finish"');
    expect(body).toContain('phase: "cancel"');
  });

  it("still animates via the Web Animations API (the WebKit-proof path)", () => {
    expect(body).toContain("msg.animate(");
  });

  it("a fresh send collapses the composer before it launches", () => {
    // the field rect is the flight's start seat and the thread pin is its
    // landing seat: both must be final when the FLIP measures, so a fresh
    // launch runs the collapse (and its re-pin wait) before flyFromField;
    // only a send onto a still-airborne flight defers the collapse past it
    const send = fnBody("send");
    const freshCollapse = send.indexOf("collapseBar();");
    const fly = send.indexOf("flyFromField(w, morph, shotMorph)");
    expect(freshCollapse).toBeGreaterThan(-1);
    expect(freshCollapse).toBeLessThan(fly);
    expect(send.indexOf("if (airborne) collapseBar();")).toBeGreaterThan(fly);
  });
});

describe("send morph (armFieldMorph) — the bar leaves the box", () => {
  const morph = fnBody("armFieldMorph");
  const send = fnBody("send");
  const fly = fnBody("flyFromField");

  it("the bar snapshot predates the collapse: the shell lifts the typed text", () => {
    const arm = send.indexOf("armFieldMorph(");
    const collapse = send.indexOf("collapseBar();");
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(collapse);
  });

  it("only a text send arms the BAR morph, and the text row rides it", () => {
    expect(send).toContain("text ? armFieldMorph(textEl) : null");
    expect(fly).toContain('msg.classList.contains("text")');
    expect(fly).toContain("morph.launch(msg)");
  });

  it("the WAAPI translate stays for anything neither morph could take", () => {
    expect(fly).toContain("msg.animate(");
  });

  it("a text-only send's path is untouched by the photo flight", () => {
    // no files means no strip morph is even armed, so a text send reaches
    // flyFromField with the null it always did and nothing in the loop can
    // route its row anywhere but the bar morph
    expect(send).toContain("files.length ? armShotMorph(files) : null");
    const shotSkip = fly.indexOf('shotMorph?.launched() && msg.classList.contains("shot")');
    const textRoute = fly.indexOf('morph && msg.classList.contains("text")');
    expect(textRoute).toBeGreaterThan(-1);
    expect(textRoute).toBeLessThan(shotSkip); // the text row leaves before the photo gate
    // and the bar morph's own launch is still the only thing that touches it
    expect(fnBody("armFieldMorph")).not.toContain("armShotMorph");
    expect(fnBody("armFieldMorph")).not.toContain("gather");
  });

  it("the photo's L is nowhere in the bar morph: the text send still goes straight", () => {
    // The owner asked for the photo and only the photo. Both sends share
    // morphBox and flightEase, so the corner had to be added on the photo's
    // side of them or the text would have turned too. gather.test.ts holds the
    // arithmetic; this holds the wiring.
    expect(morph).not.toContain("elbow");
    expect(morph).not.toContain("SHOT_BEND");
    expect(morph).not.toContain("across");
    // one eased fraction, straight into the seat, exactly as it shipped
    expect(morph).toContain("const p = flightEase(f);");
    expect(morph).toMatch(/writeBox\(morphBox\(\s*bar,/);
    expect(morph).toContain("morphCorners(barRadius, corners, p)");
    // and the shared helper it leans on stays a plain per-axis interpolation
    const shift = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/shift.ts"),
      "utf8",
    );
    const box = shift.slice(shift.indexOf("export function morphBox"));
    expect(box.slice(0, box.indexOf("\n}"))).not.toContain("elbow");
  });

  it("the shell is honest box geometry re-aimed at the live seat every frame", () => {
    expect(morph).toContain("morphBox(");
    expect(morph).toContain("morphCorners(");
    expect(morph).toContain("flightEase(");
    // a second send's pin-and-shift moves the seat mid-flight; the per-frame
    // rect read is what lands the shell on the seat as it IS
    const step = morph.indexOf("const step");
    expect(step).toBeGreaterThan(-1);
    expect(morph.indexOf("msg.getBoundingClientRect()", step)).toBeGreaterThan(step);
    expect(morph).not.toContain("scale("); // shape morphs by box, never by transform
  });

  it("the real bubble holds its seat hidden and is handed back byte-clean", () => {
    expect(morph).toContain('msg.style.opacity = "0"');
    expect(morph).toContain('removeProperty("opacity")');
    expect(morph).toContain('removeAttribute("style")');
  });

  it("the crossfade layers ride the shared fractions from shift.ts", () => {
    expect(morph).toContain("barTextAlpha(f)");
    expect(morph).toContain("bubbleTextAlpha(f)");
    expect(morph).toContain("accentAlpha(f)");
  });

  it("morph flights join the receipt-hold ledger like translate flights", () => {
    expect(morph).toContain("flightsUp++");
    expect(morph).toContain("flightSettled()");
  });

  it("the landing frame paints before the swap (no snap under load)", () => {
    expect(morph).toContain('requestAnimationFrame(() => settle(msg, "morph-finish"))');
  });

  it("records arm, launch with travel and target, finish, and cancel", () => {
    expect(morph).toContain('phase: "morph-arm"');
    expect(morph).toContain('phase: "morph-launch"');
    expect(morph).toMatch(/dx:.*dy:/s);
    expect(morph).toContain('"morph-finish"');
    expect(morph).toContain('"morph-cancel"');
  });
});

// The photo send's own morph. gather.test.ts holds the geometry; these pins
// hold the wiring: what is measured when, what is hidden while it flies, what
// is handed back, and that no face of any kind is ever put behind the picture.
describe("photo send morph (armShotMorph): the squares leave the strip", () => {
  const shot = fnBody("armShotMorph");
  const send = fnBody("send");
  const fly = fnBody("flyFromField");
  const dismiss = fnBody("dismissSent");
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"),
    "utf8",
  );

  it("the squares are measured while they are still in the strip", () => {
    const arm = send.indexOf("armShotMorph(files)");
    const collapse = send.indexOf("collapseBar();");
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(collapse); // collapseBar takes the strip out of the layout
    expect(shot).toContain("pick.img.getBoundingClientRect()");
  });

  it("nothing is behind the picture, in flight or after", () => {
    // a sent photo has no bubble, so neither does the object that becomes one
    expect(shot).not.toContain("background");
    expect(shot).not.toContain("accent");
    expect(shot).not.toContain("morph-face");
    const sheet = css.slice(css.indexOf(".shotflight"), css.indexOf(".buildstamp"));
    expect(sheet).not.toContain("background");
    expect(sheet).not.toContain("box-shadow");
    expect(css).toContain(".msg.shot { padding: 0; background: none; }");
  });

  it("the gather, the deck and the crop all come from the one geometry module", () => {
    expect(shot).toContain("bundleSeats(");
    expect(shot).toContain("gatherMsFor(n)");
    expect(shot).toContain("shotLeg(now - t0, gatherMs, FLIGHT_MS)");
    expect(shot).toContain("coverBox(");
  });

  it("the carry travels the L, and the gather keeps the plain box", () => {
    // the corner is read off the one eased progress the carry already runs on,
    // so there is no second clock and no second curve anywhere in here
    expect(shot).toContain("elbowPath(p)");
    expect(shot).toContain("const onward = at.leg === \"carry\"");
    expect(shot).toContain("const bend = onward ? elbowPath(p) : null");
    // the cut and the picture behind it take the same legs and the same size
    // fraction: one object travelling, not a window panning over a photograph
    expect(shot).toContain("bend ? elbowBox(from, to, p, bend) : morphBox(from, to, p)");
    expect(shot).toContain("? elbowBox(cover, to, p, bend)");
    expect(shot).toContain(": morphBox(cover, coverBox(to, f.natW, f.natH), p)");
  });

  it("the two legs are timed on the trail, so a device session can show them", () => {
    expect(shot).toContain('phase: "shot-elbow"'); // the run picks up
    expect(shot).toContain('phase: "shot-across"'); // the rise is spent
    expect(shot).toMatch(/phase: "shot-elbow".*up:/s);
    expect(shot).toMatch(/phase: "shot-across".*across:/s);
    expect(shot).toContain("bend: SHOT_BEND"); // which corner shipped
    // each stamped once, the way the gather's end already is
    expect(shot).toContain("turning = true");
    expect(shot).toContain("risen = true");
  });

  it("honest box geometry on the shared ease, never transform scale", () => {
    expect(shot).toContain("morphBox(");
    expect(shot).toContain("morphCorners(");
    expect(shot).toContain("flightEase(at.f)");
    expect(shot).not.toContain("scale(");
    expect(shot).not.toContain("transform");
  });

  it("the crop is a cut that opens, cornered on the cut and not on the picture", () => {
    expect(shot).toContain("zoomClipInset(box, cut)");
    expect(shot).toMatch(/clipPath =\s*`inset\(/);
    expect(shot).toContain("round ${radius.toFixed(1)}px)");
    expect(shot).not.toContain("borderRadius"); // the box's corners are outside the window
  });

  it("the carry re-aims at the live seats every frame, reads before writes", () => {
    const step = shot.indexOf("const step");
    expect(step).toBeGreaterThan(-1);
    const read = shot.indexOf("msgs.map(seatOf)", step);
    const write = shot.indexOf("paint(f, box, cut, radius)", step);
    expect(read).toBeGreaterThan(step); // re-measured inside the frame loop
    expect(read).toBeLessThan(write); // and never between two box writes
  });

  it("the real rows hold their seats hidden and are handed back byte-clean", () => {
    expect(shot).toContain('msg.style.opacity = "0"');
    expect(shot).toContain('removeProperty("opacity")');
    expect(shot).toContain('removeAttribute("style")');
  });

  it("the strip's own squares go dark under their copies, and the tray lets them", () => {
    expect(shot).toContain('wrap.classList.add("aloft")');
    expect(css).toContain(".pthumb.aloft { visibility: hidden; }");
    expect(dismiss).toContain('pick.wrap.classList.contains("aloft")');
    // no second rasterization of a blob nobody can see, and no shrink either
    const aloft = dismiss.indexOf('classList.contains("aloft")');
    const bg = dismiss.indexOf("backgroundImage");
    expect(aloft).toBeLessThan(bg);
    expect(dismiss.slice(aloft, bg)).toContain("continue;");
  });

  it("a pick with no picture yet stands the whole flight down and says why", () => {
    expect(shot).toContain('stand("undrawn")');
    expect(shot).toContain('stand("nodims")');
    expect(shot).toContain('phase: "shot-skip"');
    expect(shot).toContain("reason,");
  });

  it("joins the receipt-hold ledger once: one object, one flight", () => {
    expect(shot.match(/flightsUp\+\+/g)).toHaveLength(1);
    expect(shot.match(/flightSettled\(\)/g)).toHaveLength(1);
  });

  it("the landing frame paints before the swap (no snap under load)", () => {
    expect(shot).toContain('requestAnimationFrame(() => settle("shot-finish"))');
  });

  it("records arm, launch with travel and target, the gather's end, and the finish", () => {
    expect(shot).toContain('phase: "shot-arm"');
    expect(shot).toContain('phase: "shot-launch"');
    expect(shot).toMatch(/phase: "shot-launch".*dx:.*dy:/s);
    expect(shot).toContain('phase: "shot-carry"');
    expect(shot).toContain('"shot-finish"');
    expect(shot).toContain('"shot-cancel"');
  });

  it("the flight routes every photo row to it, together, in one launch", () => {
    expect(fly).toContain('msgs).filter((m) => m.classList.contains("shot"))');
    expect(fly).toContain("shotMorph.launch(shotRows)");
    expect(fly).toContain('shotMorph?.launched() && msg.classList.contains("shot")');
    expect(fly).toContain("shotMorph?.cancel()");
    expect(fly).toContain("if (shotMorph && !shotMorph.launched()) shotMorph.cancel()");
  });

  it("the newborn stamp rides the bundle's travel instead of a row's", () => {
    expect(fly).toContain("rideDx = ride.dx");
    expect(fly).toContain("rideDelay = ride.delay");
    expect(fly).toContain("const stamp = flights ?");
  });

  it("a morphing row is not registered as airborne: it never leaves its seat", () => {
    // the FLIP's translate inflates scrollHeight and has to be subtracted;
    // this flight is a sheet in <body> and the row simply sits there hidden
    expect(shot).not.toContain("airborneRows");
  });
});

describe("socket apply trail (ws onmessage)", () => {
  it("records seq/kind/role after the hold gate and before applyEvent", () => {
    const gate = src.indexOf("replyHold.maybeHold(m.seq, m)");
    const record = src.indexOf('holdDiagRecord("ws-apply"');
    const apply = src.indexOf("applyEvent(m);", record);
    expect(gate).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(gate);
    expect(apply).toBeGreaterThan(record);
    expect(src.slice(record, apply)).toContain("kind: m.kind ?? null");
    expect(src.slice(record, apply)).toContain("role: m.role ?? null");
  });
});
