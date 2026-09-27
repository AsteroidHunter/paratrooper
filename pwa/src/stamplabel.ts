// The thread's time labels: the one on every row (revealed by the peek) and
// the day and time on every gap stamp. Both are made here from formatters
// built once, rather than once per call.
//
// toLocaleTimeString and toLocaleDateString with an options bag build a whole
// new Intl formatter every time they are called: 27us a call in Node on the
// laptop the motion rig ran on, against 1us for a built formatter's format.
// Every row and every stamp is labelled through here, and decorate() relabels
// every stamp in the thread on every frame it applies, so a history page of 25
// landing on a few hundred rows spent about half of its insert in these two
// functions (the rig's CPU profile of the scroll-back, tools/motionrig). The
// strings are unchanged: a formatter built from the same options is what those
// two methods build inside, and the tests compare the two outright.
//
// The set is rebuilt once it is a minute old. A built formatter keeps the time
// zone it was built in, so a phone that changes zone with the app left open
// relabels within the minute instead of never.

export const LABEL_FORMATS_TTL_MS = 60_000;

interface LabelFormats {
  built: number;
  time: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
  day: Intl.DateTimeFormat;
  dayYear: Intl.DateTimeFormat;
}

let formats: LabelFormats | null = null;

/** the built set, rebuilt by the wall clock once it is a minute old */
function labelFormats(): LabelFormats {
  const now = Date.now();
  if (!formats || now - formats.built > LABEL_FORMATS_TTL_MS) {
    formats = {
      built: now,
      time: new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }),
      weekday: new Intl.DateTimeFormat([], { weekday: "long" }),
      day: new Intl.DateTimeFormat([], { month: "short", day: "numeric" }),
      dayYear: new Intl.DateTimeFormat([], { month: "short", day: "numeric", year: "numeric" }),
    };
  }
  return formats;
}

/** a row's time of day, "2:31 PM" in the phone's own locale */
export function fmtTime(ms: number): string {
  return labelFormats().time.format(ms);
}

/** a stamp's day: Today, Yesterday, a weekday this week, else the date */
export function fmtStampDay(ms: number, now: Date = new Date()): string {
  const d = new Date(ms);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const f = labelFormats();
  if (days < 7) return f.weekday.format(d);
  return (d.getFullYear() === now.getFullYear() ? f.day : f.dayYear).format(d);
}

/** the two nodes a stamp is made of, as far as this check needs them */
interface StampNode {
  nodeName: string;
  textContent: string | null;
}

/**
 * Does this stamp already read `day` in bold and then `time`? decorate() asks
 * before it rebuilds one: the fold runs over every wrapper on every applied
 * frame, and rebuilding a stamp that already says the right thing is a DOM
 * mutation per stamp per frame, which style, layout and the hold's mutation
 * observer each pay for, for a picture that does not change.
 */
export function stampReads(stamp: { childNodes: ArrayLike<StampNode> }, day: string, time: string): boolean {
  const nodes = stamp.childNodes;
  return (
    nodes.length === 2 &&
    nodes[0].nodeName === "B" &&
    nodes[0].textContent === day &&
    nodes[1].nodeName === "#text" &&
    nodes[1].textContent === time
  );
}
