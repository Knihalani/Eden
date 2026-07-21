"use client";

import { FileCode } from "lucide-react";
import type { ImprovementPlan } from "@/lib/api";
import { Panel } from "@/components/ui/panel";

function evidenceEntries(evidence: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!evidence || typeof evidence !== "object") return [];
  return Object.entries(evidence)
    .slice(0, 12)
    .map(([k, v]) => [
      k,
      typeof v === "string" ? v : v == null ? "—" : JSON.stringify(v),
    ]);
}

/**
 * Plan review Summary pane — what changes / evidence / risk
 * (Braintrust Diff/Summary grammar on Eden plans).
 */
export function PlanSummaryPanel({ plan }: { plan: ImprovementPlan }) {
  const files = plan.files_changed ?? [];
  const evidence = evidenceEntries(plan.evidence);
  const triage = plan.triage_snapshot
    ? evidenceEntries(plan.triage_snapshot as Record<string, unknown>)
    : [];

  return (
    <div className="space-y-space-4" data-testid="plan-summary-panel">
      <section>
        <h3 className="mb-space-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          What changes
        </h3>
        <Panel tone="flat" padding="md" className="space-y-space-2">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            {plan.title || "Untitled improvement plan"}
          </p>
          {plan.summary ? (
            <p className="text-sm text-[var(--text-secondary)]">{plan.summary}</p>
          ) : (
            <p className="text-sm italic text-[var(--text-muted)]">No summary provided.</p>
          )}
          {files.length > 0 ? (
            <ul className="space-y-1 pt-space-1">
              {files.map((f) => (
                <li
                  key={f.path}
                  className="flex items-center gap-1.5 font-mono text-xs text-[var(--text-muted)]"
                >
                  <FileCode className="h-3 w-3 shrink-0" aria-hidden />
                  {f.path}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs italic text-[var(--text-muted)]">No files attached.</p>
          )}
        </Panel>
      </section>

      <section>
        <h3 className="mb-space-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Evidence
        </h3>
        <Panel tone="flat" padding="md" className="space-y-space-2">
          {plan.source_ref ? (
            <p className="font-mono text-xs text-[var(--text-muted)]">{plan.source_ref}</p>
          ) : null}
          {evidence.length === 0 && triage.length === 0 ? (
            <p className="text-sm italic text-[var(--text-muted)]">
              No evidence pack on this plan yet.
            </p>
          ) : (
            <dl className="space-y-space-1.5 text-xs">
              {evidence.map(([k, v]) => (
                <div key={`e-${k}`} className="grid grid-cols-[minmax(0,8rem)_1fr] gap-2">
                  <dt className="truncate text-[var(--text-muted)]">{k}</dt>
                  <dd className="break-all text-[var(--text-secondary)]">{v}</dd>
                </div>
              ))}
              {triage.map(([k, v]) => (
                <div key={`t-${k}`} className="grid grid-cols-[minmax(0,8rem)_1fr] gap-2">
                  <dt className="truncate text-[var(--text-muted)]">triage.{k}</dt>
                  <dd className="break-all text-[var(--text-secondary)]">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </Panel>
      </section>

      <section>
        <h3 className="mb-space-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          Risk
        </h3>
        <Panel tone="flat" padding="md" className="space-y-space-2 text-sm">
          <div className="flex flex-wrap gap-x-space-4 gap-y-1">
            <span className="text-[var(--text-muted)]">
              Blast{" "}
              <strong className="font-medium capitalize text-[var(--text-primary)]">
                {plan.estimated_blast_radius ?? "unknown"}
              </strong>
            </span>
            {plan.llm_cost_usd != null ? (
              <span className="text-[var(--text-muted)]">
                Plan cost{" "}
                <strong className="tabular-nums text-[var(--text-primary)]">
                  ${plan.llm_cost_usd.toFixed(4)}
                </strong>
              </span>
            ) : null}
            {plan.diff_edited ? (
              <span className="text-[var(--warning)]">Diff was edited before approve</span>
            ) : null}
          </div>
          {!plan.estimated_blast_radius && plan.llm_cost_usd == null ? (
            <p className="text-xs italic text-[var(--text-muted)]">
              No blast radius or cost estimate on this plan.
            </p>
          ) : null}
        </Panel>
      </section>
    </div>
  );
}
