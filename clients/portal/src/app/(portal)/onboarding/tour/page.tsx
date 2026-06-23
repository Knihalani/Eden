/**
 * /onboarding/tour — Visual tour of the portal.
 *
 * Thin route wrapper. The body lives in ``_steps/tour.tsx``.
 */
"use client";

import { TourStep } from "../_steps/tour";

export default function OnboardingTourPage() {
  return <TourStep />;
}
