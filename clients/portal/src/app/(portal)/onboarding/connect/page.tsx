/**
 * /onboarding/connect — Step 4: GitHub repo link.
 *
 * Thin route wrapper. The body lives in ``_steps/connect.tsx``
 * (shared with the standalone /agents/connect deep-link).
 */
"use client";

import { ConnectStep } from "../_steps/connect";

export default function OnboardingConnectPage() {
  return <ConnectStep />;
}
