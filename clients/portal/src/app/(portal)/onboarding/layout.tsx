"use client";

/**
 * /onboarding/* — streamlined setup wizard (Jul 2026 overhaul).
 *
 * Clerk creates the workspace during signup; Eden syncs it on the first
 * /auth/me. The wizard no longer forces a redundant "create org" step.
 *
 * Flow: Welcome → Install SDK → Connect repo (optional) → Done
 */

import { Wizard, type WizardStep } from "@/components/ui/wizard";

const STEPS: WizardStep[] = [
  {
    id: "welcome",
    slug: "/onboarding",
    label: "Welcome",
    onNext: () => "/onboarding/install",
  },
  {
    id: "install",
    slug: "/onboarding/install",
    label: "Install SDK",
    onNext: () => "/onboarding/connect",
  },
  {
    id: "connect",
    slug: "/onboarding/connect",
    label: "Connect repo",
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
    <div data-route="onboarding" className="contents">
      <Wizard
        steps={STEPS}
        storageKey="eden:onboarding"
        completeSlug="/onboarding/done"
        brand={{ name: "Eden", tagline: "setup" }}
      >
        {children}
      </Wizard>
    </div>
  );
}
