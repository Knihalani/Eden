import { describe, expect, it } from "vitest";
import { LABELING_LIST_LIMIT, clampLabelingLimit } from "@/lib/api/labeling";

describe("labeling list limit (R011)", () => {
  it("caps at the API max of 100", () => {
    expect(LABELING_LIST_LIMIT).toBe(100);
    expect(clampLabelingLimit(200)).toBe(100);
    expect(clampLabelingLimit(100)).toBe(100);
    expect(clampLabelingLimit(50)).toBe(50);
    expect(clampLabelingLimit(0)).toBe(1);
  });
});
