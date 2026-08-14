import { afterEach, describe, expect, it } from "vitest";
import {
  isTourComplete,
  shouldShowTourBanner,
  markTourDismissedLocally,
  isTourDismissedLocally,
  TOUR_DISMISSED_STORAGE_KEY,
  parseEdenTourProgress,
} from "@/lib/tour-progress";

describe("tour dismiss contract (R001/R013)", () => {
  afterEach(() => {
    window.localStorage.removeItem(TOUR_DISMISSED_STORAGE_KEY);
  });

  it("treats skipped as complete so the overlay does not resurrect", () => {
    const skipped = parseEdenTourProgress({
      status: "skipped",
      stepIndex: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isTourComplete(skipped)).toBe(true);
    expect(shouldShowTourBanner(skipped)).toBe(false);
  });

  it("keeps an in-progress active tour resumable", () => {
    const active = parseEdenTourProgress({
      status: "active",
      stepIndex: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isTourComplete(active)).toBe(false);
    expect(shouldShowTourBanner(active)).toBe(true);
  });

  it("local dismiss sticks even when Clerk metadata is still active", () => {
    markTourDismissedLocally();
    expect(isTourDismissedLocally()).toBe(true);
    const active = parseEdenTourProgress({
      status: "active",
      stepIndex: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(isTourComplete(active)).toBe(true);
    expect(shouldShowTourBanner(active)).toBe(false);
  });
});
