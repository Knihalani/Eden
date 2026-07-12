"use client";

/**
 * /onboarding/* — streamlined setup wizard (Jul 2026 overhaul).
 *
 * Clerk creates the workspace during signup; Eden syncs it on the first
 * /auth/me. No redundant "create org" step in the main path.
 *
 * Flow: Welcome → Connect repo → (Wait for PR, if opened) → Install SDK → Done
 *
 * Progress chrome (banner + checklist) collapses wait into the install
 * slot so LP-11 SoT stays welcome → connect → install → done.
 */

import { Wizard, type WizardStep } from "@/components/ui/wizard";

const STEPS: WizardStep[] = [
  {
    id: "welcome",
    slug: "/onboarding",
    label: "Welcome",
    onNext: () => "/onboarding/connect",
  },
  {
    id: "connect",
    slug: "/onboarding/connect",
    label: "Connect repo",
    optional: true,
    onNext: () => "/onboarding/install",
  },
  {
    id: "wait",
    slug: "/onboarding/wait",
    label: "Wait for PR",
    optional: true,
    onNext: () => "/onboarding/install",
  },
  {
    id: "install",
    slug: "/onboarding/install",
    label: "Install SDK",
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
