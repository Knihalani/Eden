"use client";

/**
 * OnboardingOverlay — skippable product tour across the portal.
 *
 * Progress lives on the Clerk user (``unsafeMetadata.edenTour``).
 * Opens on ``?onboarding=1`` or ``?tour=1``. Session banners and
 * ErrorState defer forced opens until the blocking surface clears.
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
  const { currentOrg } = useOrg();
  const { isLoaded, progress, isComplete, setStatus, setStepIndex } =
    useTourProgress();

  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndexLocal] = useState(0);
  const [busy, setBusy] = useState(false);
  /** After Skip/Finish, ignore effect re-open until URL force flag clears. */
  const userClosedRef = useRef(false);
  /** Bootstrap Clerk metadata at most once per forced open. */
  const bootstrappedRef = useRef(false);
  const [deferTick, setDeferTick] = useState(0);

  const forceOpen =
    searchParams.get("onboarding") === "1" ||
    searchParams.get("tour") === "1";
  const progressStatus = progress?.status;
  const progressStep = progress?.stepIndex ?? 0;

  const clearTourQuery = useCallback(() => {
    if (!forceOpen) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("onboarding");
    params.delete("tour");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname || "/home");
  }, [forceOpen, searchParams, router, pathname]);

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
    if (!currentOrg) {
      setOpen(false);
      if (forceOpen) {
        router.replace("/settings?tab=org");
      }
      return;
    }
    if (forceOpen) {
      userClosedRef.current = false;
    }
    if (userClosedRef.current) {
      if (isComplete && !forceOpen) {
        userClosedRef.current = false;
      }
      if (userClosedRef.current) return;
    }

    if (!forceOpen) {
      setOpen(false);
      return;
    }

    if (shouldDeferBlockingOverlays()) {
      setOpen(false);
      return;
    }

    setStepIndexLocal(
      progressStatus === "active" || progressStatus === "skipped"
        ? progressStep
        : 0,
    );
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
    forceOpen,
    isComplete,
    progressStatus,
    progressStep,
    setStatus,
    router,
    deferTick,
  ]);

  async function handleSkip() {
    userClosedRef.current = true;
    setOpen(false);
    clearTourQuery();
    setBusy(true);
    try {
      await setStatus("skipped", stepIndex);
      pushToast({
        title: "Tour paused — resume from the banner anytime",
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
    setOpen(false);
    clearTourQuery();
    setBusy(true);
    try {
      await setStatus("done", PRODUCT_TOUR_TOTAL - 1);
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

export function OnboardingOverlay() {
  return (
    <Suspense fallback={null}>
      <OnboardingOverlayInner />
    </Suspense>
  );
}
