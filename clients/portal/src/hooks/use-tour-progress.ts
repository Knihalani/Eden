"use client";

/**
 * Read/write product-tour progress on the signed-in Clerk user
 * (``unsafeMetadata.edenTour``). Client-updatable — no backend round-trip.
 *
 * Writes are serialized so rapid Next/Back cannot lose steps via
 * overlapping read-modify-write against ``unsafeMetadata``.
 */

import { useCallback, useMemo, useRef } from "react";
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
  const writeChain = useRef<Promise<void>>(Promise.resolve());

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
      const run = async () => {
        // Re-read latest metadata immediately before write so concurrent
        // Clerk updates outside the tour are not clobbered.
        const prev = (user.unsafeMetadata ?? {}) as Record<string, unknown>;
        await user.update({
          unsafeMetadata: {
            ...prev,
            [EDEN_TOUR_META_KEY]: next,
          },
        });
      };
      const queued = writeChain.current.then(run, run);
      writeChain.current = queued.then(
        () => undefined,
        () => undefined,
      );
      await queued;
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
