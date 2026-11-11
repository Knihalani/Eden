import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextItem } from "@eden/protocol";
import { renderPacket, type Part } from "./render";
import { PartTrimmer, TRIM_MODEL_PATH } from "./trim";

const item = (id: string, title: string, text: string): ContextItem => ({
  id,
  sourceId: "gmail",
  ref: id,
  title,
  text,
  updatedAt: Date.parse("2026-10-26T00:00:00Z"),
});

const TEXT =
  "From: Dean Harlow\nDate: Sat, 24 Oct 2026 09:00\n\nRobin, someone got into my inbox this week. If anything turns " +
  "up from me asking you to use a different sort code, it's NOT me. Ring me on 07700 900481 before you send " +
  "anything. Sorry for the hassle, tiles go down Monday.";
const focus = new Set(["pay", "dean", "invoice", "tiles"]);

/** A scorer that keeps the parts holding one of `words`. */
const keeping =
  (...words: string[]) =>
  (_title: string, parts: readonly Part[]) => ({
    scores: parts.map((p) => (words.some((w) => p.text.includes(w)) ? 0.9 : 0.1)),
    threshold: 0.5,
  });

describe("packetTrim in renderPacket (D920)", () => {
  test("keeps only the parts the trimmer scores at or above its threshold, gaps marked", () => {
    const out = renderPacket([item("m1", "heads up", TEXT)], { maxBytes: 1200, focus, trim: keeping("NOT me") });
    const line = out.split("\n").find((l) => l.startsWith("- ["))!;
    expect(line).toContain("it's NOT me");
    expect(line).not.toContain("tiles go down");
    expect(line).not.toContain("Ring me");
  });

  test("is subtractive: a part pick left out stays out whatever its score", () => {
    const long = `${TEXT} ${"Unrelated filler about the garden fence and the paint colour. ".repeat(8)}`;
    // At 60 bytes an item, pick keeps one part; the trimmer's favourite is not it.
    const picked = renderPacket([item("m1", "heads up", long)], { maxBytes: 1200, focus, itemBytes: 60 });
    const trimmed = renderPacket([item("m1", "heads up", long)], {
      maxBytes: 1200,
      focus,
      itemBytes: 60,
      trim: keeping("garden fence", "tiles"),
    });
    const body = (s: string) => s.split("\n").find((l) => l.startsWith("- ["))!;
    for (const w of body(trimmed)
      .replace(/^- \[gmail\] heads up: /, "")
      .split(/ … | /))
      expect(body(picked)).toContain(w);
  });

  test("an item with nothing kept is said by its title alone, with no colon", () => {
    const out = renderPacket([item("m1", "heads up", TEXT)], { maxBytes: 1200, focus, trim: keeping("zzz") });
    expect(out.split("\n")).toContain("- [gmail] heads up");
  });

  test("a scorer that returns null leaves pick's text", () => {
    const off = renderPacket([item("m1", "heads up", TEXT)], { maxBytes: 1200, focus });
    const on = renderPacket([item("m1", "heads up", TEXT)], { maxBytes: 1200, focus, trim: () => null });
    expect(on).toBe(off);
  });
});

describe("PartTrimmer", () => {
  test("fails open: a missing or unreadable weights file gives no trimmer", () => {
    const dir = mkdtempSync(join(tmpdir(), "trim-"));
    expect(PartTrimmer.load(join(dir, "none.json"))).toBeNull();
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(PartTrimmer.load(join(dir, "bad.json"))).toBeNull();
    writeFileSync(join(dir, "other.json"), JSON.stringify({ arch: "something-else" }));
    expect(PartTrimmer.load(join(dir, "other.json"))).toBeNull();
  });

  test("a linear model scores parts from its hashed and dense weights", () => {
    const dir = mkdtempSync(join(tmpdir(), "trim-"));
    const buckets = 1 << 10;
    const dense = new Array(27).fill(0);
    dense[17] = 4; // the status-word share: "NOT", "before" carry it
    const m = {
      arch: "lr",
      buckets,
      weights: Buffer.alloc(buckets).toString("base64"),
      scale: 1,
      dense,
      bias: -1,
      threshold: 0.5,
    };
    writeFileSync(join(dir, "lr.json"), JSON.stringify(m));
    const t = PartTrimmer.load(join(dir, "lr.json"))!;
    const parts: Part[] = [
      { text: "it's NOT me, don't pay it", quoted: false, header: false },
      { text: "tiles go down Monday", quoted: false, header: false },
    ];
    const s = t.score("pay Dean's invoice", "heads up", parts);
    expect(s[0]!).toBeGreaterThan(0.5);
    expect(s[1]!).toBeLessThan(0.5);
  });

  // The shipped weights carry the trainer's own scores for 64+ val parts (cands.py's export): the TypeScript forward
  // must give the same keep decisions (the parity the bar requires) and scores within float error.
  test.if(existsSync(TRIM_MODEL_PATH))("the shipped model agrees with its trainer on its parity parts", () => {
    const m = JSON.parse(readFileSync(TRIM_MODEL_PATH, "utf8")) as {
      threshold: number;
      checks: { request: string; title: string; parts: [string, number][]; scores: number[] }[];
    };
    const t = PartTrimmer.load()!;
    let n = 0;
    for (const c of m.checks) {
      const parts = c.parts.map(([text, f]) => ({ text, quoted: (f & 1) === 1, header: (f & 2) === 2 }));
      const got = t.score(c.request, c.title, parts);
      for (let k = 0; k < parts.length; k++, n++) {
        expect(got[k]! >= m.threshold).toBe(c.scores[k]! >= m.threshold);
        expect(Math.abs(got[k]! - c.scores[k]!)).toBeLessThan(1e-5);
      }
    }
    expect(n).toBeGreaterThanOrEqual(64);
  });
});
