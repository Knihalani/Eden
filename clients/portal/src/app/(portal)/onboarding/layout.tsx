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
    optional: true,
    render: () => null,
  },
  {
    id: "connect",
    slug: "/onboarding/connect",
    label: "Connect GitHub",
    optional: true,
    render: () => null,
  },
  {
    id: "wait",
    slug: "/onboarding/wait",
    label: "Open PR",
    optional: true,
    render: () => null,
  },
  {
    id: "done",
    slug: "/onboarding/done",
    label: "Done",
    render: () => <DoneStep {...({} as Parameters<typeof DoneStep>[0])} />,
  },
];

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <Wizard
      steps={STEPS}
      storageKey="eden:onboarding"
      completeSlug="/onboarding/done"
      brand={{ logo: true, tagline: "setup" }}
    >
      {children}
    </Wizard>
  );
}
