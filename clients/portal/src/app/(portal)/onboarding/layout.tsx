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
 */

// ponytail: dynamic = "force-dynamic" because the Wizard config holds
// `render` functions, which Next.js cannot serialize for static
// prerendering. Onboarding is interactive-only anyway (it depends on
// the current user + org, never a cacheable surface).
export const dynamic = "force-dynamic";

import { Wizard, type WizardStep } from "@/components/ui/wizard";
import { WelcomeStep } from "./_steps/welcome";
import { DoneStep } from "./_steps/done";

const STEPS: WizardStep[] = [
  {
    id: "welcome",
    slug: "/onboarding",
    label: "Welcome",
    render: () => <WelcomeStep {...({} as Parameters<typeof WelcomeStep>[0])} />,
    // The Welcome step's "Get started" button navigates to /onboarding/org
    // directly, so we treat advancing as moving to the next step.
  },
  {
    id: "org",
    slug: "/onboarding/org",
    label: "Organisation",
    render: () => null,
  },
  {
    id: "install",
    slug: "/onboarding/install",
    label: "Install SDK",
    // Now NON-optional — this is the activation step (June 2026 cleanup).
    // After install, users go straight to /onboarding/done.
    render: () => null,
  },
  {
    id: "done",
    slug: "/onboarding/done",
    label: "Done",
    render: () => <DoneStep {...({} as Parameters<typeof DoneStep>[0])} />,
  },
];

// ponytail: removed the "connect" (GitHub PR flow) and "wait" (poll-for-PR)
// steps from the wizard in June 2026. Theyre still reachable as deep links
// (/agents/connect, /onboarding/wait) but no longer part of the default
// happy path — the install step now leads directly to /onboarding/done,
// which is the activation moment for most users.

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
