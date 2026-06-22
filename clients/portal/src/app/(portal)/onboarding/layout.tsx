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
import { WelcomeStep } from "./_steps/welcome";
import { ConnectStep } from "./_steps/connect";
import { WaitStep } from "./_steps/wait";
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
    // After install, users go straight to /onboarding/connect.
    render: () => null,
  },
  {
    id: "connect",
    slug: "/onboarding/connect",
    label: "Connect repo",
    // Step 4: link a GitHub repo via the Eden GitHub App. The shared
    // <OnboardingConnectFlow> opens an SDK-integration PR; on success
    // it navigates to /onboarding/wait. Members / viewers without
    // `integrations:write` see a locked panel that explains why and
    // lets the wizard skip to the Done step.
    render: () => <ConnectStep />,
  },
  {
    id: "wait",
    slug: "/onboarding/wait",
    label: "Wait for PR",
    // Step 5: poll /pr-runs every 5s for the integration PR. The step
    // body shows status badges, GitHub deep links, and a "Skip —
    // finish setup" escape hatch for users who wire the repo up
    // manually. The wizard advances to /onboarding/done on merge or
    // skip.
    render: () => <WaitStep />,
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
      brand={{ name: "Eden", tagline: "setup" }}
    >
      {children}
    </Wizard>
  );
}
