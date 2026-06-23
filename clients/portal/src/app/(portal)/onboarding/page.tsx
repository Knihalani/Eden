/**
 * /onboarding — Step 1: Welcome.
 *
 * Thin route wrapper. The actual content lives in
 * ``_steps/welcome.tsx`` and is shared between the wizard
 * surface and any future deep-links. The wizard's STEPS array
 * in the layout is the canonical progress metadata; this page
 * is just the URL entry.
 */
"use client";

import { WelcomeStep } from "./_steps/welcome";

export default function OnboardingWelcomePage() {
  return <WelcomeStep />;
}
