"use client";

/**
 * FEAT-30 gap 4 — the F39 nudges promote/demote lifecycle previously had
 * zero portal surface: nudge candidates, shadow status, and promotion
 * outcomes were invisible in the product. Renders alongside the Improve
 * queue so a reviewer can see what the autonomous nudge pipeline is
 * doing without leaving the Improve surface.
 *
 * Backend: `GET/POST .../nudges` (F39, `src/eden/api/routes/learn.py`)
 * and `GET .../promotions` (F41 evidence-gate queue,
 * `src/eden/promotion/evidence_gate.py`).
 */

import { useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKey } from "@/lib/query-keys";
import {
  nudgesApi,
  promotionsApi,
  type EvidenceReport,
} from "@/lib/api/resources";
import { SHELL_QUERY } from "@/lib/portal-query";
import { StatusChip } from "@/components/ds/primitives";
import { EmptyState } from "@/lab/lab-ui";
import { useLabToast } from "@/lab/lab-toast";

function nudgeModeTone(mode: string): "ok" | "fail" | "neutral" {
  if (mode === "promoted") return "ok";
  if (mode === "archived") return "fail";
  return "neutral";
}

function candidateStatusTone(status: string): "ok" | "fail" | "neutral" {
  if (status === "promoted") return "ok";
  if (status === "rejected" || status === "demoted") return "fail";
  return "neutral";
}

export function NudgesPromotionsPanel({
  orgId,
  agentId,
}: {
  orgId: string | null;
  agentId: string;
}) {
  const { pushToast } = useLabToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, EvidenceReport>>(
    {},
  );

  const scopedAgentId = agentId === "all" ? undefined : agentId;
  const nudgesQuery = useOrgQuery(
    queryKey("nudges", orgId, scopedAgentId ?? null),
    orgId,
    () => nudgesApi.list(orgId!, scopedAgentId),
    { ...SHELL_QUERY, enabled: Boolean(orgId) },
  );
  const promotionsQuery = useOrgQuery(
    queryKey("promotions", orgId, null),
    orgId,
    () => promotionsApi.list(orgId!),
    { ...SHELL_QUERY, enabled: Boolean(orgId) },
  );

  if (!orgId) return null;

  const nudges = nudgesQuery.data?.data?.nudges ?? [];
  const candidates = promotionsQuery.data?.data?.promotions ?? [];
  const candidateByNudgeId = new Map(
    candidates
      .filter((c) => c.kind === "nudge")
      .map((c) => [String(c.ref_id), c] as const),
  );

  async function handlePromote(nudgeId: string) {
    if (!orgId) return;
    setBusyId(nudgeId);
    try {
      const res = await nudgesApi.promote(orgId, nudgeId);
      const report = res?.data?.report;
      if (report) {
        setOutcomes((prev) => ({ ...prev, [nudgeId]: report }));
      }
      pushToast({
        title: res?.data?.promoted ? "Nudge promoted" : "Promotion held",
        body: report
          ? (report.recommendation ?? report.gate_verdict ?? report.explanation)
          : undefined,
        tone: res?.data?.promoted ? "ok" : "accent",
      });
      nudgesQuery.refetch();
      promotionsQuery.refetch();
    } catch (err) {
      pushToast({
        title: "Couldn't promote nudge",
        body: err instanceof Error ? err.message : String(err),
        tone: "fail",
      });
    } finally {
      setBusyId(null);
    }
  }

  async function handleArchive(nudgeId: string) {
    if (!orgId) return;
    setBusyId(nudgeId);
    try {
      await nudgesApi.archive(orgId, nudgeId);
      pushToast({ title: "Nudge archived", tone: "ok" });
      nudgesQuery.refetch();
    } catch (err) {
      pushToast({
        title: "Couldn't archive nudge",
        body: err instanceof Error ? err.message : String(err),
        tone: "fail",
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section
      aria-label="Nudges & promotions"
      className="border border-[var(--line)] bg-[var(--bg)] px-4 py-3 sm:px-5"
    >
      <h3 className="type-ui">Nudges &amp; promotions</h3>
      <p className="type-meta mt-0.5">
        F39 runtime nudges and their shadow → promoted lifecycle
        (evidence-gate outcomes below).
      </p>
      {nudgesQuery.isLoading || promotionsQuery.isLoading ? (
        <p className="type-meta mt-2">Loading nudges…</p>
      ) : nudges.length === 0 ? (
        <div className="mt-2">
          <EmptyState
            title="No nudges yet"
            body="Runtime nudges created from failure signals will appear here with their shadow / promoted / archived status."
          />
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {nudges.map((n) => {
            const candidate = candidateByNudgeId.get(n.id);
            const outcome = outcomes[n.id];
            const isBusy = busyId === n.id;
            return (
              <li
                key={n.id}
                className="border-t border-[var(--line)] pt-2 first:border-t-0 first:pt-0"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="type-ui">{n.name}</span>
                  <StatusChip tone={nudgeModeTone(n.mode)}>
                    {n.mode}
                  </StatusChip>
                  <span className="type-meta">
                    {n.agent_id} · {n.action_type}
                  </span>
                  {candidate ? (
                    <StatusChip tone={candidateStatusTone(candidate.status)}>
                      promotion: {candidate.status}
                    </StatusChip>
                  ) : null}
                </div>
                {outcome ? (
                  <p className="type-meta mt-1">
                    Last evaluation: {outcome.passed ? "passed" : "held"}
                    {outcome.recommendation
                      ? ` — ${outcome.recommendation}`
                      : ""}
                    {outcome.explanation ? ` (${outcome.explanation})` : ""}
                  </p>
                ) : null}
                {n.mode === "shadow" ? (
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      type="button"
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                      disabled={isBusy}
                      onClick={() => handlePromote(n.id)}
                    >
                      Promote
                    </button>
                    <button
                      type="button"
                      className="ds-btn ds-btn-ghost ds-btn-sm"
                      disabled={isBusy}
                      onClick={() => handleArchive(n.id)}
                    >
                      Archive
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
