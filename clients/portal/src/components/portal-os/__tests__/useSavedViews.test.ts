import { describe, expect, it } from "vitest";
import {
  isViewDirty,
  normalizeViewState,
  viewStatesEqual,
  type ViewState,
} from "../useSavedViews";

describe("useSavedViews ViewState dirty detection (UX-P0-10)", () => {
  it("treats empty filters as equal to Default", () => {
    expect(isViewDirty({}, null)).toBe(false);
    expect(isViewDirty({ q: "", filter: { realm: "" } }, undefined)).toBe(false);
  });

  it("marks dirty when filters diverge", () => {
    const baseline: ViewState = { filter: { realm: "prod" } };
    expect(isViewDirty({ filter: { realm: "staging" } }, baseline)).toBe(true);
    expect(isViewDirty({ filter: { realm: "prod" } }, baseline)).toBe(false);
  });

  it("marks dirty when sort diverges", () => {
    const baseline: ViewState = {
      filter: { realm: "prod" },
      sort: { key: "created_at", direction: "desc" },
    };
    expect(
      isViewDirty(
        {
          filter: { realm: "prod" },
          sort: { key: "created_at", direction: "asc" },
        },
        baseline,
      ),
    ).toBe(true);
  });

  it("marks dirty when columns diverge", () => {
    const baseline: ViewState = { columns: ["id", "status", "cost"] };
    expect(isViewDirty({ columns: ["id", "status"] }, baseline)).toBe(true);
    expect(isViewDirty({ columns: ["id", "status", "cost"] }, baseline)).toBe(false);
  });

  it("viewStatesEqual is symmetric for normalized empties", () => {
    expect(viewStatesEqual({ q: "  " }, {})).toBe(true);
    expect(normalizeViewState({ filter: { a: "" } }).filter).toEqual({});
  });
});
