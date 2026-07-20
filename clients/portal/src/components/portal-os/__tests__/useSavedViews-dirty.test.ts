/**
 * UX-P0-10 — dirty detection covers filters + sort + columns.
 */
import { describe, expect, it } from "vitest";
import { isViewDirty, normalizeViewState, viewStatesEqual } from "../useSavedViews";

describe("isViewDirty / viewStatesEqual", () => {
  it("treats empty and undefined baseline as Default", () => {
    expect(isViewDirty({}, null)).toBe(false);
    expect(isViewDirty({}, undefined)).toBe(false);
    expect(isViewDirty({ q: "" }, {})).toBe(false);
  });

  it("flags filter divergence", () => {
    expect(
      isViewDirty(
        { filter: { outcome: "failure" } },
        { filter: { outcome: "success" } },
      ),
    ).toBe(true);
    expect(
      isViewDirty(
        { filter: { outcome: "failure" } },
        { filter: { outcome: "failure" } },
      ),
    ).toBe(false);
  });

  it("flags sort divergence", () => {
    expect(
      isViewDirty(
        { sort: { key: "duration_ms", direction: "desc" } },
        { sort: { key: "duration_ms", direction: "asc" } },
      ),
    ).toBe(true);
  });

  it("flags columns divergence", () => {
    expect(
      isViewDirty({ columns: ["id", "outcome"] }, { columns: ["id"] }),
    ).toBe(true);
    expect(viewStatesEqual({ columns: ["a", "b"] }, { columns: ["a", "b"] })).toBe(
      true,
    );
  });

  it("normalizeViewState drops empty filter values", () => {
    expect(normalizeViewState({ filter: { realm: "", outcome: "ok" } }).filter).toEqual({
      outcome: "ok",
    });
  });
});
