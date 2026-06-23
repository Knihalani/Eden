"use client";

/**
 * /onboarding/* — wizard chrome (Phase 2 of the June 2026 UI overhaul).
 *
 * The chrome (top bar, progress strip, Back/Next nav) is rendered by
 * the generic <Wizard>. Each step is a thin sub-page that imports the
 * corresponding step component from /onboarding/_steps/.
 *
 * The list of steps is declared in a single place so the progress bar,
 * the back/next routing, and the canAdvance/onNext hooks are all in
 * sync.
 *
 * This file MUST be a client component: the <Wizard> receives a
 * ``steps: WizardStep[]`` array whose entries each hold a
 * ``render: (ctx) => ReactNode`` function. React 19 + Next.js 16 will
 * throw ``Error: Functions cannot be passed directly to Client
 * Components`` at render time if a server component constructs that
 * array and passes it across the boundary — the function reference
 * can't be serialized. Marking this file as a client component keeps
 * the array construction on the client side; the steps list never
 * leaves the client.
 */

import { useEffect } from "react";
import { Wizard, type WizardStep } from "@/components/ui/wizard";

const STEPS: WizardStep[] = [
  {
    id: "welcome",
    slug: "/onboarding",
    label: "Welcome",
    // The "Next" button in the wizard's bottom nav moves forward
    // to the org-setup step on the same flow.
    onNext: () => "/onboarding/org",
  },
  {
    id: "org",
    slug: "/onboarding/org",
    label: "Organisation",
    onNext: () => "/onboarding/autonomous",
  },
  {
    id: "autonomous",
    slug: "/onboarding/autonomous",
    label: "Autonomous",
    onNext: () => "/onboarding/connect",
  },
  {
    id: "connect",
    slug: "/onboarding/connect",
    label: "Connect repo",
    onNext: () => "/onboarding/wait",
  },
  {
    id: "wait",
    slug: "/onboarding/wait",
    label: "Wait for PR",
    onNext: () => "/onboarding/tour",
  },
  {
    id: "tour",
    slug: "/onboarding/tour",
    label: "Quick tour",
    onNext: () => "/onboarding/done",
  },
  {
    id: "done",
    slug: "/onboarding/done",
    label: "Done",
  },
];

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  // FIX-N: set data-route="onboarding" on the body so globals.css
  // can apply the [class*="z-50"][class*="fixed"] click-blocker
  // suppression rule. The ChatSidebar floating toggle button is
  // already gated by usePathname() in component code, but a
  // third-party floating overlay (or a future z-50 surface) would
  // silently regress this. Tagging the body makes the rule
  // declarative and future-proof.
  useEffect(() => {
    document.body.dataset.route = "onboarding";
    return () => {
      // Don't unset on unmount — the body persists across
      // route changes inside the (portal) tree, and any later
      // client-side navigation back to /onboarding will re-set
      // the attribute before the next paint. Leaving it stale
      // during the in-between is harmless (the rule only
      // suppresses z-50 fixed, which the rest of the portal
      // never mounts anyway).
    };
  }, []);

  return (
    <Wizard
      steps={STEPS}
      storageKey="eden:onboarding"
      completeSlug="/onboarding/done"
      brand={{ name: "Eden", tagline: "setup" }}
    >
      {children}
    </Wizard>
  );
}
