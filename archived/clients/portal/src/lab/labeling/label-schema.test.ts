import { describe, expect, it } from "vitest";
import { extractLabelOptions, extractNumericRange } from "@/lab/labeling/label-schema";

describe("extractLabelOptions", () => {
  it("returns null for a missing schema", () => {
    expect(extractLabelOptions(null)).toBeNull();
    expect(extractLabelOptions(undefined)).toBeNull();
  });

  it("returns Yes/No for a boolean-typed schema", () => {
    expect(extractLabelOptions({ type: "boolean" })).toEqual([
      { value: true, text: "Yes" },
      { value: false, text: "No" },
    ]);
  });

  it("maps a plain string options array", () => {
    expect(extractLabelOptions({ options: ["good", "bad"] })).toEqual([
      { value: "good", text: "good" },
      { value: "bad", text: "bad" },
    ]);
  });

  it("maps an object options array with value/label pairs", () => {
    expect(
      extractLabelOptions({
        options: [
          { value: "a", label: "Option A" },
          { value: "b", label: "Option B" },
        ],
      }),
    ).toEqual([
      { value: "a", text: "Option A" },
      { value: "b", text: "Option B" },
    ]);
  });

  it("falls back to choices/labels/enum keys", () => {
    expect(extractLabelOptions({ choices: ["x", "y"] })?.map((o) => o.value)).toEqual([
      "x",
      "y",
    ]);
    expect(extractLabelOptions({ labels: ["x"] })?.map((o) => o.value)).toEqual(["x"]);
    expect(extractLabelOptions({ enum: ["x"] })?.map((o) => o.value)).toEqual(["x"]);
  });

  it("returns null for a freeform/unstructured schema", () => {
    expect(extractLabelOptions({})).toBeNull();
    expect(extractLabelOptions({ type: "text" })).toBeNull();
  });

  it("caps options at 9 so every option maps to a single keyboard digit", () => {
    const options = extractLabelOptions({
      options: Array.from({ length: 12 }, (_, i) => `opt-${i}`),
    });
    expect(options).toHaveLength(9);
  });
});

describe("extractNumericRange", () => {
  it("returns null for non-numeric schemas", () => {
    expect(extractNumericRange(null)).toBeNull();
    expect(extractNumericRange({ options: ["a"] })).toBeNull();
  });

  it("reads min/max/step for a score schema, with sane defaults", () => {
    expect(extractNumericRange({ type: "score" })).toEqual({ min: 0, max: 10, step: 1 });
    expect(extractNumericRange({ type: "rating", min: 1, max: 5, step: 1 })).toEqual({
      min: 1,
      max: 5,
      step: 1,
    });
    expect(extractNumericRange({ type: "number", min: -1, max: 1, step: 0.1 })).toEqual({
      min: -1,
      max: 1,
      step: 0.1,
    });
  });
});
