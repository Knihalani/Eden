"use client";

/**
 * OnboardingOverlay — skippable product tour across the portal.
 *
 * Opens for incomplete Cat-23 state or `?onboarding=1`. Skip / Esc / X
 * permanently marks onboarding `done`. Finish opens docs quickstart
 * (handled inside ProductTour) and marks done.
 */

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ProductTour } from "@/components/onboarding/ProductTour";
import { useOrg } from "@/hooks/use-org";
import { useToast } from "@/components/ui/toast";
import { onboardingApi } from "@/lib/api";
import {
  PRODUCT_TOUR_TOTAL,
  tourIndexFromOnboardingStep,
  tourStepApiValue,
} from "@/lib/product-tour";

export function OnboardingOverlay() {
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { currentOrg } = useOrg();

  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const forceOpen = searchParams.get("onboarding") === "1";

  const markDone = useCallback(async () => {
    const orgId = currentOrg?.id;
    if (!orgId) return;
    await onboardingApi.patchState(orgId, { step: "done" });
  }, [currentOrg?.id]);

  const persistIndex = useCallback(
    async (index: number) => {
      const orgId = currentOrg?.id;
      if (!orgId) return;
      const apiStep = tourStepApiValue(index);
      // Cat-23 API accepts known wizard steps; tour:* is stored via
      // a best-effort patch — fall back to welcome/connect/install/done.
      const legacy =
        apiStep === "done"
          ? "done"
          : apiStep === "welcome"
            ? "welcome"
            : index >= PRODUCT_TOUR_TOTAL - 1
              ? "done"
              : index === 0
                ? "welcome"
                : "install_sdk";
      try {
        await onboardingApi.patchState(orgId, {
          step: legacy as "welcome" | "connect_github" | "install_sdk" | "done",
        });
      } catch {
        // best-effort
      }
    },
    [currentOrg?.id],
  );

  const clearOnboardingQuery = useCallback(() => {
    if (!forceOpen) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("onboarding");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname || "/dashboard");
  }, [forceOpen, searchParams, router, pathname]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!currentOrg?.id) {
        if (!cancelled) {
          setLoaded(true);
          if (forceOpen) {
            setStepIndex(0);
            setOpen(true);
          }
        }
        return;
      }
      try {
        const res = await onboardingApi.getState(currentOrg.id);
        if (cancelled) return;
        const idx = tourIndexFromOnboardingStep(res.step);
        const complete = (res.step || "").toLowerCase() === "done";
        setStepIndex(complete && forceOpen ? 0 : idx);
        if (forceOpen || !complete) {
          setOpen(true);
        }
      } catch {
        if (!cancelled && forceOpen) {
          setStepIndex(0);
          setOpen(true);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [currentOrg?.id, forceOpen]);

  async function handleSkip() {
    setBusy(true);
    try {
      await markDone();
      setOpen(false);
      clearOnboardingQuery();
      toast.success("Tour skipped — resume anytime from the banner");
    } catch {
      toast.error("Could not save skip — try again");
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish() {
    setBusy(true);
    try {
      await markDone();
      setOpen(false);
      clearOnboardingQuery();
      toast.success("Tour complete — check the quickstart when you're ready");
    } catch {
      toast.error("Could not mark tour complete");
    } finally {
      setBusy(false);
    }
  }

  function handleStepChange(index: number) {
    setStepIndex(index);
    void persistIndex(index);
  }

  if (!loaded && !forceOpen) return null;
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
