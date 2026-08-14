"use client";

import { useState } from "react";
import Link from "next/link";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";
import { countEventRows } from "@/lib/named-object";
import { useLabToast } from "@/lab/lab-toast";

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
  onCheck: () => void | Promise<unknown>;
  checking?: boolean;
  /** Home already links Traces in the primary bar — can hide here. */
  showTracesLink?: boolean;
  primaryCreateKey?: boolean;
}) {
  const { pushToast } = useLabToast();
  const [busy, setBusy] = useState(false);
  const pending = Boolean(checking || busy);

  async function handleCheck() {
    if (pending) return;
    setBusy(true);
    try {
      const result = await onCheck();
      const n = countEventRows(result);
      if (n > 0) {
        pushToast({
          title: n === 1 ? "1 event found" : `${n} events found`,
          tone: "ok",
        });
      } else {
        pushToast({
          title: "No events yet",
          body: FIRST_EVENT_WAIT.doctorHint,
          tone: "default",
        });
      }
    } catch (err) {
      pushToast({
        title: "Could not check for events",
        body: err instanceof Error ? err.message : "Try again.",
        tone: "fail",
      });
    } finally {
      setBusy(false);
    }
  }

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
          onClick={() => void handleCheck()}
          disabled={pending}
        >
          {pending ? "Checking…" : FIRST_EVENT_WAIT.checkCta}
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
