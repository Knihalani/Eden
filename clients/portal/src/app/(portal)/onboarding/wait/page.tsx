/**
 * /onboarding/wait — Step 5: Wait for the integration PR to be merged.
 *
 * Thin route wrapper. The body lives in ``_steps/wait.tsx``.
 */
"use client";

import { WaitStep } from "../_steps/wait";

export default function OnboardingWaitPage() {
  return <WaitStep />;
}
