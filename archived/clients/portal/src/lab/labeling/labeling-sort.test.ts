import { describe, expect, it } from "vitest";
import { sortItemsByDisagreement } from "@/lab/labeling/labeling-sort";
import type { LabelingItemListEntry } from "@/lib/api/labeling";

function item(id: string, annotations_count: number): LabelingItemListEntry {
  return {
    id,
    prompt: `prompt ${id}`,
    context: null,
    tags: [],
    source: "trace",
    created_at: "2026-01-01T00:00:00Z",
    annotations_count,
  };
}

describe("sortItemsByDisagreement", () => {
  it("returns an empty array unchanged", () => {
    expect(sortItemsByDisagreement([], {})).toEqual([]);
  });

  it("leaves zero-annotation items at the tail in their incoming order", () => {
    const items = [item("a", 0), item("b", 0), item("c", 0)];
    expect(sortItemsByDisagreement(items, {}).map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("moves any annotated item ahead of every unannotated item", () => {
    const items = [item("unannotated", 0), item("annotated", 2)];
    const perItem = { annotated: { agreement: 0.9 } };
    expect(sortItemsByDisagreement(items, perItem).map((i) => i.id)).toEqual([
      "annotated",
      "unannotated",
    ]);
  });

  it("sorts annotated items ascending by agreement (lowest agreement first)", () => {
    const items = [item("high", 2), item("low", 2), item("mid", 2)];
    const perItem = {
      high: { agreement: 0.95 },
      low: { agreement: 0.1 },
      mid: { agreement: 0.5 },
    };
    expect(sortItemsByDisagreement(items, perItem).map((i) => i.id)).toEqual([
      "low",
      "mid",
      "high",
    ]);
  });

  it("surfaces single-annotation items (no computed agreement yet) ahead of items with a known agreement score", () => {
    const items = [item("known", 2), item("single", 1)];
    const perItem = { known: { agreement: 0.99 } };
    expect(sortItemsByDisagreement(items, perItem).map((i) => i.id)).toEqual([
      "single",
      "known",
    ]);
  });

  it("tolerates a missing/undefined per_item map", () => {
    const items = [item("a", 1), item("b", 0)];
    expect(sortItemsByDisagreement(items, undefined).map((i) => i.id)).toEqual([
      "a",
      "b",
    ]);
  });
});
