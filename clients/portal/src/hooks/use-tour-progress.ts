"use client";

/**
 * Read/write product-tour progress on the signed-in Clerk user
 * (``unsafeMetadata.edenTour``). Client-updatable — no backend round-trip.
 */

import { useCallback, useMemo } from "react";
import { useUser } from "@clerk/nextjs";
import {
  EDEN_TOUR_META_KEY,
  buildEdenTourProgress,
  isTourComplete,
  parseEdenTourProgress,
  shouldShowTourBanner,
  type EdenTourProgress,
  type EdenTourStatus,
} from "@/lib/tour-progress";

export function useTourProgress() {
  const { user, isLoaded } = useUser();

  // Clerk may return a new unsafeMetadata object every render. Key off the
  // serialized tour payload so parse/memo only re-run when tour data changes.
  const tourRaw = user?.unsafeMetadata?.[EDEN_TOUR_META_KEY];
  const tourKey =
    tourRaw == null
      ? ""
      : typeof tourRaw === "string"
        ? tourRaw
        : JSON.stringify(tourRaw);

  const progress = useMemo(() => {
    if (!tourKey) return parseEdenTourProgress(null);
    if (tourKey.startsWith("{") || tourKey.startsWith("[")) {
      try {
        return parseEdenTourProgress(JSON.parse(tourKey));
      } catch {
        return parseEdenTourProgress(null);
      }
    }
    return parseEdenTourProgress(tourKey);
  }, [tourKey]);

  const persist = useCallback(
    async (next: EdenTourProgress) => {
      if (!user) return;
      const prev = (user.unsafeMetadata ?? {}) as Record<string, unknown>;
      await user.update({
        unsafeMetadata: {
          ...prev,
          [EDEN_TOUR_META_KEY]: next,
        },
      });
    },
    [user],
  );

  const setStatus = useCallback(
    async (status: EdenTourStatus, stepIndex = 0) => {
      const next = buildEdenTourProgress({ status, stepIndex });
      await persist(next);
      return next;
    },
    [persist],
  );

  const setStepIndex = useCallback(
    async (stepIndex: number) => {
      // Advancing a step means the tour is active again (incl. resume from Skip).
      const next = buildEdenTourProgress({
        status: "active",
        stepIndex,
      });
      await persist(next);
      return next;
    },
    [persist],
  );

  return {
    isLoaded,
    progress,
    isComplete: isTourComplete(progress),
    showBanner: shouldShowTourBanner(progress),
    setStatus,
    setStepIndex,
    persist,
  };
}
