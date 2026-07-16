/**
 * Per-user product-tour progress — stored in Clerk ``unsafeMetadata.edenTour``.
 *
 * Org-scoped ``/onboarding/state`` was the wrong place for a personal tour:
 * 422s blocked Skip/X, and every member shared one org row.
 */

import { PRODUCT_TOUR_TOTAL } from "@/lib/product-tour";

export const EDEN_TOUR_META_KEY = "edenTour" as const;

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
    updatedAt:
      typeof o.updatedAt === "string" && o.updatedAt
        ? o.updatedAt
        : new Date().toISOString(),
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

export function isTourComplete(progress: EdenTourProgress | null): boolean {
  return progress?.status === "done" || progress?.status === "skipped";
}
