import { describe, expect, test } from "bun:test";
import { reportPairs } from "./pi-ab-pairs";

describe("report condition pairs", () => {
  test("each trial flag gets its exact baseline beside the existing root comparison", () => {
    for (const flag of ["pushCheckedWhy", "packetCoversLine", "pushUnsureAskNudge", "edenGuide"]) {
      for (const base of ["hermes+eden", "both", "both+ask"]) {
        const condition = `${base}+${flag}`;
        const pairs = reportPairs([base, condition]);
        expect(pairs).toContainEqual([condition, base]);
        expect(pairs).toContainEqual([condition, base.startsWith("hermes") ? "hermes" : "both"]);
        expect(pairs.filter(([a, b]) => a === condition && b === base)).toHaveLength(1);
      }
    }
  });

  test("preserves variants, act and wait settings when removing only the last flag", () => {
    for (const [condition, baseline] of [
      ["hermes+eden~trial+edenGuide@w0", "hermes+eden~trial@w0"],
      ["both-act~trial+ask+edenGuide@w3000", "both-act~trial+ask@w3000"],
      ["both+ask+edenGuide~trial@w40", "both+ask~trial@w40"],
    ] as const) {
      expect(reportPairs([condition, baseline])).toContainEqual([condition, baseline]);
    }
    const condition = "both+ask+edenGuide+packetCoversLine";
    const pairs = reportPairs([condition, "both+ask+edenGuide", "both+ask", "both"]);
    expect(pairs).toContainEqual([condition, "both+ask+edenGuide"]);
    expect(pairs).not.toContainEqual([condition, "both+ask"]);
  });

  test("does not invent a last-flag baseline or substitute a different wait or variant", () => {
    const condition = "hermes+eden~trial+edenGuide@w40";
    const pairs = reportPairs([condition, "hermes+eden~trial@w0", "hermes+eden~other@w40"]);
    expect(pairs).toContainEqual([condition, "hermes@w40"]);
    expect(pairs).not.toContainEqual([condition, "hermes+eden~trial@w40"]);
    expect(pairs).not.toContainEqual([condition, "hermes+eden~trial@w0"]);
    expect(pairs).not.toContainEqual([condition, "hermes+eden~other@w40"]);
    expect(reportPairs(["both", "both+ask+edenGuide"])).not.toContainEqual(["both+ask+edenGuide", "both+ask"]);
  });

  test("deduplicates added pairs and preserves initial comparisons without mutating them", () => {
    const initial = [
      ["eden", "tools"],
      ["both+edenGuide", "both"],
    ] as const;
    const before = structuredClone(initial);
    expect(reportPairs(["both", "both+edenGuide", "both+edenGuide"], initial)).toEqual(
      initial.map(([a, b]): [string, string] => [a, b]),
    );
    expect(initial).toEqual(before);
  });

  test("appends flag-only pairs after all existing comparisons", () => {
    expect(
      reportPairs(["hermes+eden", "hermes+eden+edenGuide", "both+ask", "both+ask+edenGuide"], [["eden", "tools"]]),
    ).toEqual([
      ["eden", "tools"],
      ["hermes+eden", "hermes"],
      ["hermes+eden+edenGuide", "hermes"],
      ["both+ask", "both"],
      ["both+ask+edenGuide", "both"],
      ["hermes+eden+edenGuide", "hermes+eden"],
      ["both+ask+edenGuide", "both+ask"],
    ]);
  });

  test("empty and unflagged runs retain existing comparisons", () => {
    expect(reportPairs([])).toEqual([]);
    expect(reportPairs(["both", "hermes"], [["eden", "tools"]])).toEqual([["eden", "tools"]]);
    expect(reportPairs(["eden~trial@w40", "both@w0"])).toEqual([
      ["eden~trial@w40", "eden@w40"],
      ["both@w0", "both"],
    ]);
  });
});
