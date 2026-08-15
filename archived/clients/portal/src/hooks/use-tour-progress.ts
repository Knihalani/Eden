"use client";

/**
 * Read/write product-tour progress on the signed-in Clerk user
 * (``unsafeMetadata.edenTour``). Client-updatable — no backend round-trip.
 *
 * Writes are serialized so rapid Next/Back cannot lose steps via
 * overlapping read-modify-write against ``unsafeMetadata``. This hook is
 * mounted by more than one component at a time (OnboardingOverlay,
 * OnboardingBanner, ...), each with its own React state and its own call to
 * ``useUser()``. Clerk's ``useUser()`` is backed by ``useSyncExternalStore``
 * over an internal resource cache — there is no documented (or, from what's
 * vendored in this repo's node_modules, inspectable) guarantee that the
 * ``user`` object identity is stable across renders or across ``.update()``
 * calls, and this file's own long-standing comment above already assumed it
 * isn't ("Clerk may return a new unsafeMetadata object every render"). So the
 * write-serialization queue is kept at MODULE scope, keyed by user id,
 * instead of in a per-instance ``useRef`` — a ``useRef`` chain only orders
 * writes issued through that one mounted instance, which does not deliver on
 * the "writes are serialized" guarantee once a second instance (or a second
 * mount of the same instance after Fast Refresh / remount) can issue a
 * concurrent, unordered `.update()` call. Queued writes also read the
 * to-be-merged metadata off `latestUserById` (updated on every render of
 * every instance) rather than off the closure captured when the write was
 * queued, so a write that sits in the queue behind another instance's write
 * still merges against the freshest known metadata when it finally runs.
 */

import { useCallback, useLayoutEffect, useMemo } from "react";
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

type ClerkUser = NonNullable<ReturnType<typeof useUser>["user"]>;

// Module-level (not per-hook-instance) so every mounted instance of this
// hook — across every component — serializes its writes against the same
// queue for a given user. Keyed by user id so an account switch never backs
// up behind a stale/foreign chain.
const writeChains = new Map<string, Promise<void>>();

// Freshest `user` object any mounted instance has observed, per user id.
// Queued writes re-read `unsafeMetadata` through this instead of through
// the callback's closure so a write queued behind another instance's write
// still merges against current data instead of a stale snapshot from
// whenever *this* instance's callback happened to be (re)created.
const latestUserById = new Map<string, ClerkUser>();

export function useTourProgress() {
  const { user, isLoaded } = useUser();

  // Runs synchronously after every committed render (including from other
  // mounted instances of this hook), so any later event-handler-triggered
  // write sees the most recent `user` reference regardless of which
  // instance's render produced it.
  useLayoutEffect(() => {
    if (user) latestUserById.set(user.id, user);
  }, [user]);

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

  const userId = user?.id;

  const persist = useCallback(
    async (next: EdenTourProgress) => {
      if (!userId) return;
      const run = async () => {
        // Re-read the freshest known user (may have been updated by a
        // *different* mounted instance of this hook since this write was
        // queued) rather than a closure snapshot, so the read-modify-write
        // below never merges against stale metadata.
        const liveUser = latestUserById.get(userId);
        if (!liveUser) return;
        const prev = (liveUser.unsafeMetadata ?? {}) as Record<
          string,
          unknown
        >;
        await liveUser.update({
          unsafeMetadata: {
            ...prev,
            [EDEN_TOUR_META_KEY]: next,
          },
        });
      };
      // Module-level chain keyed by user id: every mounted instance of this
      // hook queues onto the SAME chain, so writes from OnboardingOverlay,
      // OnboardingBanner, etc. are ordered against each other, not just
      // against writes from whichever instance issued them.
      const prevChain = writeChains.get(userId) ?? Promise.resolve();
      const queued = prevChain.then(run, run);
      writeChains.set(
        userId,
        queued.then(
          () => undefined,
          () => undefined,
        ),
      );
      await queued;
    },
    [userId],
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
