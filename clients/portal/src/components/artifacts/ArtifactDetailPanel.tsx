"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Panel } from "@/components/ui/panel";
import {
  issueHref,
  promotionsHref,
  tracesFilteredHref,
} from "@/lib/portal-cross-links";
import { learnApi } from "@/lib/api";
import { cn } from "@/lib/utils";

export type ArtifactDetail = {
  id?: string;
  name?: string;
  mode?: string;
  agent_id?: string;
  content?: string;
  trigger?: Record<string, unknown>;
  action_type?: string;
  source_issue_id?: string | null;
  evidence?: Record<string, unknown>;
  cost?: { est_usd_per_month?: number; value_score?: number; est_tokens_per_match?: number };
};

type DetailTab = "overview" | "outcomes" | "export";

export type ArtifactGateVerdict = "ready" | "review" | "collecting";

/** Derive promote-gate status from evidence + cost (Wave 4 hard boundary). */
export function deriveArtifactGate(opts: {
  evidence?: Record<string, unknown>;
  cost?: ArtifactDetail["cost"];
}): {
  n: number;
  minN: number;
  passed: boolean;
  lowValue: boolean;
  verdict: ArtifactGateVerdict;
  /** Hard block — Promote CTA disabled until samples collect or override. */
  blocked: boolean;
} {
  const { evidence, cost } = opts;
  const n = Number(evidence?.n ?? evidence?.sample_count ?? 0);
  const minN = Number(evidence?.min_n ?? 30);
  const passed = Boolean(evidence?.passed ?? evidence?.gate_pass);
  const lowValue = (cost?.value_score ?? 1) < 0.05;
  const verdict: ArtifactGateVerdict = passed
    ? "ready"
    : n >= minN
      ? "review"
      : "collecting";
  return {
    n,
    minN,
    passed,
    lowValue,
    verdict,
    blocked: verdict === "collecting",
  };
}

interface ArtifactDetailPanelProps {
  artifact: ArtifactDetail;
  orgId: string;
  onPromote?: () => void;
  onArchive?: () => void;
  showPromote?: boolean;
  /** Promote in flight / parent disables while dialog open. */
  promoteBusy?: boolean;
}

export function EvidenceGatePanel({
  evidence,
  cost,
}: {
  evidence?: Record<string, unknown>;
  cost?: ArtifactDetail["cost"];
}) {
  const gate = deriveArtifactGate({ evidence, cost });
  const pct = gate.minN > 0 ? Math.min(100, (gate.n / gate.minN) * 100) : 0;
  const statusLabel =
    gate.verdict === "ready"
      ? "READY TO PROMOTE"
      : gate.verdict === "review"
        ? "REVIEW GATE"
        : "COLLECTING";

  return (
    <div className="space-y-3 text-sm" data-testid="artifact-evidence-gates">
      <div>
        <div className="mb-1 flex justify-between text-xs text-[var(--text-muted)]">
          <span>Min samples</span>
          <span className="tabular-nums">
            {gate.n}/{gate.minN}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-tertiary)]">
          <div
            className="h-full bg-[var(--accent)] transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <dl className="grid gap-2 text-xs">
        <div className="flex justify-between gap-4">
          <dt className="text-[var(--text-muted)]">Effect size</dt>
          <dd>
            {evidence?.effect_size != null
              ? String(evidence.effect_size)
              : gate.passed
                ? "OK"
                : "Collecting"}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-[var(--text-muted)]">Regressions</dt>
          <dd>{evidence?.regressions_ok === false ? "Detected" : "None"}</dd>
        </div>
        {cost?.est_usd_per_month != null ? (
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--text-muted)]">Est. cost</dt>
            <dd>~${cost.est_usd_per_month}/mo</dd>
          </div>
        ) : null}
        {cost?.value_score != null ? (
          <div className="flex justify-between gap-4">
            <dt className="text-[var(--text-muted)]">Value score</dt>
            <dd className={cn(gate.lowValue && "text-[var(--warning-strong)]")}>
              {cost.value_score}
              {gate.lowValue ? " (low)" : ""}
            </dd>
          </div>
        ) : null}
      </dl>
      <p
        className="text-xs font-medium text-[var(--text-secondary)]"
        data-testid="artifact-gate-verdict"
        data-verdict={gate.verdict}
      >
        Status: {statusLabel}
      </p>
      {gate.blocked ? (
        <p className="text-xs text-[var(--text-muted)]" data-testid="artifact-gate-hold">
          Promote blocked under min samples — need {gate.minN} before the CTA unlocks.
        </p>
      ) : null}
    </div>
  );
}

/** Hard boundary: evidence gates always sit above the Promote CTA. */
function PromoteBoundary({
  artifact,
  onPromote,
  promoteBusy,
}: {
  artifact: ArtifactDetail;
  onPromote?: () => void;
  promoteBusy?: boolean;
}) {
  const gate = deriveArtifactGate({
    evidence: artifact.evidence,
    cost: artifact.cost,
  });

  return (
    <Panel
      tone="inset"
      padding="md"
      className="mx-4 mt-4"
      data-testid="artifact-promote-boundary"
      data-gate={gate.verdict}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-faint)]">
        Promote boundary
      </p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        Evidence gates must be visible before promote. Shadow stays shadow until gates pass
        or you accept a review hold.
      </p>
      <div className="mt-3">
        <EvidenceGatePanel evidence={artifact.evidence} cost={artifact.cost} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {onPromote ? (
          <Button
            size="sm"
            onClick={onPromote}
            disabled={gate.blocked || promoteBusy}
            data-testid="artifact-promote-cta"
            title={
              gate.blocked
                ? `Need ${gate.minN} samples before promote`
                : gate.verdict === "review"
                  ? "Gates need review — promote may be held"
                  : undefined
            }
          >
            Promote
          </Button>
        ) : null}
        <Link
          href={promotionsHref()}
          className="text-xs text-[var(--accent)] hover:underline"
          data-testid="artifact-ledger-promotions-scent"
        >
          Ledger · Promotions
        </Link>
      </div>
    </Panel>
  );
}

export function ArtifactDetailPanel({
  artifact,
  orgId,
  onPromote,
  onArchive,
  showPromote,
  promoteBusy,
}: ArtifactDetailPanelProps) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [exportYaml, setExportYaml] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);

  const loadExport = useCallback(async () => {
    if (!artifact.agent_id) return;
    setExportBusy(true);
    try {
      const res = await learnApi.exportArtifactsYaml(orgId, artifact.agent_id);
      setExportYaml((res.data as { yaml?: string })?.yaml ?? "");
    } finally {
      setExportBusy(false);
    }
  }, [orgId, artifact.agent_id]);

  const tabs: { id: DetailTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "outcomes", label: "Outcomes" },
    { id: "export", label: "Export" },
  ];

  return (
    <div className="flex h-full flex-col">
      {showPromote ? (
        <PromoteBoundary
          artifact={artifact}
          onPromote={onPromote}
          promoteBusy={promoteBusy}
        />
      ) : null}
      <nav
        aria-label="Artifact links"
        className="flex flex-wrap items-center gap-x-space-3 gap-y-1 border-b border-[var(--border-subtle)] px-4 py-2 text-xs text-[var(--text-muted)]"
      >
        {artifact.source_issue_id ? (
          <Link
            href={issueHref(artifact.source_issue_id)}
            className="text-[var(--accent)] hover:underline"
          >
            Source issue
          </Link>
        ) : null}
        {artifact.agent_id ? (
          <Link
            href={tracesFilteredHref({ agent_id: artifact.agent_id })}
            className="text-[var(--accent)] hover:underline"
          >
            Matching traces
          </Link>
        ) : null}
        <Link href={promotionsHref()} className="text-[var(--accent)] hover:underline">
          Ledger · Promotions
        </Link>
      </nav>
      <div className="flex gap-1 border-b border-[var(--border-default)] px-4">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              if (t.id === "export" && !exportYaml) void loadExport();
            }}
            className={
              tab === t.id
                ? "border-b-2 border-[var(--accent)] px-2 py-2 text-xs font-medium"
                : "px-2 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {tab === "overview" && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2 text-xs text-[var(--text-muted)]">
              <span className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5">
                {artifact.mode ?? "shadow"}
              </span>
              {artifact.action_type ? (
                <span className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5">
                  {artifact.action_type}
                </span>
              ) : null}
              {artifact.agent_id ? (
                <span className="font-mono">{artifact.agent_id}</span>
              ) : null}
            </div>
            <pre className="whitespace-pre-wrap rounded bg-[var(--bg-secondary)] p-3 text-xs">
              {String(artifact.content ?? "")}
            </pre>
            {artifact.trigger ? (
              <div>
                <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">
                  Trigger DSL
                </div>
                <pre className="whitespace-pre-wrap rounded border border-[var(--border-default)] p-2 text-xs">
                  {JSON.stringify(artifact.trigger, null, 2)}
                </pre>
              </div>
            ) : null}
            {onArchive ? (
              <div className="flex flex-wrap gap-2 pt-2">
                <Button size="sm" variant="outline" onClick={onArchive}>
                  Archive
                </Button>
              </div>
            ) : null}
          </div>
        )}
        {tab === "outcomes" && (
          <EmptyState
            size="sm"
            variant="plain"
            title="Shadow outcomes"
            description="After shadow fires match production traces, outcome rows link back to the trace hub."
            action={
              artifact.agent_id ? (
                <Button size="sm" variant="outline" asChild>
                  <Link
                    href={tracesFilteredHref({
                      agent_id: artifact.agent_id,
                      outcome: "failure",
                    })}
                  >
                    View failure traces
                  </Link>
                </Button>
              ) : undefined
            }
          />
        )}
        {tab === "export" && (
          <div className="space-y-3">
            {exportBusy ? (
              <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
            ) : exportYaml ? (
              <>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--bg-secondary)] p-3 text-xs">
                  {exportYaml}
                </pre>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([exportYaml], { type: "text/yaml" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `artifacts-${artifact.agent_id ?? "export"}.yaml`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download className="mr-1 h-4 w-4" />
                  Download YAML
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void loadExport()}>
                Load export preview
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
