"use client";

/**
 * DemoBanner — dismissible notice shown when the traces feed contains
 * Eden-seeded demo data (agent_id LIKE 'demo-%').
 *
 * Mounts above the traces list (never inside it — another agent owns that
 * component). Dismissed persistently via localStorage so it stays gone
 * across page navigations for the current browser.
 *
 * Hidden while:
 *   - the org is still resolving (avoids a flash-of-banner)
 *   - the user has dismissed it
 */

import { useState } from "react";
import { X, FlaskConical } from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";

const LS_KEY = "eden:onboarding:demo-banner-dismissed";

function isDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(LS_KEY) === "1";
}

export function DemoBanner() {
  const { currentOrg, loading: orgLoading, orgSyncing } = useOrg();
  const [dismissed, setDismissed] = useState<boolean>(isDismissed);

  if (orgLoading || orgSyncing || !currentOrg) return null;
  if (dismissed) return null;

  function dismiss() {
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_KEY, "1");
    }
    setDismissed(true);
  }

  return (
    <div
      role="region"
      aria-label="Demo data notice"
      className="sticky top-0 z-20 border-b border-[color-mix(in_srgb,var(--warning,#f59e0b)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning,#f59e0b)_8%,transparent)]"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-2 text-xs sm:text-sm">
        <FlaskConical
          className="h-4 w-4 shrink-0 text-[var(--warning,#f59e0b)]"
          aria-hidden
        />
        <span className="font-medium text-[var(--text-primary)]">
          Demo data
        </span>
        <span className="text-[var(--text-muted)]" aria-hidden>
          ·
        </span>
        <span className="min-w-0 truncate text-[var(--text-secondary)]">
          These traces were seeded by Eden to help you explore the
          product.{" "}
          <span className="hidden sm:inline">
            They will disappear automatically once your first real traces
            arrive.
          </span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={dismiss}
          aria-label="Dismiss demo data banner"
          className="ml-auto min-h-11 min-w-11 shrink-0 !px-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
