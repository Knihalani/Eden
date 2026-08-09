"use client";

/**
 * Improve plan detail — Evidence section (C11-style citations).
 *
 * Reads the raw ``ImprovementPlan.evidence`` payload (tolerant: keys are
 * written by several backend producers — issue_patch_trigger, planner,
 * agent sweeps) and renders tier / static checks / sandbox tests / CI
 * chips plus cited trace links via citation-href.
 */

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { ImprovementPlan } from "@/lib/api/resources";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";
import { citationHref, citationLabel } from "@/lib/citation-href";
import { StatusChip } from "@/components/ds/primitives";

type Evidence = Record<string, unknown>;

function readStr(ev: Evidence, key: string): string | null {
  const v = ev[key];
  return typeof v === "string" && v ? v : null;
}

function readNum(ev: Evidence, key: string): number | null {
  const v = ev[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readBool(ev: Evidence, key: string): boolean | null {
  const v = ev[key];
  return typeof v === "boolean" ? v : null;
}

function readStrArray(ev: Evidence, key: string): string[] {
  const v = ev[key];
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

function formatDetailValue(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (v === null || v === undefined) return "—";
  return String(v);
}

/** "static_passed" (honest label) with legacy "passed" accepted. */
function staticCheckTone(status: string): "ok" | "fail" | "neutral" {
  if (/passed|ok|success/i.test(status)) return "ok";
  if (/fail|error/i.test(status)) return "fail";
  return "neutral";
}

export function planTraceIds(
  plan: ImprovePlanFixture,
  raw: ImprovementPlan | null,
): string[] {
  const ev = (raw?.evidence ?? {}) as Evidence;
  const fromEvidence = Array.isArray(ev.example_trace_ids)
    ? (ev.example_trace_ids as unknown[]).filter(
        (t): t is string => typeof t === "string" && t.length > 0,
      )
    : [];
  return Array.from(new Set([...fromEvidence, ...plan.traceIds]));
}

export function PlanEvidencePanel({
  plan,
  raw,
}: {
  plan: ImprovePlanFixture;
  raw: ImprovementPlan | null;
}) {
  const ev = (raw?.evidence ?? {}) as Evidence;

  const tier = readStr(ev, "evidence_tier") ?? plan.evidenceTier ?? null;
  const staticStatus =
    readStr(ev, "hermetic_preverify") ?? plan.hermeticStatus ?? null;
  const severity = readStr(ev, "severity");
  const confidence = readNum(ev, "confidence");
  const failurePack =
    readStr(ev, "failure_pack_status") ?? plan.failurePackStatus ?? null;

  const sandbox = ev.sandbox_tests as Evidence | null | undefined;
  const sandboxStatus =
    sandbox && typeof sandbox === "object"
      ? (readStr(sandbox, "status") ?? readStr(sandbox, "result"))
      : null;
  const sandboxSynthesized =
    sandbox && typeof sandbox === "object" && sandbox.synthesized === true;

  // CI: approve/auto-merge writes evidence.auto_merge; some producers use
  // ci / ci_status. All optional — render only what's present.
  const autoMerge =
    ev.auto_merge && typeof ev.auto_merge === "object"
      ? (ev.auto_merge as Evidence)
      : null;
  const ciStatus =
    readStr(ev, "ci_status") ??
    (autoMerge
      ? (readStr(autoMerge, "ci_status") ?? readStr(autoMerge, "status"))
      : null);

  // M15 auto-merge eligibility gate (AutoMergeDecision.to_evidence()) —
  // reasons / blocked_by are computed per-gate server-side but were never
  // rendered; surface them verbatim so a reviewer can see *why* a plan
  // did or didn't ride the auto-merge ladder.
  const autoMergeEligible = autoMerge ? readBool(autoMerge, "eligible") : null;
  const autoMergeBlockedBy = autoMerge ? readStr(autoMerge, "blocked_by") : null;
  const autoMergeReasons = autoMerge ? readStrArray(autoMerge, "reasons") : [];
  const autoMergeDetails =
    autoMerge && autoMerge.details && typeof autoMerge.details === "object"
      ? (autoMerge.details as Evidence)
      : null;
  const hasAutoMergeDecision = autoMergeEligible != null;
  const autoMergeMerged = autoMerge ? readBool(autoMerge, "merged") : null;
  const autoMergeManual = autoMerge ? readBool(autoMerge, "manual") : null;
  const manualMerge =
    ev.manual_merge && typeof ev.manual_merge === "object"
      ? (ev.manual_merge as Evidence)
      : null;
  const operatorRevert =
    ev.operator_revert && typeof ev.operator_revert === "object"
      ? (ev.operator_revert as Evidence)
      : null;
  const guardianAction = readStr(ev, "guardian_action") ?? readStr(ev, "guardian");
  const rawStatus = raw?.status ?? null;

  const traceIds = planTraceIds(plan, raw);
  const hasChips =
    tier != null ||
    staticStatus != null ||
    sandboxStatus != null ||
    ciStatus != null ||
    failurePack != null ||
    severity != null ||
    confidence != null ||
    autoMergeMerged != null ||
    guardianAction != null ||
    manualMerge != null ||
    operatorRevert != null;

  const supervisionLabel = (() => {
    if (rawStatus === "merged" || autoMergeMerged) {
      return autoMergeManual ? "merged (manual)" : "merged";
    }
    if (operatorRevert || guardianAction === "revert" || guardianAction === "auto_revert") {
      return "reverted";
    }
    if (rawStatus === "rejected" || rawStatus === "closed") {
      return "blocked";
    }
    if (autoMergeBlockedBy) {
      return `blocked (${autoMergeBlockedBy})`;
    }
    return null;
  })();

  return (
    <section
      aria-label="Plan evidence"
      className="border border-[var(--line)] bg-[var(--bg)] px-4 py-3 sm:px-5"
    >
      <h3 className="type-ui">Evidence</h3>
      {!hasChips && traceIds.length === 0 && !hasAutoMergeDecision ? (
        <p className="type-meta mt-2">
          No evidence attached — this plan was created without a failure
          pack or verification run.
        </p>
      ) : (
        <>
          {supervisionLabel ? (
            <div className="mt-2">
              <StatusChip
                tone={
                  supervisionLabel.startsWith("merged")
                    ? "ok"
                    : supervisionLabel.startsWith("reverted") ||
                        supervisionLabel.startsWith("blocked")
                      ? "fail"
                      : "neutral"
                }
              >
                supervision: {supervisionLabel}
              </StatusChip>
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {tier ? <StatusChip tone="neutral">tier: {tier}</StatusChip> : null}
            {staticStatus ? (
              <StatusChip tone={staticCheckTone(staticStatus)}>
                static checks: {staticStatus}
              </StatusChip>
            ) : null}
            {sandboxStatus ? (
              <StatusChip tone={staticCheckTone(sandboxStatus)}>
                sandbox tests: {sandboxStatus}
                {sandboxSynthesized ? " (synthesized)" : ""}
              </StatusChip>
            ) : null}
            {ciStatus ? (
              <StatusChip tone={staticCheckTone(ciStatus)}>
                CI: {ciStatus}
              </StatusChip>
            ) : null}
            {failurePack ? (
              <StatusChip tone="neutral">failure pack: {failurePack}</StatusChip>
            ) : null}
            {severity ? (
              <StatusChip tone={severity === "high" ? "fail" : "neutral"}>
                severity: {severity}
              </StatusChip>
            ) : null}
            {confidence != null ? (
              <StatusChip tone="neutral">
                confidence: {(confidence * 100).toFixed(0)}%
              </StatusChip>
            ) : null}
          </div>
          {traceIds.length > 0 ? (
            <div className="mt-3">
              <p className="type-label">Cited traces</p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {traceIds.map((traceId) => {
                  const target = { kind: "trace" as const, id: traceId };
                  return (
                    <li key={traceId}>
                      <Link
                        href={citationHref(target)}
                        className="ds-btn ds-btn-outline ds-btn-sm"
                      >
                        {citationLabel(target)}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {hasAutoMergeDecision ? (
            <div className="mt-3 border-t border-[var(--line)] pt-3">
              <p className="type-label">Auto-merge decision</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <StatusChip tone={autoMergeEligible ? "ok" : "fail"}>
                  {autoMergeEligible ? "eligible" : "not eligible"}
                </StatusChip>
                {autoMergeBlockedBy ? (
                  <StatusChip tone="fail">
                    blocked by: {autoMergeBlockedBy}
                  </StatusChip>
                ) : null}
              </div>
              {autoMergeReasons.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {autoMergeReasons.map((r, i) => (
                    <li
                      key={`${r}_${i}`}
                      className="type-mono !text-[0.7rem] text-[var(--text-secondary)]"
                    >
                      {r}
                    </li>
                  ))}
                </ul>
              ) : null}
              {autoMergeDetails && Object.keys(autoMergeDetails).length > 0 ? (
                <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                  {Object.entries(autoMergeDetails).map(([k, v]) =>
                    v === null || v === undefined ? null : (
                      <div key={k} className="flex items-baseline gap-1">
                        <dt className="type-meta">{k}:</dt>
                        <dd className="type-meta text-[var(--text)]">
                          {formatDetailValue(v)}
                        </dd>
                      </div>
                    ),
                  )}
                </dl>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
