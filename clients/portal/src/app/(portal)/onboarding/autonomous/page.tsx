"use client";

/**
 * /onboarding/autonomous — Step 2 in the onboarding flow.
 *
 * Surfaces the autonomous-features-on-by-default disclosure
 * before the new user hits the dashboard. Renders the
 * ``_steps/autonomous.tsx`` step.
 */
import AutonomousStep from "../_steps/autonomous";

export default function OnboardingAutonomousPage() {
  return <AutonomousStep />;
}
