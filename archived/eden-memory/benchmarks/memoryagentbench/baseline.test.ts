import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryInjectSwallows, openMemory } from "../../src/index";

const BASELINE = readFileSync(join(import.meta.dir, "BASELINE.md"), "utf8");
const M14_SECTION = BASELINE.split(/\n## M6\.4 remeasure/)[0] ?? "";
const M64_SECTION = BASELINE.includes("\n## M6.4 remeasure")
  ? BASELINE.slice(BASELINE.indexOf("\n## M6.4 remeasure") + 1)
  : "";

function num(src: string, label: RegExp, missing = `missing ${label}`): number {
  const m = src.match(label);
  expect(m, `BASELINE.md ${missing}`).toBeTruthy();
  const n = Number(m![1]);
  expect(Number.isFinite(n), `BASELINE.md ${label} not numeric`).toBe(true);
  return n;
}

describe("M1.4 inject baseline artifact", () => {
  test("BASELINE.md has dated p50/p95/bytes/jsonl-n/swallows", () => {
    expect(BASELINE).toContain("2026-09-16");
    expect(M14_SECTION).toContain("# AgentMemory inject baseline (M1.4)");
    const p50 = num(BASELINE, /inject p50 \(ms\)\s*\|\s*(\d+(?:\.\d+)?)/);
    const p95 = num(BASELINE, /inject p95 \(ms\)\s*\|\s*(\d+(?:\.\d+)?)/);
    const bytes = num(BASELINE, /persist bytes\s*\|\s*(\d+)/);
    const jsonlN = num(BASELINE, /JSONL n\s*\|\s*(\d+)/);
    const happy = num(BASELINE, /swallows \(happy path\)\s*\|\s*(\d+)/);
    const forced = num(BASELINE, /swallows \(forced throw\)\s*\|\s*(\d+)/);
    expect(p50).toBeGreaterThanOrEqual(0);
    expect(p50).toBe(0.088);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(p95).toBe(0.233);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBe(765);
    expect(jsonlN).toBeGreaterThan(0);
    expect(jsonlN).toBe(4);
    expect(happy).toBe(0);
    expect(forced).toBe(1);
    expect(BASELINE).toMatch(/fail-open stays/i);
    expect(BASELINE).toMatch(/M11.{0,8}compares against this file/i);
  });

  test("inject catch fail-opens: notesFor throw returns original messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m14-failopen-"));
    try {
      const mem = openMemory({ dir });
      const list = [{ role: "user", content: "Kai's timezone is Pacific." }];
      const before = memoryInjectSwallows.n;
      mem.notesFor = (() => {
        throw new Error("m1.4 fail-open probe");
      }) as typeof mem.notesFor;
      const out = mem.inject(list);
      expect(out).toBe(list);
      expect(out).toEqual([{ role: "user", content: "Kai's timezone is Pacific." }]);
      expect(memoryInjectSwallows.n).toBe(before + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M6.4 remeasure artifact", () => {
  test("BASELINE.md keeps M1.4 and has dated M6.4 p50/p95/bytes/jsonl-n/swallows", () => {
    expect(M14_SECTION.length, "M1.4 section deleted").toBeGreaterThan(0);
    expect(M14_SECTION).toContain("# AgentMemory inject baseline (M1.4)");
    expect(M14_SECTION).toContain("2026-09-16");
    expect(M14_SECTION).toMatch(/inject p50 \(ms\)\s*\|\s*0\.088\s*\|/);
    expect(BASELINE).toContain("## M6.4 remeasure (after M2–M5)");
    expect(M64_SECTION.length, "M6.4 section missing").toBeGreaterThan(0);
    expect(M64_SECTION).toContain("2026-09-17");
    expect(M64_SECTION).toMatch(/EDEN_MEMORY_CAP[\s`]+unset/i);
    expect(M64_SECTION).toMatch(/\*\*N:\*\*\s*80/);
    const p50 = num(M64_SECTION, /inject p50 \(ms\)\s*\|\s*0\.088\s*\|\s*(\d+(?:\.\d+)?)/, "M6.4 p50");
    const p95 = num(M64_SECTION, /inject p95 \(ms\)\s*\|\s*0\.233\s*\|\s*(\d+(?:\.\d+)?)/, "M6.4 p95");
    const bytes = num(M64_SECTION, /persist bytes\s*\|\s*765\s*\|\s*(\d+)/, "M6.4 bytes");
    const jsonlN = num(M64_SECTION, /JSONL n\s*\|\s*4\s*\|\s*(\d+)/, "M6.4 JSONL n");
    const happy = num(M64_SECTION, /swallows \(happy path\)\s*\|\s*0\s*\|\s*(\d+)/, "M6.4 happy swallows");
    const forced = num(M64_SECTION, /swallows \(forced throw\)\s*\|\s*1\s*\|\s*(\d+)/, "M6.4 forced swallows");
    expect(p50).toBeGreaterThanOrEqual(0);
    expect(p95).toBeGreaterThanOrEqual(p50);
    expect(bytes).toBeGreaterThan(0);
    expect(jsonlN).toBeGreaterThan(0);
    expect(happy).toBe(0);
    expect(forced).toBe(1);
    expect(M64_SECTION).toMatch(/not a SOTA claim/i);
  });
});
