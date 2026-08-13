"use client";

/**
 * Wave 5 (5.1) — prompt canary cockpit (F-E: "no experiment cards /
 * traffic / history" was the gap).
 *
 * Renders every prompt canary experiment in the org as a card: agent,
 * control vs candidate version, live traffic %, elapsed, status — with
 * promote (evidence-gate gated on the backend, W25) and rollback actions
 * and the gate report when a promote is held. Backend:
 * `GET /orgs/{orgId}/prompts/canaries` + the per-agent promote/rollback
 * routes (`src/eden/api/routes/prompt_canary.py`).
 */

import { useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey } from "@/lib/query-keys";
import { promptsApi, type CanaryExperiment } from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useLabToast } from "@/lab/lab-toast";

function statusTone(status: string): "ok" | "fail" | "neutral" {
  if (status === "promoted") return "ok";
  if (status === "rolled_back") return "fail";
  return "neutral";
}

function elapsedSince(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const start = new Date(iso).getTime();
  if (Number.isNaN(start)) return null;
  const mins = Math.round((Date.now() - start) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Traffic-split bounds per backend ``CanaryUpdateRequest`` (ge=1, le=50). */
const SPLIT_MIN = 1;
const SPLIT_MAX = 50;
const SPLIT_STEP = 5;

function ExperimentCard({
  exp,
  busy,
  disabled,
  splitPct,
  onSplitPctChange,
  onSplitUpdate,
  onPromote,
  onRollback,
}: {
  exp: CanaryExperiment;
  busy: boolean;
  disabled: boolean;
  /** Draft traffic-split % controlled by the parent. */
  splitPct: number;
  onSplitPctChange: (pct: number) => void;
  onSplitUpdate: () => void;
  onPromote: () => void;
  onRollback: () => void;
}) {
  const active = exp.status === "active";
  const elapsed = elapsedSince(exp.started_at);
  return (
    <li className="border-t border-[var(--line)] pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="type-ui">{exp.agent}</span>
        <StatusChip tone={statusTone(exp.status)}>{exp.status}</StatusChip>
        <span className="type-meta text-[var(--text-faint)]">
          {exp.status === "promoted" || exp.status === "rolled_back"
            ? `v${exp.candidate_version} ended`
            : `v${exp.candidate_version} vs control v${exp.control_version ?? 0}`}
        </span>
        {active ? (
          <span className="type-ui text-[var(--text)]">
            {exp.traffic_pct}% traffic
          </span>
        ) : null}
        {/* W3-9: show if split was locally adjusted but not yet submitted */}
        {active && splitPct !== exp.traffic_pct ? (
          <span className="type-meta text-[var(--text-faint)]">
            → {splitPct}% pending
          </span>
        ) : null}
        {elapsed ? (
          <span className="type-meta text-[var(--text-faint)]">
            {exp.status === "active" ? `running ${elapsed}` : `${elapsed} ago`}
          </span>
        ) : null}
      </div>
      {exp.notes ? (
        <p className="type-meta mt-0.5">{exp.notes}</p>
      ) : null}
      {active ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {/* W3-9: traffic-split slider (1–50 %, step 5). Promote handles >50. */}
          <label className="flex items-center gap-1.5">
            <span className="type-meta text-[var(--text-faint)]">Split %</span>
            <input
              type="range"
              min={SPLIT_MIN}
              max={SPLIT_MAX}
              step={SPLIT_STEP}
              value={splitPct}
              onChange={(e) => onSplitPctChange(Number(e.target.value))}
              disabled={busy || disabled}
              aria-label={`Traffic split for ${exp.agent}`}
              className="w-24 accent-[var(--accent)]"
            />
            <span className="type-ui w-8 tabular-nums">{splitPct}%</span>
          </label>
          {splitPct !== exp.traffic_pct ? (
            <button
              type="button"
              className="ds-btn ds-btn-ghost ds-btn-sm"
              disabled={busy || disabled}
              onClick={onSplitUpdate}
            >
              Set split
            </button>
          ) : null}
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            disabled={busy || disabled}
            onClick={onPromote}
          >
            Promote to 100%
          </button>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            disabled={busy || disabled}
            onClick={onRollback}
          >
            Roll back
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function CanaryCockpit({ orgId }: { orgId: string | null }) {
  const { pushToast } = useLabToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [heldReports, setHeldReports] = useState<Record<string, string>>({});
  /** W3-9: draft traffic-split values, keyed by experiment_id. Initialised
   *  from exp.traffic_pct on first render; cleared after a successful update. */
  const [pendingSplits, setPendingSplits] = useState<Record<string, number>>({});

  const canariesQuery = useOrgQuery(
    queryKey("promptCanaries", orgId, null),
    orgId,
    () => promptsApi.listCanaries(orgId!),
    { ...SHELL_QUERY, enabled: Boolean(orgId) },
  );

  if (!orgId) return null;
  const canaries = canariesQuery.data?.canaries ?? [];

  /** W3-9: adjust the traffic-split % without promoting. */
  async function runSplitUpdate(exp: CanaryExperiment) {
    if (!orgId) return;
    const pct = pendingSplits[exp.experiment_id] ?? exp.traffic_pct;
    setBusyId(exp.experiment_id);
    try {
      await promptsApi.updateSplit(orgId, exp.agent, exp.experiment_id, pct);
      setPendingSplits((prev) => {
        const next = { ...prev };
        delete next[exp.experiment_id];
        return next;
      });
      canariesQuery.refetch();
      pushToast({
        title: "Traffic split updated",
        body: `${exp.agent} canary is now at ${pct}% traffic.`,
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: "Couldn't update split",
        body: err instanceof Error ? err.message : String(err),
        tone: "fail",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function runAction(
    exp: CanaryExperiment,
    action: "promote" | "rollback",
  ) {
    if (!orgId) return;
    setBusyId(exp.experiment_id);
    try {
      if (action === "promote") {
        const res = await promptsApi.promote(orgId, exp.agent, exp.experiment_id);
        const gate = res?.evidence_gate;
        if (res.status === "held" && gate) {
          const why =
            gate.recommendation ||
            gate.explanation ||
            `needs ${gate.min_sample_size ?? "more"} samples`;
          setHeldReports((prev) => ({
            ...prev,
            [exp.experiment_id]: why,
          }));
          pushToast({
            title: "Promotion held by evidence gate",
            body: why,
            tone: "accent",
          });
        } else {
          pushToast({
            title: "Canary promoted to 100%",
            body: `v${exp.candidate_version} is now live for ${exp.agent}.`,
            tone: "ok",
          });
        }
      } else {
        await promptsApi.rollback(orgId, exp.agent, exp.experiment_id);
        pushToast({
          title: "Canary rolled back",
          body: `Traffic for ${exp.agent} fell back to the control.`,
          tone: "ok",
        });
      }
      canariesQuery.refetch();
    } catch (err) {
      pushToast({
        title: action === "promote" ? "Couldn't promote canary" : "Couldn't roll back canary",
        body: err instanceof Error ? err.message : String(err),
        tone: "fail",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section
      aria-label="Prompt canary cockpit"
      className="border border-[var(--line)] bg-[var(--bg)] px-4 py-3 sm:px-5"
    >
      <h3 className="type-ui">Prompt canaries</h3>
      <p className="type-meta mt-0.5">
        Version experiments split live traffic between a control and a
        candidate prompt. Promote flips the winner to 100% — the evidence
        gate (W25) holds the flip until it passes.
      </p>
      {canariesQuery.isLoading ? (
        <p className="type-meta mt-2">Loading canaries…</p>
      ) : canaries.length === 0 ? (
        <div className="mt-2">
          <EmptyState
            title="No canary experiments"
            body="Prompt canaries created by the evolution loop or the prompts API will appear here with their traffic split and promote/rollback controls."
          />
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {canaries.map((exp) => {
            const held = heldReports[exp.experiment_id];
            return (
              <div key={exp.experiment_id}>
                <ExperimentCard
                  exp={exp}
                  busy={busyId === exp.experiment_id}
                  disabled={Boolean(busyId)}
                  splitPct={pendingSplits[exp.experiment_id] ?? exp.traffic_pct}
                  onSplitPctChange={(pct) =>
                    setPendingSplits((prev) => ({
                      ...prev,
                      [exp.experiment_id]: pct,
                    }))
                  }
                  onSplitUpdate={() => void runSplitUpdate(exp)}
                  onPromote={() => void runAction(exp, "promote")}
                  onRollback={() => void runAction(exp, "rollback")}
                />
                {/* A held report only applies while the experiment is
                    still active — a later promote/rollback retires it. */}
                {held && exp.status === "active" ? (
                  <p className="type-meta mt-1 text-[var(--text)]">
                    Evidence gate: {held}
                  </p>
                ) : null}
              </div>
            );
          })}
        </ul>
      )}
    </section>
  );
}
