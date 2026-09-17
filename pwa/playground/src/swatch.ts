// The sent-bubble colour control's own logic: reading a typed hex value, and
// keeping the swatch, the native picker and the hex field all saying the same
// thing.
//
// It is split out the way src/drawer.ts splits swipeVerdict from mountDrawer:
// the parse and the three-way sync are pure and are pinned in
// tests/swatch.test.ts against element stand-ins, exactly as tests/ pins the
// rest of this tool, while controls.ts does the DOM wiring and playground.ts
// drives the colour onto the thread. Nothing here reaches for `document`.

/**
 * The sent bubbles' colour when nothing has been chosen is the app's own accent
 * - and the accent lives in the STYLESHEET, as bubbles.css's --accent. The
 * wiring reads the computed value at start-up and hands it in (playground.ts),
 * so the default follows the sheet rather than a copy of it kept here: when the
 * accent is repainted, the control's default and its reset move with it, with no
 * second place to remember.
 *
 * This literal is only the stand-in for the case where there is no stylesheet to
 * read - a node test, or a page whose CSS has not arrived - and it is kept equal
 * to the accent bubbles.css declares so the stand-in is never a different
 * colour.
 */
export const FALLBACK_SENT = "#4538ff";

/** the class and the aria state that say, quietly, that the field is not yet a
    colour. tool.css paints .hexinput.bad; the attribute is for a screen reader. */
export const BAD_CLASS = "bad";

/**
 * Read a typed colour. Accepts 3 or 6 hex digits, with or without a leading
 * "#", in either case, and returns it normalised to lower-case #rrggbb. Anything
 * else - a part-typed value, a digit out of range, the wrong length, an empty
 * string - is not a colour and returns null, so a half-finished entry applies
 * nothing and disturbs no current colour.
 */
export function normaliseHex(input: string): string | null {
  if (typeof input !== "string") return null;
  const body = input.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;
  if (body.length === 3) {
    const [r, g, b] = body;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (body.length === 6) return `#${body}`.toLowerCase();
  return null;
}

/** the members these helpers read and write on a value carrier: a real <input>,
    or a stand-in with the same shape */
export interface ValueField {
  value: string;
}
/** the hex field also carries the quiet not-accepted mark */
export interface HexField extends ValueField {
  classList: { toggle(token: string, force?: boolean): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function mark(hex: HexField, bad: boolean): void {
  hex.classList.toggle(BAD_CLASS, bad);
  if (bad) hex.setAttribute("aria-invalid", "true");
  else hex.removeAttribute("aria-invalid");
}

/**
 * The native picker moved. It always hands back a whole #rrggbb, so mirror it
 * into the hex field, clear any mark, and return the colour to apply.
 */
export function syncFromPicker(picker: ValueField, hex: HexField): string {
  const colour = normaliseHex(picker.value) ?? FALLBACK_SENT;
  hex.value = colour;
  mark(hex, false);
  return colour;
}

/**
 * A keystroke in the hex field. A complete colour applies live and the picker
 * follows it; the field itself is left EXACTLY as typed - it is normalised only
 * on commit, so the caret is never moved out from under the reader. A part-typed
 * or wrong value applies nothing, leaves the picker and the colour where they
 * are, and marks the field. Returns the colour to apply, or null to leave the
 * colour in force alone.
 */
export function syncFromHexInput(hex: HexField, picker: ValueField): string | null {
  const colour = normaliseHex(hex.value);
  if (colour === null) {
    mark(hex, true);
    return null;
  }
  picker.value = colour;
  mark(hex, false);
  return colour;
}

/**
 * Blur or Enter. A good value is normalised to #rrggbb in place; a part-typed or
 * wrong one is dropped and the field returns to the colour in force. Either way
 * the mark is cleared and the picker is brought back into step. Returns the
 * colour now in force, which is what the caller persists.
 */
export function commitHex(hex: HexField, picker: ValueField, current: string): string {
  const colour = normaliseHex(hex.value) ?? current;
  hex.value = colour;
  picker.value = colour;
  mark(hex, false);
  return colour;
}
