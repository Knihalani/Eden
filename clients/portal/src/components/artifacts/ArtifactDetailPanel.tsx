"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { CrossLinkBar } from "@/components/portal-os/CrossLinkBar";
import {
  issueHref,
  promotionsHref,
  tracesFilteredHref,
} from "@/lib/portal-cross-links";
import { learnApi } from "@/lib/api";

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

type DetailTab = "overview" | "evidence" | "outcomes" | "export";

interface ArtifactDetailPanelProps {
  artifact: ArtifactDetail;
  orgId: string;
  onPromote?: () => void;
  onArchive?: () => void;
  showPromote?: boolean;
}

function EvidenceGatePanel({ evidence, cost }: { evidence?: Record<string, unknown>; cost?: ArtifactDetail["cost"] }) {
  const n = Number(evidence?.n ?? evidence?.sample_count ?? 0);
  const minN = Number(evidence?.min_n ?? 30);
  const passed = Boolean(evidence?.passed ?? evidence?.gate_pass);
  const pct = minN > 0 ? Math.min(100, (n / minN) * 100) : 0;

  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="mb-1 flex justify-between text-xs text-[var(--text-muted)]">
          <span>Min samples</span>
          <span>
            {n}/{minN}
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
          <dd>{evidence?.effect_size != null ? String(evidence.effect_size) : passed ? "✓ OK" : "Collecting"}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-[var(--text-muted)]">Regressions</dt>
          <dd>{evidence?.regressions_ok === false ? "✗ Detected" : "✓ None"}</dd>
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
            <dd>{cost.value_score}</dd>
          </div>
        ) : null}
      </dl>
      <p className="text-xs font-medium text-[var(--text-secondary)]">
        Status: {passed ? "READY TO PROMOTE" : n >= minN ? "REVIEW GATE" : "COLLECTING"}
      </p>
    </div>
  );
}

export function ArtifactDetailPanel({
  artifact,
  orgId,
  onPromote,
  onArchive,
  showPromote,
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

  const crossLinks = [
    ...(artifact.source_issue_id
      ? [{ label: "Source issue", href: issueHref(artifact.source_issue_id) }]
      : []),
    ...(artifact.agent_id
      ? [{ label: "Matching traces", href: tracesFilteredHref({ agent_id: artifact.agent_id }) }]
      : []),
    { label: "Promotions inbox", href: promotionsHref() },
  ];

  const tabs: { id: DetailTab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "evidence", label: "Evidence" },
    { id: "outcomes", label: "Outcomes" },
    { id: "export", label: "Export" },
  ];

  return (
    <div className="flex h-full flex-col">
      <CrossLinkBar links={crossLinks} />
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
              <span className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5">{artifact.mode ?? "shadow"}</span>
              {artifact.action_type ? (
                <span className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5">{artifact.action_type}</span>
              ) : null}
              {artifact.agent_id ? <span className="font-mono">{artifact.agent_id}</span> : null}
            </div>
            <pre className="whitespace-pre-wrap rounded bg-[var(--bg-secondary)] p-3 text-xs">
              {String(artifact.content ?? "")}
            </pre>
            {artifact.trigger ? (
              <div>
                <div className="mb-1 text-xs font-medium text-[var(--text-muted)]">Trigger DSL</div>
                <pre className="whitespace-pre-wrap rounded border border-[var(--border-default)] p-2 text-xs">
                  {JSON.stringify(artifact.trigger, null, 2)}
                </pre>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-2">
              {showPromote && onPromote ? (
                <Button size="sm" onClick={onPromote}>
                  Promote
                </Button>
              ) : null}
              {onArchive ? (
                <Button size="sm" variant="outline" onClick={onArchive}>
                  Archive
                </Button>
              ) : null}
            </div>
          </div>
        )}
        {tab === "evidence" && (
          <Card className="p-4">
            <EvidenceGatePanel evidence={artifact.evidence} cost={artifact.cost} />
            <Link
              href={promotionsHref()}
              className="mt-3 inline-block text-xs text-[var(--accent)] hover:underline"
            >
              Open promotions inbox →
            </Link>
          </Card>
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
                  <Link href={tracesFilteredHref({ agent_id: artifact.agent_id, outcome: "failure" })}>
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
