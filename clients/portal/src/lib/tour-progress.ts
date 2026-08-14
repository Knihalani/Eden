/**
 * Per-user product-tour progress — stored in Clerk ``unsafeMetadata.edenTour``.
 *
 * Org-scoped ``/onboarding/state`` was the wrong place for a personal tour:
 * 422s blocked Skip/X, and every member shared one org row.
 */

import { PRODUCT_TOUR_TOTAL } from "@/lib/product-tour";

export const EDEN_TOUR_META_KEY = "edenTour" as const;

/** Browser-local dismiss so Skip/X sticks even if a Clerk write blips. */
export const TOUR_DISMISSED_STORAGE_KEY = "eden.tour.dismissed";

export type EdenTourStatus = "active" | "done" | "skipped";

export interface EdenTourProgress {
  status: EdenTourStatus;
  /** 0-based step index while active. */
  stepIndex: number;
  updatedAt: string;
}

export function parseEdenTourProgress(raw: unknown): EdenTourProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const status = o.status;
  if (status !== "active" && status !== "done" && status !== "skipped") {
    return null;
  }
  const stepIndex =
    typeof o.stepIndex === "number" && Number.isFinite(o.stepIndex)
      ? Math.max(0, Math.min(PRODUCT_TOUR_TOTAL - 1, Math.floor(o.stepIndex)))
      : 0;
  return {
    status,
    stepIndex,
    // Stable fallback — inventing `new Date()` on every parse caused
    // new object identity and fed the tour overlay re-render loop.
    updatedAt:
      typeof o.updatedAt === "string" && o.updatedAt
        ? o.updatedAt
        : "1970-01-01T00:00:00.000Z",
  };
}

export function buildEdenTourProgress(
  partial: Partial<EdenTourProgress> & Pick<EdenTourProgress, "status">,
): EdenTourProgress {
  return {
    status: partial.status,
    stepIndex:
      typeof partial.stepIndex === "number"
        ? Math.max(0, Math.min(PRODUCT_TOUR_TOTAL - 1, Math.floor(partial.stepIndex)))
        : 0,
    updatedAt: new Date().toISOString(),
  };
}

export function markTourDismissedLocally(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOUR_DISMISSED_STORAGE_KEY, "1");
  } catch {
    /* quota / private mode */
  }
}

export function isTourDismissedLocally(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TOUR_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Skip/X and Finish both retire auto-open. ``skipped`` is a dismiss, not
 * a pause that resurrects the overlay on the next route.
 */
export function isTourComplete(progress: EdenTourProgress | null): boolean {
  if (isTourDismissedLocally()) return true;
  return progress?.status === "done" || progress?.status === "skipped";
}

/**
 * Banner only while the tour is actively in progress.
 * ``skipped`` and ``done`` stay quiet — Resume is opt-in via ?tour=1.
 */
export function shouldShowTourBanner(
  progress: EdenTourProgress | null,
): boolean {
  if (isTourDismissedLocally()) return false;
  if (!progress) return true;
  return progress.status === "active";
}
