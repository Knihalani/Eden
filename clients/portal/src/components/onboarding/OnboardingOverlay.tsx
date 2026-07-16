"use client";

/**
 * OnboardingOverlay — skippable product tour across the portal.
 *
 * Progress lives on the Clerk user (``unsafeMetadata.edenTour``), not
 * org ``/onboarding/state``. Skip / Esc / X always closes immediately;
 * persistence is best-effort so a Clerk hiccup never traps the user.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ProductTour } from "@/components/onboarding/ProductTour";
import { useToast } from "@/components/ui/toast";
import { useTourProgress } from "@/hooks/use-tour-progress";
import { PRODUCT_TOUR_TOTAL } from "@/lib/product-tour";

export function OnboardingOverlay() {
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isLoaded, progress, isComplete, setStatus, setStepIndex } =
    useTourProgress();

  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndexLocal] = useState(0);
  const [busy, setBusy] = useState(false);
  /** After Skip/Finish, ignore effect re-open until URL force flag clears. */
  const userClosedRef = useRef(false);

  const forceOpen = searchParams.get("onboarding") === "1";

  const clearOnboardingQuery = useCallback(() => {
    if (!forceOpen) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("onboarding");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname || "/dashboard");
  }, [forceOpen, searchParams, router, pathname]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!forceOpen && userClosedRef.current) {
      userClosedRef.current = false;
    }
    if (userClosedRef.current) return;

    if (forceOpen) {
      setStepIndexLocal(progress?.status === "active" ? progress.stepIndex : 0);
      setOpen(true);
      return;
    }
    if (!isComplete) {
      setStepIndexLocal(progress?.stepIndex ?? 0);
      setOpen(true);
      if (!progress) {
        void setStatus("active", 0).catch(() => {
          /* first paint still shows tour */
        });
      }
    } else {
      setOpen(false);
    }
  }, [isLoaded, forceOpen, isComplete, progress, setStatus]);

  async function handleSkip() {
    // Close first — never leave the user stuck behind a failing persist.
    userClosedRef.current = true;
    setOpen(false);
    clearOnboardingQuery();
    setBusy(true);
    try {
      await setStatus("skipped", stepIndex);
      toast.success("Tour skipped — resume anytime from the banner");
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
