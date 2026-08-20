// Pins for lazy history photos (src/photolazy.ts). The rule the thread depends
// on: a photo far from the screen has NO source, so it opens no connection at
// all, and the source goes on when the reader comes near it. The ledger touches
// only an image's src and its class list, so it is pinned against a minimal
// image fake, no DOM and no network needed. The proximity signal itself is
// DOM wiring (an IntersectionObserver rooted on the thread, in main.ts) and is
// stood in for here by the watch callback the ledger is built with.
import { describe, expect, it } from "vitest";
import {
  NEAR_MIN_PX,
  NEAR_SCREENS,
  type Photo,
  WAIT_CLASS,
  createPhotoQueue,
  nearMargin,
} from "../src/photolazy";

class FakeImg implements Photo {
  src = "";
  private classes = new Set<string>();
  classList = {
    add: (c: string): void => {
      this.classes.add(c);
    },
    remove: (c: string): void => {
      this.classes.delete(c);
    },
  };
  waiting(): boolean {
    return this.classes.has(WAIT_CLASS);
  }
}

// a queue with a recording proximity watcher: everything it is handed is what
// the real observer would have been told to watch
function queue() {
  const watched: FakeImg[] = [];
  const q = createPhotoQueue<FakeImg>((img) => watched.push(img));
  return { q, watched };
}

const URL_A = "/api/thumb/a.jpg?token=t";
const URL_B = "/api/thumb/b.jpg?token=t";

describe("a photo far from the screen never starts downloading", () => {
  it("holds the url instead of putting it on the image", () => {
    const { q, watched } = queue();
    const img = new FakeImg();
    q.hold(img, URL_A);
    expect(img.src).toBe(""); // THE rule: nothing is fetched
    expect(q.holding()).toBe(1);
    expect(watched).toEqual([img]); // handed to the proximity signal
  });

  it("a whole thread of history opens no connections at all", () => {
    const { q } = queue();
    const imgs = Array.from({ length: 40 }, () => new FakeImg());
    for (const img of imgs) q.hold(img, URL_A);
    expect(imgs.every((i) => i.src === "")).toBe(true);
    expect(q.holding()).toBe(40);
  });

  it("wears the waiting mark from the frame its row is built", () => {
    const { q } = queue();
    const img = new FakeImg();
    q.hold(img, URL_A);
    expect(img.waiting()).toBe(true); // the grey box with the ring in it
  });

  it("an empty url parks nothing and marks nothing", () => {
    const { q, watched } = queue();
    const img = new FakeImg();
    q.hold(img, "");
    expect(q.holding()).toBe(0);
    expect(img.waiting()).toBe(false);
    expect(watched).toEqual([]);
  });
});

describe("coming near sets the source", () => {
  it("release puts the parked url on the image", () => {
    const { q } = queue();
    const img = new FakeImg();
    q.hold(img, URL_A);
    expect(q.release(img)).toBe(true);
    expect(img.src).toBe(URL_A); // THE rule: near = loading
    expect(q.holding()).toBe(0);
  });

  it("each photo gets its own url back, not a neighbour's", () => {
    const { q } = queue();
    const a = new FakeImg();
    const b = new FakeImg();
    q.hold(a, URL_A);
    q.hold(b, URL_B);
    q.release(b);
    expect(b.src).toBe(URL_B);
    expect(a.src).toBe(""); // the one still far away is untouched
  });

  it("releases once: a second signal for the same photo does nothing", () => {
    const { q } = queue();
    const img = new FakeImg();
    q.hold(img, URL_A);
    q.release(img);
    img.src = "already-loading";
    expect(q.release(img)).toBe(false);
    expect(img.src).toBe("already-loading"); // never re-set behind the load
  });

  it("a photo that was never held is not this ledger's business", () => {
    const { q } = queue();
    const img = new FakeImg();
    expect(q.release(img)).toBe(false);
    expect(img.src).toBe("");
  });

  it("the reader passing three photos leaves the rest untouched", () => {
    const { q } = queue();
    const imgs = Array.from({ length: 40 }, () => new FakeImg());
    for (const img of imgs) q.hold(img, URL_A);
    for (const img of imgs.slice(0, 3)) q.release(img);
    expect(imgs.filter((i) => i.src === "").length).toBe(37);
    expect(q.holding()).toBe(37);
  });
});

describe("the grey box comes off when the picture does (or does not) arrive", () => {
  it("pixels landing clear the waiting mark", () => {
    const { q } = queue();
    const img = new FakeImg();
    q.hold(img, URL_A);
    q.release(img);
    expect(img.waiting()).toBe(true); // still grey while it is on the wire
    q.arrived(img);
    expect(img.waiting()).toBe(false);
  });

  it("a failed fetch clears it too, so no box is left spinning forever", () => {
    const { q } = queue();
    const img = new FakeImg();
    q.hold(img, URL_A);
    q.release(img);
    q.arrived(img); // main.ts calls this from onerror as well as onload
    expect(img.waiting()).toBe(false);
    expect(q.holding()).toBe(0);
  });

  it("an arrival drops the photo from the ledger even if it never released", () => {
    const { q } = queue();
    const img = new FakeImg();
    q.hold(img, URL_A);
    q.arrived(img);
    expect(q.holding()).toBe(0);
    expect(q.release(img)).toBe(false);
  });
});

describe("a fresh shell starts empty", () => {
  it("reset forgets the old thread's parked photos", () => {
    const { q } = queue();
    const img = new FakeImg();
    q.hold(img, URL_A);
    q.reset();
    expect(q.holding()).toBe(0);
    expect(q.release(img)).toBe(false); // its DOM is gone; nothing to load into
  });
});

describe("a browser with no proximity signal loads the old way", () => {
  it("puts every source on immediately", () => {
    const q = createPhotoQueue<FakeImg>(null);
    const img = new FakeImg();
    q.hold(img, URL_A);
    expect(img.src).toBe(URL_A); // nothing can tell us where the reader is
    expect(q.holding()).toBe(0);
  });

  it("still shows the grey box until the pixels land", () => {
    const q = createPhotoQueue<FakeImg>(null);
    const img = new FakeImg();
    q.hold(img, URL_A);
    expect(img.waiting()).toBe(true);
    q.arrived(img);
    expect(img.waiting()).toBe(false);
  });
});

describe("near means one screen of the thread's own height", () => {
  it("is one screen, named, not a browser heuristic", () => {
    expect(NEAR_SCREENS).toBe(1);
    expect(nearMargin(844)).toBe(844); // iPhone 13/14 portrait
    expect(nearMargin(667)).toBe(667);
  });

  it("scales with the screen rather than sitting at a fixed pixel count", () => {
    expect(nearMargin(1200)).toBe(Math.round(1200 * NEAR_SCREENS));
    expect(nearMargin(1200)).toBeGreaterThan(nearMargin(844));
  });

  it("an unmeasurable thread still reads ahead, never zero", () => {
    expect(nearMargin(0)).toBe(NEAR_MIN_PX);
    expect(nearMargin(10)).toBe(NEAR_MIN_PX);
    expect(NEAR_MIN_PX).toBeGreaterThan(0);
  });
});
