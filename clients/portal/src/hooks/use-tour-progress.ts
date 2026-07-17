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

  const progress = useMemo(
    () => parseEdenTourProgress(tourRaw as unknown),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tourKey is the stable identity
    [tourKey],
  );

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
    setStatus,
    setStepIndex,
    persist,
  };
}
