"use client";

import { cn } from "@/lib/utils";
import {
  ShieldCheck,
  AlertTriangle,
  AlertOctagon,
  CheckCircle2,
  XCircle,
  Bug,
  FileLock2,
} from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { SeverityBadge } from "@/components/ui/status-badge";
import type { EvaluateResult, InjectionResult, RedactResult } from "./types";
import { GuardrailsQueueBridge } from "./guardrails-queue-bridge";

/** Wave 6.4 — kit Panel/Badge result surfaces (no hand-rolled 3-card walls). */
export function EvaluateResultCard({ result }: { result: EvaluateResult }) {
  const enforced = result.live === true;
  const blocked = result.verdict === "block" || result.verdict === "escalate";
  const failed = enforced && !result.passed;
  const badgeVariant = !enforced
    ? "warning"
    : result.passed
      ? "success"
      : "error";
  const badgeLabel = !enforced
    ? "Not enforced"
    : result.passed
      ? "Passed"
      : `${result.violations.length} violation${result.violations.length === 1 ? "" : "s"}`;

  return (
    <div className="space-y-space-3" data-testid="guardrails-evaluate-result">
      <Panel tone="inset" padding="none" className="overflow-hidden">
        <div
          className={cn(
            "px-space-4 py-space-3 flex items-center justify-between gap-space-2 border-b border-[var(--border-subtle)]",
            !enforced
              ? "bg-[var(--warning-bg)]"
              : result.passed
                ? "bg-[var(--terminal-faint)]"
                : "bg-[var(--error-bg)]",
          )}
        >
          <div className="flex items-center gap-2">
            {!enforced ? (
              <AlertTriangle className="w-4 h-4 text-[var(--warning)]" aria-hidden />
            ) : result.passed ? (
              <CheckCircle2 className="w-4 h-4 text-[var(--terminal)]" aria-hidden />
            ) : (
              <XCircle className="w-4 h-4 text-[var(--error)]" aria-hidden />
            )}
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Policy evaluation
            </h3>
          </div>
          <Badge variant={badgeVariant}>{badgeLabel}</Badge>
        </div>
        <div className="p-space-4">
          {!enforced ? (
            <div className="text-center py-space-4">
              <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-[var(--warning)]" aria-hidden />
              <p className="text-sm font-medium text-[var(--text-primary)]">
                {blocked ? "Fail closed — not live-evaluated" : "Not live-evaluated"}
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {result.reason
                  ? result.reason.replace(/_/g, " ")
                  : "Incomplete or unevaluated policies — result is not a live pass"}
              </p>
            </div>
          ) : result.violations.length === 0 ? (
            <div className="text-center py-space-4">
              <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-[var(--terminal)]" aria-hidden />
              <p className="text-sm font-medium text-[var(--text-primary)]">
                All policies passed
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                No violations detected
              </p>
            </div>
          ) : (
            <ul className="space-y-space-2">
              {result.violations.map((v, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-start justify-between gap-space-2 rounded-lg bg-[var(--bg-secondary)] px-space-3 py-space-2"
                >
                  <div className="min-w-0">
                    <span className="text-xs font-mono text-[var(--text-muted)] truncate block max-w-[200px]">
                      {v.policy_id}
                    </span>
                    <p className="text-sm text-[var(--text-primary)]">{v.reason}</p>
                  </div>
                  <SeverityBadge severity={v.severity} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>
      {failed ? (
        <GuardrailsQueueBridge reason="Policy violations need an Improve action." />
      ) : null}
    </div>
  );
}

export function InjectionResultCard({ result }: { result: InjectionResult }) {
  const scorePct = Math.round((result.injection_score ?? 0) * 100);
  const isHot = result.is_injection || scorePct >= 50;
  const ringColor = isHot
    ? "text-[var(--error)]"
    : scorePct >= 25
      ? "text-[var(--warning)]"
      : "text-[var(--terminal)]";

  return (
    <div className="space-y-space-3" data-testid="guardrails-injection-result">
      <Panel tone="inset" padding="none" className="overflow-hidden">
        <div
          className={cn(
            "px-space-4 py-space-3 flex items-center justify-between gap-space-2 border-b border-[var(--border-subtle)]",
            isHot ? "bg-[var(--error-bg)]" : "bg-[var(--terminal-faint)]",
          )}
        >
          <div className="flex items-center gap-2">
            {isHot ? (
              <Bug className="w-4 h-4 text-[var(--error)]" aria-hidden />
            ) : (
              <ShieldCheck className="w-4 h-4 text-[var(--terminal)]" aria-hidden />
            )}
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              Injection scan
            </h3>
          </div>
          <Badge variant={isHot ? "error" : "success"}>
            {isHot ? "Detected" : "Clean"}
          </Badge>
        </div>
        <div className="p-space-4 space-y-space-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--text-muted)] uppercase tracking-wide font-medium">
              Injection score
            </span>
            <span className={cn("text-2xl font-bold tabular-nums", ringColor)}>
              {scorePct}%
            </span>
          </div>
          <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                isHot
                  ? "bg-[var(--error)]"
                  : scorePct >= 25
                    ? "bg-[var(--warning)]"
                    : "bg-[var(--terminal)]",
              )}
              style={{ width: `${Math.max(scorePct, 2)}%` }}
            />
          </div>
          {result.matched_patterns.length > 0 ? (
            <div>
              <p className="text-xs uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-1.5">
                Matched patterns
              </p>
              <div className="flex flex-wrap gap-1.5">
                {result.matched_patterns.map((p, i) => (
                  <Badge key={i} variant="error" className="gap-1">
                    <AlertOctagon className="w-3 h-3" aria-hidden />
                    {p}
                  </Badge>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-xs text-[var(--text-muted)] italic">
              No patterns matched
            </p>
          )}
        </div>
      </Panel>
      {isHot ? (
        <GuardrailsQueueBridge reason="Injection detected — open Improve to harden defenses." />
      ) : null}
    </div>
  );
}

export function RedactResultCard({ result }: { result: RedactResult }) {
  const totalCount = result.redactions.reduce((sum, r) => sum + r.count, 0);
  return (
    <div data-testid="guardrails-redact-result">
      <Panel tone="inset" padding="none" className="overflow-hidden">
        <div className="px-space-4 py-space-3 border-b border-[var(--border-subtle)] bg-[var(--warning-bg)]/30 flex items-center justify-between gap-space-2">
          <div className="flex items-center gap-2">
            <FileLock2 className="w-4 h-4 text-[var(--warning)]" aria-hidden />
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              PII redaction
            </h3>
          </div>
          <Badge variant="warning">{totalCount} masked</Badge>
        </div>
        <div className="p-space-4 space-y-space-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-1.5">
              Redacted content
            </p>
            <pre className="text-xs font-mono bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-32 whitespace-pre-wrap break-words text-[var(--text-primary)]">
              {result.redacted_content}
            </pre>
          </div>
          {result.redactions.length > 0 ? (
            <div>
              <p className="text-xs uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-1.5">
                By category
              </p>
              <ul className="space-y-1">
                {result.redactions.map((r, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between text-xs px-2.5 py-1.5 rounded-md bg-[var(--bg-secondary)]"
                  >
                    <span className="font-medium text-[var(--text-primary)] capitalize">
                      {r.category.replace(/_/g, " ")}
                    </span>
                    <span className="font-mono text-[var(--warning)] tabular-nums">
                      ×{r.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
