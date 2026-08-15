"use client";

/**
 * Improve plan detail — change-impact preview.
 *
 * Wired live to ``POST /orgs/{org}/change-impact/preview`` (backend
 * src/eden/api/routes/change_impact.py → src/eden/change_impact/preview.py)
 * via the existing `changeImpactApi` namespace. The route is gated by the
 * ``change_impact_preview_v1`` feature flag — a flag-off / unavailable
 * response degrades to an explanatory placeholder instead of an error.
 *
 * Local draft plans (deep-link synthesized, no server record) keep a
 * disabled placeholder — there is nothing server-side to replay.
 */

import { useState } from "react";
import type { ImprovementPlan } from "@/lib/api/resources";
import { changeImpactApi } from "@/lib/api/resources";
import type { ImprovePlanFixture } from "@/lab/fixtures/improve";
import { planTraceIds } from "./plan-evidence-panel";

type ImpactReport = {
  change_id?: string;
  agent_id?: string | null;
  traces_replayed?: number;
  trajectory_divergence_rate?: number | null;
  new_predicted_stumbles?: number;
  recommendation?: string;
  recommendation_reasons?: string[];
  top_divergences?: Array<Record<string, unknown>>;
  policy_tier?: string | null;
  cost_delta_pct?: number;
  latency_delta_pct?: number;
};

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(0)}%`;
}

function isFeatureUnavailable(err: unknown): boolean {
  const status =
    (err as { status?: number; statusCode?: number } | null)?.status ??
    (err as { statusCode?: number } | null)?.statusCode;
  if (status === 403 || status === 404 || status === 503) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /403|404|503|feature|flag|forbidden|unavailable/i.test(msg);
}

export function PlanImpactPreview({
  orgId,
  plan,
  raw,
  isDraft,
}: {
  orgId: string | null;
  plan: ImprovePlanFixture;
  raw: ImprovementPlan | null;
  isDraft: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = isDraft || !orgId || busy;

  const runPreview = async () => {
    if (!orgId || isDraft) return;
    setBusy(true);
    setError(null);
    setUnavailable(null);
    try {
      const changedFiles = (raw?.files_changed ?? [])
        .map((f) => f.path)
        .filter(Boolean);
      const res = await changeImpactApi.preview(orgId, {
        change_id: plan.id,
        changed_files: changedFiles,
        agent_id: raw?.agent_id ?? plan.agentId ?? undefined,
        trace_ids: planTraceIds(plan, raw),
      });
      setReport((res.data?.report as ImpactReport | undefined) ?? {});
    } catch (err) {
      if (isFeatureUnavailable(err)) {
        setUnavailable(
          "Change-impact preview is not enabled for this workspace (change_impact_preview_v1) or its backing store is unavailable.",
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Preview impact"
      className="border border-[var(--line)] bg-[var(--bg)] px-4 py-3 sm:px-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="type-ui">Preview impact</h3>
          <p className="type-meta mt-0.5">
            Replay affected traces against this change before approving.
          </p>
        </div>
        <button
          type="button"
          className="ds-btn ds-btn-outline ds-btn-sm"
          disabled={disabled}
          title={
            isDraft
              ? "Local draft plans have no server record to replay — approve or reject first."
              : undefined
          }
          onClick={() => void runPreview()}
        >
          {busy ? "Previewing…" : "Preview impact"}
        </button>
      </div>

      {isDraft ? (
        <p className="type-meta mt-2">
          Unavailable for local draft plans.
        </p>
      ) : null}

      {unavailable ? <p className="type-meta mt-2">{unavailable}</p> : null}
      {error ? (
        <p className="type-meta mt-2 text-[var(--error)]">{error}</p>
      ) : null}

      {report ? (
        <div className="mt-3 space-y-2" data-testid="impact-report">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span className="type-meta">
              replayed{" "}
              <span className="text-[var(--text)]">
                {report.traces_replayed ?? 0}
              </span>{" "}
              traces
            </span>
            <span className="type-meta">
              divergence{" "}
              <span className="text-[var(--text)]">
                {pct(report.trajectory_divergence_rate)}
              </span>
            </span>
            <span className="type-meta">
              predicted stumbles{" "}
              <span
                className={
                  (report.new_predicted_stumbles ?? 0) > 0
                    ? "text-[var(--error)]"
                    : "text-[var(--text)]"
                }
              >
                {report.new_predicted_stumbles ?? 0}
              </span>
            </span>
            {report.cost_delta_pct != null ? (
              <span className="type-meta">
                cost Δ <span className="text-[var(--text)]">{pct(report.cost_delta_pct)}</span>
              </span>
            ) : null}
            {report.latency_delta_pct != null ? (
              <span className="type-meta">
                latency Δ{" "}
                <span className="text-[var(--text)]">
                  {pct(report.latency_delta_pct)}
                </span>
              </span>
            ) : null}
          </div>
          {report.recommendation ? (
            <p className="type-ui">
              Recommendation:{" "}
              <span
                className={
                  /block|reject|no/i.test(report.recommendation)
                    ? "text-[var(--error)]"
                    : "text-[var(--success)]"
                }
              >
                {report.recommendation}
              </span>
            </p>
          ) : null}
          {(report.recommendation_reasons ?? []).length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5">
              {(report.recommendation_reasons ?? []).map((r) => (
                <li key={r} className="type-meta">
                  {r}
                </li>
              ))}
            </ul>
          ) : null}
          {(report.top_divergences ?? []).length > 0 ? (
            <div>
              <p className="type-label">Top divergences</p>
              <ul className="mt-1 space-y-0.5">
                {(report.top_divergences ?? []).slice(0, 5).map((d, i) => (
                  <li key={i} className="type-meta font-mono text-[0.7rem]">
                    {JSON.stringify(d)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
