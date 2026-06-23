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
