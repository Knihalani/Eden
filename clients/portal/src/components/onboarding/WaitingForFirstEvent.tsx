"use client";

/**
 * Lightweight wait-for-first-event empty state.
 * Reuses EmptyState; surfaces doctor commands + a poll/refetch CTA.
 * Optional ``firstTraceAt`` (onboarding v2) adjusts copy when ingest
 * already recorded an event that has not landed in the list yet.
 */

import { useState, type ReactNode } from "react";
import { Activity, Check, Copy, Radio } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { FIRST_EVENT_WAIT } from "@/lib/portal-polish";
import { cn } from "@/lib/utils";

export function DoctorCommandChip({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      aria-label={`Copy ${command}`}
      className={cn(
        "group inline-flex max-w-full items-center gap-space-2 rounded-lg border border-[var(--border-default)]",
        "bg-[var(--bg-tertiary)] px-space-3 py-space-2 text-left font-mono text-xs text-[var(--text-secondary)]",
        "hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-primary)]",
      )}
    >
      <code className="min-w-0 truncate">{command}</code>
      <span className="shrink-0 text-[var(--text-muted)] group-hover:text-[var(--accent)]">
        {copied ? (
          <Check className="h-3.5 w-3.5 text-[var(--success)]" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )}
      </span>
    </button>
  );
}

export function WaitingForFirstEvent({
  onCheck,
  checking = false,
  firstTraceAt = null,
  secondaryActions,
  className,
  "data-testid": testId = "waiting-for-first-event",
}: {
  onCheck: () => void;
  checking?: boolean;
  /** ISO timestamp from onboarding v2 ``first_trace_at`` when present. */
  firstTraceAt?: string | null;
  secondaryActions?: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  const received = Boolean(firstTraceAt);
  const title = received
    ? FIRST_EVENT_WAIT.titleReceived
    : FIRST_EVENT_WAIT.title;
  const description = received
    ? FIRST_EVENT_WAIT.descriptionReceived
    : FIRST_EVENT_WAIT.description;

  return (
    <div data-testid={testId} className={className}>
      <EmptyState
        icon={received ? Activity : Radio}
        title={title}
        description={description}
        size="lg"
        className={cn(!received && "live-append-pulse")}
        action={
          <div className="flex flex-col items-center gap-space-3">
            {!received ? (
              <div className="flex w-full flex-col items-center gap-space-2">
                <p className="m-0 text-2xs uppercase tracking-wide text-[var(--text-faint)]">
                  {FIRST_EVENT_WAIT.doctorHint}
                </p>
                <div className="flex w-full max-w-md flex-col flex-wrap items-stretch justify-center gap-space-2 sm:flex-row sm:items-center">
                  <DoctorCommandChip command={FIRST_EVENT_WAIT.doctorNpx} />
                  <DoctorCommandChip command={FIRST_EVENT_WAIT.doctorPython} />
                </div>
              </div>
            ) : null}
            <Button
              onClick={onCheck}
              loading={checking}
              className="min-h-11"
              aria-label={FIRST_EVENT_WAIT.checkCta}
            >
              <Radio className="h-4 w-4" aria-hidden />
              {FIRST_EVENT_WAIT.checkCta}
            </Button>
            {secondaryActions ? (
              <div className="flex flex-wrap items-center justify-center gap-space-2">
                {secondaryActions}
              </div>
            ) : null}
          </div>
        }
      />
    </div>
  );
}
