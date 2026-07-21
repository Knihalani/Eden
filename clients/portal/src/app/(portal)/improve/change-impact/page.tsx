"use client";

import Link from "next/link";
import { useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  GitCompareArrows,
  Play,
} from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { CoreResourcePage } from "@/components/portal-os";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Panel } from "@/components/ui/panel";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { changeImpactApi } from "@/lib/api";
import {
  FEATURE_NOT_ENABLED_MESSAGE,
  FEATURE_NOT_ENABLED_TITLE,
  isFeatureFlagOffError,
} from "@/lib/feature-flag-error";
import { errorFromCaught } from "@/lib/safe-error-message";
import { cn } from "@/lib/utils";

type ImpactReport = {
  recommendation?: string;
  recommendation_reasons?: string[];
  traces_replayed?: number;
  trajectory_divergence_rate?: number;
  new_predicted_stumbles?: number;
  cost_delta_pct?: number | null;
  latency_delta_pct?: number | null;
  regression_eval?: Record<string, unknown>;
  top_divergences?: Array<Record<string, unknown>>;
  policy_tier?: string;
  change_id?: string;
};

const REC_META: Record<
  string,
  { label: string; tone: string; icon: typeof CheckCircle2 }
> = {
  safe: {
    label: "Safe to ship",
    tone: "text-[var(--terminal)] border-[var(--terminal)]/40 bg-[var(--terminal)]/5",
    icon: CheckCircle2,
  },
  auto_merge_safe: {
    label: "Auto-merge safe",
    tone: "text-[var(--terminal)] border-[var(--terminal)]/40 bg-[var(--terminal)]/5",
    icon: CheckCircle2,
  },
  review_required: {
    label: "Review required",
    tone: "text-[var(--warning)] border-[var(--warning)]/40 bg-[var(--warning)]/5",
    icon: AlertTriangle,
  },
  unknown: {
    label: "Needs review",
    tone: "text-[var(--warning)] border-[var(--warning)]/40 bg-[var(--warning)]/5",
    icon: AlertTriangle,
  },
  block: {
    label: "Block merge",
    tone: "text-[var(--error)] border-[var(--error)]/40 bg-[var(--error)]/5",
    icon: Ban,
  },
};

function pct(n: unknown): string {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * (Math.abs(n) <= 1 ? 100 : 1)).toFixed(1)}%`;
}

export default function ChangeImpactPage() {
  const { currentOrg, authError } = useOrg();
  const toast = useToast();
  const [changeId, setChangeId] = useState("local-preview-1");
  const [agentId, setAgentId] = useState("");
  const [files, setFiles] = useState("prompts/checkout.yaml");
  const [report, setReport] = useState<ImpactReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!currentOrg?.id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await changeImpactApi.preview(currentOrg.id, {
        change_id: changeId,
        changed_files: files
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean),
        agent_id: agentId || undefined,
      });
      setReport((res.data?.report as ImpactReport) || null);
      toast.success("Impact preview generated");
    } catch (e) {
      if (isFeatureFlagOffError(e)) {
        setError(FEATURE_NOT_ENABLED_TITLE);
        toast.error(FEATURE_NOT_ENABLED_TITLE, FEATURE_NOT_ENABLED_MESSAGE);
      } else {
        const msg = errorFromCaught(e, "Preview failed");
        setError(msg);
        toast.error(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  if (!currentOrg && !authError) return <NoOrgState feature="Change impact" />;
  if (!currentOrg) return null;

  const rec = String(report?.recommendation ?? "review_required");
  const meta = REC_META[rec] ?? REC_META.review_required;
  const RecIcon = meta.icon;

  return (
    <div className="contents" data-wave8-improve-advanced="completed">
      <CoreResourcePage
        size="wide"
        header={
          <PageHeader
            eyebrow="Advanced · Improve"
            title="Change impact preview"
            subtitle="Replay stratified production traffic before prompt or model changes land."
            icon={GitCompareArrows}
            actions={
              <nav
                data-testid="change-impact-related-strip"
                aria-label="Related"
                className="flex flex-wrap items-center gap-x-space-3 gap-y-1 text-xs text-[var(--text-muted)]"
              >
                <Link href="/improve" className="text-[var(--accent)] hover:underline">
                  Improve
                </Link>
                <Link
                  href="/improve/scorecard"
                  className="text-[var(--accent)] hover:underline"
                >
                  Scorecard
                </Link>
                <Link
                  href="/ledger?tab=promotions"
                  className="text-[var(--accent)] hover:underline"
                >
                  Promotions
                </Link>
              </nav>
            }
          />
        }
        toolbar={undefined}
        table={
          <div className="space-y-space-4">
            <Panel
              tone="flat"
              padding="md"
              className="space-y-3"
              data-testid="change-impact-preview"
            >
              <FormField label="Change ID" htmlFor="change-id">
                <Input
                  id="change-id"
                  value={changeId}
                  onChange={(e) => setChangeId(e.target.value)}
                />
              </FormField>
              <FormField label="Agent ID (optional)" htmlFor="agent-id">
                <Input
                  id="agent-id"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  placeholder="checkout-agent"
                />
              </FormField>
              <FormField label="Changed files (comma-separated)" htmlFor="files">
                <Input
                  id="files"
                  value={files}
                  onChange={(e) => setFiles(e.target.value)}
                />
              </FormField>
              <Button
                onClick={() => void run()}
                disabled={busy}
                loading={busy}
                className="min-h-11"
                data-testid="change-impact-run"
              >
                <Play className="h-3.5 w-3.5" /> Run preview
              </Button>
            </Panel>

            <div data-testid="change-impact-result">
              {error ? (
                <ErrorState
                  className="mb-4"
                  title={
                    error === FEATURE_NOT_ENABLED_TITLE
                      ? FEATURE_NOT_ENABLED_TITLE
                      : "Preview failed"
                  }
                  message={
                    error === FEATURE_NOT_ENABLED_TITLE
                      ? FEATURE_NOT_ENABLED_MESSAGE
                      : error
                  }
                  action={
                    error === FEATURE_NOT_ENABLED_TITLE ? undefined : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void run()}
                      >
                        Try again
                      </Button>
                    )
                  }
                />
              ) : null}

              {!report && !error && !busy ? (
                <EmptyState
                  title="No result yet"
                  description="Fill the preview form above and run once. Needs production traces for meaningful replay — divergence, cost Δ, and ship/block recommendation appear here."
                  action={
                    <Button asChild variant="outline" className="min-h-11">
                      <Link href="/traces">Open Traces</Link>
                    </Button>
                  }
                />
              ) : null}

              {report ? (
                <div className="space-y-4">
                  <Panel
                    tone="flat"
                    padding="md"
                    className={cn("flex items-start gap-3 border", meta.tone)}
                  >
                    <RecIcon className="mt-0.5 h-5 w-5 shrink-0" />
                    <div>
                      <p className="text-sm font-semibold">{meta.label}</p>
                      <p className="mt-1 text-xs opacity-80">
                        Policy tier {String(report.policy_tier ?? "T2")} · change{" "}
                        <code>{String(report.change_id ?? changeId)}</code>
                      </p>
                      {(report.recommendation_reasons ?? []).length > 0 ? (
                        <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
                          {(report.recommendation_reasons ?? []).map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </Panel>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Panel tone="flat" padding="sm">
                      <p className="text-xs text-[var(--text-muted)]">Traces replayed</p>
                      <p className="text-lg font-semibold">
                        {String(report.traces_replayed ?? 0)}
                      </p>
                    </Panel>
                    <Panel tone="flat" padding="sm">
                      <p className="text-xs text-[var(--text-muted)]">
                        Trajectory divergence
                      </p>
                      <p className="text-lg font-semibold">
                        {pct(report.trajectory_divergence_rate)}
                      </p>
                    </Panel>
                    <Panel tone="flat" padding="sm">
                      <p className="text-xs text-[var(--text-muted)]">Cost Δ</p>
                      <p className="text-lg font-semibold">
                        {pct(report.cost_delta_pct)}
                      </p>
                    </Panel>
                    <Panel tone="flat" padding="sm">
                      <p className="text-xs text-[var(--text-muted)]">Latency Δ</p>
                      <p className="text-lg font-semibold">
                        {pct(report.latency_delta_pct)}
                      </p>
                    </Panel>
                  </div>

                  {(report.top_divergences ?? []).length > 0 ? (
                    <Panel tone="flat" padding="md">
                      <h3 className="mb-2 text-sm font-medium">Top divergences</h3>
                      <ul className="space-y-2 text-sm">
                        {(report.top_divergences ?? []).slice(0, 8).map((d, i) => (
                          <li key={i} className="text-[var(--text-secondary)]">
                            {String(d.summary ?? d.trace_id ?? JSON.stringify(d))}
                            {d.trace_id ? (
                              <>
                                {" · "}
                                <Link
                                  href={`/traces?traceId=${encodeURIComponent(String(d.trace_id))}`}
                                  className="text-[var(--accent)] hover:underline"
                                >
                                  Open trace
                                </Link>
                              </>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </Panel>
                  ) : null}

                  {report.regression_eval &&
                  Object.keys(report.regression_eval).length > 0 ? (
                    <Panel tone="flat" padding="md">
                      <h3 className="mb-2 text-sm font-medium">Regression eval</h3>
                      <dl className="grid gap-2 text-xs sm:grid-cols-2">
                        {Object.entries(report.regression_eval).map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-4">
                            <dt className="text-[var(--text-muted)]">
                              {k.replace(/_/g, " ")}
                            </dt>
                            <dd className="font-medium">{String(v)}</dd>
                          </div>
                        ))}
                      </dl>
                    </Panel>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        }
      />
    </div>
  );
}
