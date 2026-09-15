// The historical copies, against the hashes the history helper's manifest
// recorded for them.
//
// src/history holds nine modules that are not this tool's work: they are the
// springscroll.ts and endspring.ts of eight pushed commits, copied so Vite can
// serve them without reaching outside the app. The entire claim the build picker
// makes rests on those copies being the pushed bytes, so it is checked here
// rather than asserted in a comment:
//
//   - every copy's SHA-256 and length equal the ones the manifest recorded for
//     the file it came from;
//   - the live baseline really is 0.3.151's file, so listing it once rather than
//     twice is a fact and not a shortcut;
//   - the picker's own table is internally whole: every distinct pushed spring
//     has an entry, no two entries claim the same physics state, every slider an
//     entry offers is one that build's factory takes, and the experimental entry
//     claims no history at all.
//
// REPOINTED WHEN THE PLAYGROUND MOVED INTO THE REPOSITORY.
//
// This file used to read reference/history/manifest.json and
// reference/history/preset-map.json, two read-only evidence files produced by a
// different worker and kept in a tree beside the standalone tool. That tree did
// not move here, so the hashes and lengths it recorded are written out below as
// literals instead, which is the same discipline fieldparity.test.ts already
// uses for the three vendored modules. They were verified against the manifest
// at the moment they were copied in, and from here on they are what a drifted
// copy would fail against.
//
// FOUR CHECKS ARE GONE, and none of them could be honestly kept. They compared
// what presets.ts says about a build - its snapshot id, version and commit, the
// constants it documents, the run of commits that carry it - against the same
// facts in those two evidence files. With the evidence gone the comparison
// would be presets.ts against presets.ts, which proves nothing; writing the
// tables out as literals would be copying one file's contents into another and
// calling the copy a witness. What survives from them is the part that stands on
// its own: the count of distinct physics states, and the 48 commits the entries
// account for between them.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CONFIGS, CONTROLLER_ONLY, configFor } from "../src/presets";
import type { ConfigEntry, SpringKind } from "../src/presets";

/** what the manifest recorded for the file each copy was taken from */
interface Pin {
  /** where the copy lives in this app */
  file: string;
  /** the snapshot it was taken from, as the manifest names it */
  snapshot: string;
  sha256: string;
  bytes: number;
}

const SPRING_SOURCE: Record<SpringKind, Pin> = {
  current: {
    file: "src/vendor/springscroll.ts",
    snapshot: "0.3.151-4c865ac",
    sha256: "793369f0430d607932454225c8cb7b1c861c49f49f63c892354a099a05a4b995",
    bytes: 53152,
  },
  s121: {
    file: "src/history/spring-0-3-121.ts",
    snapshot: "0.3.121-15c40a0",
    sha256: "4e60b3655c882fd930c6a60729b180098d09c0416970692a34b4cb70586d5e24",
    bytes: 12910,
  },
  s123: {
    file: "src/history/spring-0-3-123.ts",
    snapshot: "0.3.123-57087ce",
    sha256: "0b401ef2d5e4a45f33b53c8041b6a2fd8a744945cfb4380be6d9ac8b3ef648dd",
    bytes: 18842,
  },
  s124: {
    file: "src/history/spring-0-3-124.ts",
    snapshot: "0.3.124-af9a455",
    sha256: "baba7027614f2f7b2b608e50d9e35aa00d39d920a15b41fe162b0125c49a5f55",
    bytes: 15924,
  },
  s132: {
    file: "src/history/spring-0-3-132.ts",
    snapshot: "0.3.132-299e90b",
    sha256: "ee948ad7816c645ebc50576477145715a5b1cdcb347e1ed1112642fe0fc25e78",
    bytes: 16083,
  },
  s134: {
    file: "src/history/spring-0-3-134.ts",
    snapshot: "0.3.134-8bb06a7",
    sha256: "1fab52aaa679d87f89cae96d64c8a1be586b3c061f56bc4f269525f6be69cc8a",
    bytes: 23307,
  },
  s140: {
    file: "src/history/spring-0-3-140.ts",
    snapshot: "0.3.140-0bec0ec",
    sha256: "c2d3e0c6d620e2ea574f165a6a261519f1b97fdc3b1559afedd26ad588580d23",
    bytes: 24278,
  },
  s141: {
    file: "src/history/spring-0-3-141.ts",
    snapshot: "0.3.141-b644dd9",
    sha256: "3a98c200a7cf0ad1c025dee690522a8263967eb07df297467848c9cce8c79572",
    bytes: 27861,
  },
  s148: {
    file: "src/history/spring-0-3-148.ts",
    snapshot: "0.3.148-418188c",
    sha256: "d9d5804945081000087e54db322973ed51a1a560015858d88c03b76ac8164163",
    bytes: 43244,
  },
};

const END_SOURCE: Record<string, Pin> = {
  "end-initial": {
    file: "src/history/end-initial.ts",
    snapshot: "0.3.132-a94ab0a",
    sha256: "f4050f2da02ac018ebe60cf4e515eacb3e270ee770eb528bd899abe2b5ccb7b8",
    bytes: 18548,
  },
  "end-catch": {
    file: "src/history/end-catch.ts",
    snapshot: "0.3.132-299e90b",
    sha256: "8162e291a494aad24e6d2e59c5c93ed11f47789310f3d45b084ac9768c424257",
    bytes: 19430,
  },
  "end-reseat": {
    file: "src/vendor/endspring.ts",
    snapshot: "0.3.151-4c865ac",
    sha256: "b426e05fb9feb7053082efd18f128cdd259ea7d062cc82d0a6f51672745428fb",
    bytes: 20265,
  },
};

const root = new URL("../", import.meta.url);

function bytesOf(pin: Pin): Uint8Array {
  return readFileSync(new URL(pin.file, root));
}

function sha(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("the copied history is the pushed history", () => {
  it("every spring module matches its recorded SHA-256, byte for byte", () => {
    for (const [kind, pin] of Object.entries(SPRING_SOURCE)) {
      const data = bytesOf(pin);
      expect(sha(data), `${kind} (${pin.file}, from ${pin.snapshot})`).toBe(pin.sha256);
      expect(data.length, `${kind} (${pin.file})`).toBe(pin.bytes);
    }
  });

  it("every end module matches too, including the two older rubber bands", () => {
    for (const [id, pin] of Object.entries(END_SOURCE)) {
      const data = bytesOf(pin);
      expect(sha(data), id).toBe(pin.sha256);
      expect(data.length, id).toBe(pin.bytes);
    }
  });

  it("the live baseline IS 0.3.151's spring, which is why it is listed once", () => {
    expect(sha(bytesOf(SPRING_SOURCE.current))).toBe(SPRING_SOURCE.current.sha256);
    expect(SPRING_SOURCE.current.snapshot).toBe("0.3.151-4c865ac");
    // and no entry claims to be a separate historical build on the same modules
    const live148 = CONFIGS.filter((c) => c.spring === "current" && !c.experimental);
    expect(live148.map((c) => c.id)).toEqual(["live"]);
  });

  it("every distinct pushed spring implementation has an entry using it", () => {
    const used = new Set(CONFIGS.map((c) => c.spring));
    expect([...used].sort()).toEqual(
      ["current", "s121", "s123", "s124", "s132", "s134", "s140", "s141", "s148"].sort(),
    );
  });

  it("and every entry's modules are ones this app actually carries", () => {
    for (const c of CONFIGS) {
      expect(SPRING_SOURCE[c.spring], `${c.id} names spring ${c.spring}`).toBeDefined();
      if (c.end !== "none") {
        expect(END_SOURCE[c.end], `${c.id} names end model ${c.end}`).toBeDefined();
      }
    }
  });
});

describe("the picker's table is whole", () => {
  const shipped = CONFIGS.filter((c) => !c.experimental);

  it("no two entries claim the same physics state, and all eleven are there", () => {
    const seen = new Set<string>();
    for (const c of shipped) {
      expect(seen.has(c.state), `${c.state} is claimed twice`).toBe(false);
      seen.add(c.state);
    }
    // ten historical entries plus the live build, which is the eleventh
    expect(seen.size).toBe(11);
  });

  it("accounts for all 48 pushed commits between them", () => {
    let total = 0;
    for (const c of shipped) total += c.aliases.length;
    expect(total).toBe(48);
  });

  it("every slider an entry offers is one that build's factory takes", () => {
    // the constants a build documents are the only place a slider may point:
    // offering Gap strain on a build with no GAP_STRAIN_PX would be a control
    // that silently does nothing
    const needs: Record<string, string> = {
      "field.tau": "LAG_TAU_MS",
      "field.divisor": "RESISTANCE_DIVISOR",
      "field.strain": "GAP_STRAIN_PX",
    };
    for (const c of CONFIGS) {
      for (const k of c.knobs) {
        expect(c.constants[needs[k]], `${c.id} offers ${k}`).toBeTypeOf("number");
        expect(c.values[k], `${c.id} offers ${k} with no documented value`).toBe(
          c.constants[needs[k]],
        );
      }
      // and the ones it does NOT offer are the ones it does not have
      for (const [k, name] of Object.entries(needs)) {
        if (c.knobs.includes(k as keyof typeof needs as never)) continue;
        expect(c.constants[name], `${c.id} hides ${k} but has ${name}`).toBeUndefined();
      }
    }
  });

  it("the experimental entry claims no version, commit or snapshot", () => {
    const x = configFor("travelling");
    expect(x.experimental).toBe(true);
    expect(x.version).toBe("");
    expect(x.commit).toBe("");
    expect(x.snapshot).toBe("");
    expect(x.aliases).toEqual([]);
  });

  it("the seven controller-only changes are named and not offered as builds", () => {
    expect(CONTROLLER_ONLY).toHaveLength(7);
    const ids = new Set(CONFIGS.map((c: ConfigEntry) => `${c.version} ${c.commit.slice(0, 7)}`));
    for (const v of CONTROLLER_ONLY) {
      // they may coincide with an entry's own commit (4c865ac is both), but
      // none of them is a separate selectable build
      expect(CONFIGS.some((c) => c.label === v.what)).toBe(false);
    }
    expect(ids.size).toBeGreaterThan(0);
  });
});
