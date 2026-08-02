"use client";

/**
 * OnboardingOverlay — skippable product tour across the portal.
 *
 * Progress lives on the Clerk user (``unsafeMetadata.edenTour``).
 * Opens on ``?onboarding=1`` or ``?tour=1``. Session banners and
 * ErrorState defer forced opens until the blocking surface clears.
 *
 * 2026-07-23 polish:
 * - Wait for org load before treating missing org as "create workspace".
 * - Narrow MutationObserver to banner/error attrs only (not body subtree)
 *   so ProductTour portal remounts do not snap the step index backward.
 * - Local step index is authoritative while the tour is open; Clerk
 *   metadata is write-behind, not a force-sync source each tick.
 */

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLabToast } from "@/lab/lab-toast";
import { useOrg } from "@/hooks/use-org";
import { useTourProgress } from "@/hooks/use-tour-progress";
import { PRODUCT_TOUR_TOTAL } from "@/lib/product-tour";
import {
  CHROME_BANNER_ATTR,
  ERROR_STATE_ATTR,
  shouldDeferBlockingOverlays,
} from "@/lib/overlay-defer";

const ProductTour = dynamic(
  () =>
    import("@/components/onboarding/ProductTour").then((m) => m.ProductTour),
  { ssr: false },
);

function OnboardingOverlayInner() {
  const { pushToast } = useLabToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { currentOrg, loading: orgLoading, orgSyncing } = useOrg();
  const { isLoaded, progress, isComplete, setStatus, setStepIndex } =
    useTourProgress();

  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndexLocal] = useState(0);
  const [busy, setBusy] = useState(false);
  /** After Skip/Finish, ignore effect re-open until URL force flag clears. */
  const userClosedRef = useRef(false);
  /** Bootstrap Clerk metadata at most once per forced open. */
  const bootstrappedRef = useRef(false);
  /**
   * Once ?onboarding=1 / ?tour=1 opens the tour, keep it open across
   * in-tour router.push(step.href) navigations that strip the query.
   * Cleared only on Skip/Finish (or when org disappears after load).
   */
  const sessionOpenRef = useRef(false);
  /** True after we seeded local step from Clerk once for this session. */
  const seededStepRef = useRef(false);
  const [deferTick, setDeferTick] = useState(0);

  const forceOpen =
    searchParams.get("onboarding") === "1" ||
    searchParams.get("tour") === "1";
  const progressStatus = progress?.status;
  const progressStep = progress?.stepIndex ?? 0;
  const orgReady = Boolean(currentOrg) && !orgSyncing;
  const orgStillResolving =
    !currentOrg && (orgLoading || orgSyncing || !isLoaded);
  /** Rising edge of forceOpen — avoid reopening while Skip clears the URL. */
  const prevForceOpenRef = useRef(false);

  const clearTourQuery = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (!params.has("onboarding") && !params.has("tour")) return;
    params.delete("onboarding");
    params.delete("tour");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname || "/home");
  }, [searchParams, router, pathname]);

  // Only watch banner/error attributes — never document.body childList
  // (ProductTour portals remount on every step and used to re-fire this).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const bump = () => setDeferTick((n) => n + 1);
    const observer = new MutationObserver(bump);
    observer.observe(root, {
      attributes: true,
      attributeFilter: [CHROME_BANNER_ATTR, ERROR_STATE_ATTR],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isLoaded) return;

    // Org still loading — do not redirect away or close a forced open.
    if (orgStillResolving) {
      return;
    }

    if (!currentOrg) {
      sessionOpenRef.current = false;
      seededStepRef.current = false;
      setOpen(false);
      // True no-workspace after load completed — send to workspace
      // setup. Preserve the force-open flag so the post-signup tour
      // still opens once the workspace exists; dropping it stranded
      // new users on settings with no walkthrough.
      if (forceOpen) {
        const flag = searchParams.get("tour") === "1" ? "tour" : "onboarding";
        router.replace(`/settings?mode=workspace&${flag}=1`);
      }
      return;
    }

    // Finished tours must not reopen via ?onboarding=1 (skipped may still resume).
    if (progressStatus === "done" && forceOpen) {
      sessionOpenRef.current = false;
      setOpen(false);
      clearTourQuery();
      return;
    }

    const forceRising = forceOpen && !prevForceOpenRef.current;
    prevForceOpenRef.current = forceOpen;

    if (forceRising) {
      userClosedRef.current = false;
      sessionOpenRef.current = true;
    } else if (forceOpen) {
      // Still on ?onboarding=1 after Skip/Finish started clearing — do not
      // reset userClosed or the tour snaps back open for a frame.
      sessionOpenRef.current = sessionOpenRef.current || !userClosedRef.current;
    }
    if (userClosedRef.current) {
      if (isComplete && !forceOpen) {
        userClosedRef.current = false;
      }
      if (userClosedRef.current) return;
    }

    // Stay open for the whole walkthrough once force-opened — ProductTour
    // navigates with bare step hrefs that omit ?onboarding=1.
    if (!forceOpen && !sessionOpenRef.current) {
      setOpen(false);
      return;
    }

    if (shouldDeferBlockingOverlays()) {
      // Org soft-switch briefly sets the chrome banner; closing the tour
      // mid-walkthrough caused reopen glitches. Keep the session open and
      // only defer for real error panels (or banners when not mid-tour).
      const errorOnly =
        typeof document !== "undefined" &&
        document.documentElement.getAttribute(ERROR_STATE_ATTR) === "1";
      if (errorOnly || !sessionOpenRef.current) {
        setOpen(false);
        return;
      }
    }

    // Seed local step from Clerk once when opening — never force-sync on
    // every deferTick / progress write (that caused snap-back on Next/Back).
    if (!seededStepRef.current) {
      seededStepRef.current = true;
      setStepIndexLocal(
        progressStatus === "active" || progressStatus === "skipped"
          ? progressStep
          : 0,
      );
    }

    setOpen(true);
    if (!progressStatus && !bootstrappedRef.current) {
      bootstrappedRef.current = true;
      void setStatus("active", 0).catch(() => {
        /* first paint still shows tour */
      });
    }
  }, [
    isLoaded,
    currentOrg,
    orgStillResolving,
    forceOpen,
    isComplete,
    progressStatus,
    progressStep,
    setStatus,
    router,
    clearTourQuery,
    deferTick,
  ]);

  // Reset seed when tour fully closes so a later Resume starts clean.
  useEffect(() => {
    if (!open && !sessionOpenRef.current) {
      seededStepRef.current = false;
    }
  }, [open]);

  /**
   * Terminal status writes get one retry; per-step write-behind does not.
   *
   * A lost step write self-heals on the next Next/Back. A lost terminal write
   * does not: the user has already been told the tour closed, and the overlay
   * will not reopen on its own, so a transient Clerk blip leaves someone who
   * finished the tour being nagged to "Continue tour" indefinitely. One retry
   * covers the blip without turning every step tick into two writes.
   *
   * Deliberately not rolled back on failure: reopening a tour the user just
   * dismissed is a worse outcome than a stale banner, and the state is
   * recoverable — the banner is exactly the affordance for redoing it.
   */
  async function persistTerminalStatus(
    status: "done" | "skipped",
    step: number,
  ) {
    try {
      return await setStatus(status, step);
    } catch {
      return await setStatus(status, step);
    }
  }

  async function handleSkip() {
    userClosedRef.current = true;
    sessionOpenRef.current = false;
    seededStepRef.current = false;
    setOpen(false);
    clearTourQuery();
    setBusy(true);
    try {
      await persistTerminalStatus("skipped", stepIndex);
      pushToast({
        title: "Tour closed",
        tone: "accent",
      });
    } catch {
      pushToast({
        title: "Tour closed — progress may not have saved",
        tone: "fail",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish() {
    userClosedRef.current = true;
    sessionOpenRef.current = false;
    seededStepRef.current = false;
    setOpen(false);
    clearTourQuery();
    setBusy(true);
    try {
      await persistTerminalStatus("done", PRODUCT_TOUR_TOTAL - 1);
      pushToast({
        title: "Tour complete — paste a snippet and open Traces",
        tone: "ok",
      });
    } catch {
      pushToast({
        title: "Tour closed — progress may not have saved",
        tone: "fail",
      });
    } finally {
      setBusy(false);
    }
  }

  function handleStepChange(index: number) {
    setStepIndexLocal(index);
    void setStepIndex(index).catch(() => {
      /* best-effort write-behind */
    });
  }

  if (!isLoaded && !forceOpen) return null;
  // Soft-switch nulls currentOrg briefly; keep tour mounted so we do not
  // emit tour-end / remount / fight the soft-switch home push.
  if (sessionOpenRef.current && (orgStillResolving || orgSyncing)) {
    return (
      <ProductTour
        open={open}
        stepIndex={stepIndex}
        onStepChange={handleStepChange}
        onSkip={() => void handleSkip()}
        onFinish={() => void handleFinish()}
        busy
      />
    );
  }
  if (!orgReady && !currentOrg) return null;
  if (!currentOrg) return null;
  if (!open) return null;

  return (
    <ProductTour
      open={open}
      stepIndex={stepIndex}
      onStepChange={handleStepChange}
      onSkip={() => void handleSkip()}
      onFinish={() => void handleFinish()}
      busy={busy}
    />
  );
}

export function OnboardingOverlay() {
  return (
    <Suspense
      fallback={
        <span className="sr-only" role="status">
          Loading onboarding…
        </span>
      }
    >
      <OnboardingOverlayInner />
    </Suspense>
  );
}
