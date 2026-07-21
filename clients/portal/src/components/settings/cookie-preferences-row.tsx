"use client";

/**
 * Quiet Settings Privacy row — re-opens cookie consent (2A).
 * No fixed post-choice pill; this is the authenticated withdraw path.
 */

import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-card";
import { openCookiePreferences } from "@/lib/analytics";

export function CookiePreferencesRow() {
  return (
    <SettingsCard
      title="Cookie preferences"
      description="Change or withdraw analytics cookie consent."
    >
      <div
        className="flex items-center justify-between gap-4 flex-wrap"
        data-testid="cookie-preferences-row"
        data-cookie-preferences-row=""
      >
        <p className="text-sm text-[var(--text-secondary)] max-w-xl">
          Essential cookies stay on. Analytics cookies follow your choice —
          update it any time without leaving Settings.
        </p>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => openCookiePreferences()}
        >
          Manage cookies
        </Button>
      </div>
    </SettingsCard>
  );
}
