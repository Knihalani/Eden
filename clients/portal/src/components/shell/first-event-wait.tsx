"use client";

import Link from "next/link";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";

/**
 * Shared CTA block for first-run empty states (Home + Traces).
 * Create key → doctor → check/refetch → Traces.
 */
export function FirstEventWaitAction({
  onCheck,
  checking,
  showTracesLink = true,
  primaryCreateKey = true,
}: {
  onCheck: () => void;
  checking?: boolean;
  /** Home already links Traces in the primary bar — can hide here. */
  showTracesLink?: boolean;
  primaryCreateKey?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Link
          href="/settings?mode=keys"
          className={
            primaryCreateKey
              ? "ds-btn ds-btn-primary ds-btn-sm"
              : "ds-btn ds-btn-outline ds-btn-sm"
          }
        >
          Create API key
        </Link>
        <button
          type="button"
          className="ds-btn ds-btn-outline ds-btn-sm"
          onClick={onCheck}
          disabled={checking}
        >
          {checking ? "Checking…" : FIRST_EVENT_WAIT.checkCta}
        </button>
        {showTracesLink ? (
          <Link href="/traces" className="ds-btn ds-btn-ghost ds-btn-sm">
            Traces
          </Link>
        ) : null}
      </div>
      <div className="space-y-1 text-center">
        <p className="type-meta text-[var(--text-muted)]">
          {FIRST_EVENT_WAIT.doctorHint}
        </p>
        <p className="type-mono text-[0.6875rem] text-[var(--text-secondary)]">
          {FIRST_EVENT_WAIT.doctorPython}
        </p>
        <p className="type-mono text-[0.6875rem] text-[var(--text-secondary)]">
          {FIRST_EVENT_WAIT.doctorNpx}
        </p>
      </div>
    </div>
  );
}
