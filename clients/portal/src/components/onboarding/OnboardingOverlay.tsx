"use client";

/**
 * OnboardingOverlay — skippable product tour across the portal.
 *
 * Progress lives on the Clerk user (``unsafeMetadata.edenTour``), not
 * org ``/onboarding/state``. Skip / Esc / X always closes immediately;
 * persistence is best-effort so a Clerk hiccup never traps the user.
 *
 * Auto-open is intentionally off: the tour only opens on
 * ``?onboarding=1`` (Tour / Resume banner) so it never stacks over the
 * dashboard first-run checklist. Session banners and ErrorState defer
 * even forced opens until the blocking surface clears.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ProductTour } from "@/components/onboarding/ProductTour";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { useTourProgress } from "@/hooks/use-tour-progress";
import { PRODUCT_TOUR_TOTAL } from "@/lib/product-tour";
import {
  CHROME_BANNER_ATTR,
  ERROR_STATE_ATTR,
  shouldDeferBlockingOverlays,
} from "@/lib/overlay-defer";

export function OnboardingOverlay() {
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { currentOrg } = useOrg();
  const { isLoaded, progress, isComplete, setStatus, setStepIndex } =
    useTourProgress();

  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndexLocal] = useState(0);
  const [busy, setBusy] = useState(false);
  /** After Skip/Finish, ignore effect re-open until URL force flag clears. */
  const userClosedRef = useRef(false);
  /** Bootstrap Clerk metadata at most once per forced open (avoids #185 loops). */
  const bootstrappedRef = useRef(false);
  /** Bumps when chrome banner / ErrorState markers change so we can retry open. */
  const [deferTick, setDeferTick] = useState(0);

  const forceOpen = searchParams.get("onboarding") === "1";
  const progressStatus = progress?.status;
  const progressStep = progress?.stepIndex ?? 0;

  const clearOnboardingQuery = useCallback(() => {
    if (!forceOpen) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("onboarding");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname || "/dashboard");
  }, [forceOpen, searchParams, router, pathname]);

  // Watch chrome / ErrorState markers — deferred force-opens resume when clear.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const bump = () => setDeferTick((n) => n + 1);
    const observer = new MutationObserver(bump);
    observer.observe(root, {
      attributes: true,
      attributeFilter: [CHROME_BANNER_ATTR],
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [ERROR_STATE_ATTR],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    // Orgless users need Create organization reachable — do not cover
    // the page with the full-screen tour until an Eden org exists.
    // ?onboarding=1 must not imply the tour creates a workspace.
    if (!currentOrg) {
      setOpen(false);
      if (forceOpen) {
        router.replace("/settings?tab=org");
      }
      return;
    }
    // ?onboarding=1 / Resume tour must reopen after Skip — clear sticky close.
    if (forceOpen) {
      userClosedRef.current = false;
    }
    // Keep Skip/Finish sticky until Clerk marks the tour complete.
    // Clearing userClosedRef on every non-forceOpen run raced setStatus
    // and reopened the overlay while status was still "active".
    if (userClosedRef.current) {
      if (isComplete && !forceOpen) {
        userClosedRef.current = false;
      }
      if (userClosedRef.current) return;
    }

    // Tour opens only on explicit ?onboarding=1 (Tour button / Resume banner).
    // Never auto-open over the first-run checklist or an incomplete tour record.
    if (!forceOpen) {
      setOpen(false);
      return;
    }

    // Defer when session / offline / ErrorState chrome would stack under the tour.
    if (shouldDeferBlockingOverlays()) {
      setOpen(false);
      return;
    }

    // ?onboarding=1 always reopens. Resume when paused/active; restart after Finish.
    setStepIndexLocal(
      progressStatus === "active" || progressStatus === "skipped"
        ? progressStep
        : 0,
    );
    setOpen(true);
    // Seed Clerk metadata once when the user explicitly starts the tour.
    if (!progressStatus && !bootstrappedRef.current) {
      bootstrappedRef.current = true;
      void setStatus("active", 0).catch(() => {
        /* first paint still shows tour */
      });
    }
  }, [
    isLoaded,
    currentOrg,
    forceOpen,
    isComplete,
    progressStatus,
    progressStep,
    setStatus,
    router,
    deferTick,
  ]);

  async function handleSkip() {
    // Close first — never leave the user stuck behind a failing persist.
    userClosedRef.current = true;
    setOpen(false);
    clearOnboardingQuery();
    setBusy(true);
    try {
      await setStatus("skipped", stepIndex);
      toast.success("Tour paused — resume from the banner anytime");
    } catch {
      toast.error("Tour closed — progress may not have saved");
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish() {
    userClosedRef.current = true;
    setOpen(false);
    clearOnboardingQuery();
    setBusy(true);
    try {
      await setStatus("done", PRODUCT_TOUR_TOTAL - 1);
      toast.success("Tour complete — check the quickstart when you're ready");
    } catch {
      toast.error("Tour closed — progress may not have saved");
    } finally {
      setBusy(false);
    }
  }

  function handleStepChange(index: number) {
    setStepIndexLocal(index);
    void setStepIndex(index).catch(() => {
      /* best-effort */
    });
  }

  if (!isLoaded && !forceOpen) return null;
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
