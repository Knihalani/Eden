"use client";

import Link from "next/link";
import { Bug } from "lucide-react";
import type { AgentStumble } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { traceHref, type TracePreserveParams } from "@/lib/portal-cross-links";

export function IssueTriagePanel({
  triageResult,
  stumbles,
  stumblesError,
  onStumblesRetry,
  preserve,
}: {
  triageResult?: Record<string, unknown> | null;
  stumbles: AgentStumble[];
  stumblesError?: string | null;
  onStumblesRetry?: () => void;
  preserve?: TracePreserveParams;
}) {
  const tr = (triageResult ?? {}) as Record<string, unknown>;
  const hasTriage = Object.keys(tr).length > 0;
  const evidenceSpans = Array.isArray(tr.evidence_span_ids)
    ? (tr.evidence_span_ids as unknown[]).map(String)
    : [];
  const suggestedActions = Array.isArray(tr.suggested_actions)
    ? (tr.suggested_actions as Record<string, unknown>[])
    : [];
  const linkedFiles = Array.isArray(tr.linked_files)
    ? (tr.linked_files as unknown[]).map(String)
    : [];
  const debuggerTraceId =
    typeof tr.debugger_trace_id === "string"
      ? tr.debugger_trace_id
      : stumbles.find((s) => s.trace_id)?.trace_id ?? null;
  const spanToTrace = new Map<string, string>();
  for (const s of stumbles) {
    if (s.span_id && s.trace_id) spanToTrace.set(String(s.span_id), String(s.trace_id));
  }
  const debugPreserve: TracePreserveParams | undefined = debuggerTraceId
    ? { ...preserve, view: "debug" }
    : preserve;

  if (!hasTriage) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <p className="text-sm text-[var(--text-muted)]">
            No triage result yet. Run “Re-triage” to investigate the root cause.
          </p>
        </div>
        {stumblesError ? (
          <ErrorState
            size="sm"
            title="Stumbles unavailable"
            message={stumblesError}
            action={
              onStumblesRetry ? (
                <Button variant="outline" size="sm" onClick={onStumblesRetry}>
                  Try again
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {stumblesError ? (
        <ErrorState
          size="sm"
          title="Stumbles unavailable"
          message={stumblesError}
          action={
            onStumblesRetry ? (
              <Button variant="outline" size="sm" onClick={onStumblesRetry}>
                Try again
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <div className="space-y-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Root cause</h2>
          {tr.source ? (
            <span className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5 text-2xs uppercase tracking-wide text-[var(--text-muted)]">
              {String(tr.source)}
            </span>
          ) : null}
          {typeof tr.confidence === "number" ? (
            <span className="text-2xs text-[var(--text-muted)]">
              confidence {(Number(tr.confidence) * 100).toFixed(0)}%
            </span>
          ) : null}
          {tr.auto_escalate ? (
            <span className="rounded bg-[var(--error-bg)] px-2 py-0.5 text-2xs uppercase text-[var(--error)]">
              auto-escalate
            </span>
          ) : null}
        </div>
        <p className="text-sm text-[var(--text-secondary)]">{String(tr.root_cause ?? "—")}</p>
        {debuggerTraceId ? (
          <Button size="sm" variant="secondary" asChild className="mt-2">
            <Link
              href={traceHref(debuggerTraceId, debugPreserve)}
              data-testid="issue-trace-link"
            >
              <Bug className="mr-1 h-3 w-3" /> Open debugger
            </Link>
          </Button>
        ) : null}
      </div>

      {suggestedActions.length > 0 ? (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <h2 className="mb-2 text-sm font-semibold">Suggested actions</h2>
          <ul className="space-y-2">
            {suggestedActions.map((a, i) => {
              const actionType = String(a.type ?? a.action_type ?? "action");
              const traceForDebugger =
                typeof a.trace_id === "string" ? a.trace_id : debuggerTraceId;
              return (
                <li
                  key={i}
                  className="flex flex-wrap items-center gap-2 rounded border border-[var(--border-subtle)] p-2"
                >
                  <span className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5 font-mono text-xs text-[var(--accent)]">
                    {actionType}
                  </span>
                  <span className="text-sm text-[var(--text-secondary)]">
                    {String(a.summary ?? "")}
                  </span>
                  {actionType === "debugger_rerun" && traceForDebugger ? (
                    <Link
                      href={traceHref(traceForDebugger, { ...preserve, view: "debug" })}
                      className="text-xs text-[var(--accent)] hover:underline"
                      data-testid="issue-trace-link"
                    >
                      Open debugger
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {evidenceSpans.length > 0 ? (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <h2 className="mb-2 text-sm font-semibold">Evidence spans</h2>
          <ul className="flex flex-wrap gap-2">
            {evidenceSpans.map((span) => {
              const tid = spanToTrace.get(span);
              return tid ? (
                <li key={span}>
                  <Link
                    href={traceHref(tid, preserve, { spanId: span })}
                    className="font-mono text-xs text-[var(--accent)] hover:underline"
                    data-testid="issue-trace-link"
                  >
                    {span}
                  </Link>
                </li>
              ) : (
                <li key={span} className="font-mono text-xs text-[var(--text-muted)]">
                  {span}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {linkedFiles.length > 0 ? (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
          <h2 className="mb-2 text-sm font-semibold">Linked files</h2>
          <ul className="space-y-1">
            {linkedFiles.map((f) => (
              <li key={f} className="font-mono text-xs text-[var(--text-secondary)]">
                {f}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
