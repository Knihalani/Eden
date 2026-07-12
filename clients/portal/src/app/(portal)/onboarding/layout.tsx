"use client";

/**
 * /onboarding/* — setup wizard chrome.
 *
 * Clerk creates the workspace during signup; Eden syncs it on the first
 * /auth/me. Flow URLs: Welcome → Connect → (Wait) → Install → Done.
 *
 * Progress chrome uses ``lib/onboarding-progress`` (3-step display) so
 * the wizard never disagrees with the global banner outside this route.
 */

import { usePathname } from "next/navigation";
import { Wizard, type WizardStep } from "@/components/ui/wizard";
import {
  formatOnboardingProgress,
  ONBOARDING_PROGRESS_TOTAL,
} from "@/lib/onboarding-progress";

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
    // Skip / Next without a PR → install. Completing integrate hard-navs
    // to /onboarding/wait from the step body.
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

function OnboardingProgressBar() {
  const pathname = usePathname() || "/onboarding";
  const progress = formatOnboardingProgress(pathname, { fromPath: true });
  const pct = (progress.current / Math.max(ONBOARDING_PROGRESS_TOTAL, 1)) * 100;

  return (
    <>
      <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
        <span>
          Step {progress.current} of {progress.total}
          {progress.label ? ` · ${progress.label}` : ""}
        </span>
      </div>
      <div className="h-0.5 w-full overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
        <div
          className="h-full bg-[var(--accent)] transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </>
  );
}

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-route="onboarding" className="contents">
      <Wizard
        steps={STEPS}
        storageKey="eden:onboarding"
        completeSlug="/onboarding/done"
        brand={{ name: "Eden", tagline: "setup" }}
        progressBar={<OnboardingProgressBar />}
        skipHref="/dashboard"
        hideBottomNavOn={[
          "/onboarding",
          "/onboarding/connect",
          "/onboarding/wait",
          "/onboarding/install",
        ]}
      >
        {children}
      </Wizard>
    </div>
  );
}
