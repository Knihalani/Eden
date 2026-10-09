/**
 * The record, the arms and the gate files agree: every A5 §4 arm is implemented, recorded with a measured state for
 * each of its flag runs, cites a slice of PROGRESS.md, and is in exactly one group of test files.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLAG_SAMPLES, GROUPS } from "./groups";
import { loadRecord } from "./record";
import { ARMS } from "./registry";

const record = loadRecord();
const PROGRESS = readFileSync(join(import.meta.dir, "../../../docs/memory-ship/PROGRESS.md"), "utf8");

describe("arms.json", () => {
  test("holds the 45 arms of A5 §4, each implemented once", () => {
    const ids = record.arms.map((arm) => arm.id);
    expect(ids.length).toBe(45);
    expect(new Set(ids).size).toBe(45);
    expect([...ARMS.keys()].sort()).toEqual([...ids].sort());
  });

  test("an arm with a delivery point records its off and shadow runs; the others do not", () => {
    for (const entry of record.arms) {
      const flagged = ARMS.get(entry.id)!.flagged;
      expect({ id: entry.id, off: entry.off !== undefined, shadow: entry.shadow !== undefined }).toEqual({
        id: entry.id,
        off: flagged,
        shadow: flagged,
      });
    }
  });

  test("every red state lists its failing checks and why; a green one lists none", () => {
    for (const entry of record.arms) {
      for (const state of [entry.on, entry.off, entry.shadow]) {
        if (!state) continue;
        if (state.state === "red") {
          expect({ id: entry.id, failed: (state.failed ?? []).length > 0, why: Boolean(state.why) }).toEqual({
            id: entry.id,
            failed: true,
            why: true,
          });
        } else expect({ id: entry.id, failed: state.failed ?? [] }).toEqual({ id: entry.id, failed: [] });
      }
    }
  });

  test("every arm cites slices of PROGRESS.md and one of A5 §4's four groups", () => {
    for (const entry of record.arms) {
      expect(["floor", "place", "delivery", "cues"]).toContain(entry.group);
      expect(entry.slices.length).toBeGreaterThan(0);
      for (const slice of entry.slices) expect(PROGRESS).toContain(`| ${slice} |`);
    }
  });
});

describe("the test files", () => {
  test("group every arm exactly once, each group with a flag sample, a gate file and a reference file", () => {
    const all = Object.values(GROUPS).flat();
    expect(all.length).toBe(new Set(all).size);
    expect([...all].sort()).toEqual(record.arms.map((arm) => arm.id).sort());
    for (const [group, id] of Object.entries(FLAG_SAMPLES)) {
      expect({ group, inGroup: GROUPS[group]?.includes(id), flagged: ARMS.get(id)?.flagged }).toEqual({
        group,
        inGroup: true,
        flagged: true,
      });
    }
    expect(Object.keys(FLAG_SAMPLES).sort()).toEqual(Object.keys(GROUPS).sort());
    const files = readdirSync(import.meta.dir);
    for (const group of Object.keys(GROUPS)) {
      expect(files).toContain(`${group}.gate.test.ts`);
      expect(files).toContain(`${group}.reference.test.ts`);
    }
  });
});
