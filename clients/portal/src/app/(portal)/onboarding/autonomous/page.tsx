"use client";

import { useEffect } from "react";

/**
 * Legacy route — autonomous disclosure step removed from main wizard.
 * Redirect to connect-repo (step 2).
 */
export default function OnboardingAutonomousPage() {
  useEffect(() => {
    window.location.replace("/onboarding/connect");
  }, []);

  return (
    <div className="flex min-h-[40vh] items-center justify-center text-sm text-[var(--text-muted)]">
      Redirecting…
    </div>
  );
}
