"use client";

import { useMemo, useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";
import { SeverityBadge } from "@/components/ui/status-badge";
import { NoOrgState } from "@/components/ui/no-org-state";
import { ErrorState } from "@/components/ui/error-state";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { useToast } from "@/components/ui/toast";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { interpretRedteamScan } from "@/lib/eval-run-outcome";
import { ChevronLeft, RefreshCw, ShieldAlert } from "lucide-react";
import { redteamApi, type RedteamFinding } from "@/lib/api";
import { GuardrailsQueueBridge } from "./guardrails-queue-bridge";
import { cn } from "@/lib/utils";

type DrillLevel = "summary" | "category" | "case";

function isFailedFinding(f: RedteamFinding): boolean {
  return f.failed !== false;
}

function groupByCategory(findings: RedteamFinding[]) {
  const map = new Map<string, RedteamFinding[]>();
  for (const f of findings) {
    const key = f.category?.trim() || "uncategorized";
    const list = map.get(key) ?? [];
    list.push(f);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([category, cases]) => {
      const failed = cases.filter(isFailedFinding).length;
      return { category, cases, failed, total: cases.length };
    })
    .sort((a, b) => b.failed - a.failed || b.total - a.total);
}

/**
 * Wave 6.2 — Promptfoo-style red-team report mode.
 * Drill: summary → category → case → raw I/O. No nested PageHeader.
 */
export function RedteamReport() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const toast = useToast();
  const [targetEndpoint, setTargetEndpoint] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [level, setLevel] = useState<DrillLevel>("summary");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  const {
    data: findings,
    isLoading: loading,
    error,
    refetch,
  } = useOrgQuery(
    queryKeys.redteam.findings(orgId),
    orgId,
    async () => {
      const res = await redteamApi.listFindings(orgId!);
      return res.findings ?? [];
    },
  );

  const rows = findings ?? [];
  const categories = useMemo(() => groupByCategory(rows), [rows]);
  const failedCount = useMemo(
    () => rows.filter(isFailedFinding).length,
    [rows],
  );
  const selectedCase = useMemo(
    () => rows.find((f) => f.id === selectedCaseId) ?? null,
    [rows, selectedCaseId],
  );
  const categoryCases = useMemo(() => {
    if (!selectedCategory) return [];
    const group = categories.find((c) => c.category === selectedCategory);
    const cases = group?.cases ?? [];
    return [...cases].sort((a, b) => {
      const af = isFailedFinding(a) ? 0 : 1;
      const bf = isFailedFinding(b) ? 0 : 1;
      return af - bf;
    });
  }, [categories, selectedCategory]);

  if (!currentOrg) return <NoOrgState feature="Red-team report" />;

  const submit = async () => {
    if (!targetEndpoint.trim() || !orgId) return;
    setSubmitting(true);
    setScanError(null);
    try {
      const res = await redteamApi.runScan(orgId, {
        target_endpoint: targetEndpoint.trim(),
        target_label: "portal-scan",
      });
      const outcome = interpretRedteamScan(res);
      if (outcome.kind === "empty") {
        setScanError(outcome.message);
        toast.error("Scan did not run", outcome.message);
        return;
      }
      if (outcome.kind === "findings") {
        toast.success(
          "Scan complete",
          `${outcome.findingCount} finding${outcome.findingCount === 1 ? "" : "s"} detected`,
        );
      } else {
        toast.success("Scan complete", "No findings — target resisted probes");
      }
      setTargetEndpoint("");
      setLevel("summary");
      setSelectedCategory(null);
      setSelectedCaseId(null);
      refetch();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to run scan";
      setScanError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const openCategory = (category: string) => {
    setSelectedCategory(category);
    setSelectedCaseId(null);
    setLevel("category");
  };

  const openCase = (id: string) => {
    setSelectedCaseId(id);
    setLevel("case");
  };

  const backToSummary = () => {
    setLevel("summary");
    setSelectedCategory(null);
    setSelectedCaseId(null);
  };

  const backToCategory = () => {
    setLevel("category");
    setSelectedCaseId(null);
  };

  return (
    <div
      className="space-y-space-4"
      data-testid="guardrails-redteam-report"
      data-wave6-improve-redteam-report="ready"
    >
      <div className="flex flex-wrap items-start justify-between gap-space-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-[var(--text-muted)]" aria-hidden />
            Red-team report
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Summary → category → case → I/O (failures first)
          </p>
        </div>
        <Button
          onClick={() => refetch()}
          variant="outline"
          className="min-h-11"
          disabled={loading}
          loading={loading}
          aria-label="Refresh findings"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </Button>
      </div>

      <div className="border-y border-[var(--border-subtle)] py-space-4">
        <div className="flex flex-col gap-space-3 sm:flex-row sm:items-end">
          <div className="w-full flex-1 space-y-space-1">
            <label
              htmlFor="redteam-report-endpoint"
              className="block text-xs font-medium text-[var(--text-muted)]"
            >
              Target endpoint
            </label>
            <Input
              id="redteam-report-endpoint"
              placeholder="Target endpoint URL (POST JSON { prompt })"
              value={targetEndpoint}
              onChange={(e) => setTargetEndpoint(e.target.value)}
              className="min-h-11 flex-1"
              aria-label="Target endpoint URL"
              disabled={submitting}
            />
          </div>
          <Button
            onClick={() => void submit()}
            disabled={!targetEndpoint.trim()}
            loading={submitting}
            className="min-h-11"
            aria-label="Run red team scan"
          >
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            Run scan
          </Button>
        </div>
      </div>

      {scanError ? (
        <ErrorState
          title="Could not start scan"
          message={scanError}
          action={
            <Button
              onClick={() => setScanError(null)}
              variant="outline"
              className="min-h-11"
            >
              Dismiss
            </Button>
          }
        />
      ) : null}

      <QueryState
        loading={loading && !findings}
        error={error}
        data={rows}
        onRetry={() => void refetch()}
        errorTitle="Could not load findings"
        isEmpty={(list) => list.length === 0}
        emptySlot={
          <EmptyState
            icon={ShieldAlert}
            title="No findings"
            description="Run a scan against a target endpoint to build a red-team report."
            variant="plain"
          />
        }
      >
        {() => (
          <div className="space-y-space-4">
            {/* Summary strip */}
            <Panel
              tone="flat"
              padding="md"
              className="flex flex-wrap gap-space-4"
              data-testid="redteam-report-summary"
            >
              <div>
                <p className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
                  Findings
                </p>
                <p className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">
                  {rows.length}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
                  Categories
                </p>
                <p className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">
                  {categories.length}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-[var(--text-muted)]">
                  Failed
                </p>
                <p
                  className={cn(
                    "text-lg font-semibold tabular-nums",
                    failedCount > 0
                      ? "text-[var(--error)]"
                      : "text-[var(--text-primary)]",
                  )}
                >
                  {failedCount}
                </p>
              </div>
            </Panel>

            {failedCount > 0 ? (
              <GuardrailsQueueBridge reason="Failed probes need an Improve action — open the queue to act." />
            ) : null}

            {/* Breadcrumb */}
            <nav
              aria-label="Report drill"
              className="flex flex-wrap items-center gap-space-1 text-xs text-[var(--text-muted)]"
              data-testid="redteam-report-breadcrumb"
            >
              <button
                type="button"
                className={cn(
                  "min-h-11 px-1 underline-offset-2 hover:underline",
                  level === "summary" && "text-[var(--text-primary)] font-medium",
                )}
                onClick={backToSummary}
              >
                Summary
              </button>
              {selectedCategory ? (
                <>
                  <span aria-hidden>/</span>
                  <button
                    type="button"
                    className={cn(
                      "min-h-11 px-1 underline-offset-2 hover:underline",
                      level === "category" &&
                        "text-[var(--text-primary)] font-medium",
                    )}
                    onClick={backToCategory}
                  >
                    {selectedCategory}
                  </button>
                </>
              ) : null}
              {selectedCase ? (
                <>
                  <span aria-hidden>/</span>
                  <span className="min-h-11 px-1 text-[var(--text-primary)] font-medium inline-flex items-center">
                    {selectedCase.probe_name}
                  </span>
                </>
              ) : null}
            </nav>

            {level === "summary" ? (
              <div
                className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]"
                data-testid="redteam-report-categories"
                role="list"
              >
                {categories.map((g) => (
                  <button
                    key={g.category}
                    type="button"
                    role="listitem"
                    className="flex w-full min-h-11 items-center justify-between gap-space-3 px-space-1 py-space-3 text-left hover:bg-[var(--bg-secondary)]/60"
                    onClick={() => openCategory(g.category)}
                    data-testid={`redteam-category-${g.category}`}
                  >
                    <div>
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {g.category}
                      </p>
                      <p className="text-xs text-[var(--text-muted)]">
                        {g.total} case{g.total === 1 ? "" : "s"}
                      </p>
                    </div>
                    <Badge variant={g.failed > 0 ? "error" : "success"}>
                      {g.failed} failed
                    </Badge>
                  </button>
                ))}
              </div>
            ) : null}

            {level === "category" ? (
              <div className="space-y-space-2" data-testid="redteam-report-cases">
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onClick={backToSummary}
                  aria-label="Back to summary"
                >
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                  All categories
                </Button>
                <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]" role="list">
                  {categoryCases.map((c) => {
                    const failed = isFailedFinding(c);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        role="listitem"
                        className="flex w-full min-h-11 items-center justify-between gap-space-3 px-space-1 py-space-3 text-left hover:bg-[var(--bg-secondary)]/60"
                        onClick={() => openCase(c.id)}
                        data-testid={`redteam-case-${c.id}`}
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                            {c.probe_name}
                          </p>
                          <p className="text-xs font-mono text-[var(--text-muted)] truncate">
                            {c.attack_prompt.slice(0, 96)}
                            {c.attack_prompt.length > 96 ? "…" : ""}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-space-2">
                          <SeverityBadge severity={c.severity} />
                          <Badge variant={failed ? "failed" : "success"}>
                            {failed ? "Fail" : "Pass"}
                          </Badge>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {level === "case" && selectedCase ? (
              <div className="space-y-space-3" data-testid="redteam-report-io">
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onClick={backToCategory}
                  aria-label="Back to category"
                >
                  <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                  {selectedCategory}
                </Button>
                <div className="flex flex-wrap items-center gap-space-2">
                  <SeverityBadge severity={selectedCase.severity} />
                  <Badge
                    variant={
                      isFailedFinding(selectedCase) ? "failed" : "success"
                    }
                  >
                    {isFailedFinding(selectedCase) ? "Fail" : "Pass"}
                  </Badge>
                  {selectedCase.detection_reason ? (
                    <span className="text-xs text-[var(--text-muted)]">
                      {selectedCase.detection_reason}
                    </span>
                  ) : null}
                </div>
                {isFailedFinding(selectedCase) ? (
                  <GuardrailsQueueBridge
                    reason="This case failed — send it to Improve to act."
                    testId="guardrails-queue-bridge-case"
                  />
                ) : null}
                <Panel tone="inset" padding="md" className="space-y-space-3">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-space-1">
                      Attack prompt
                    </p>
                    <pre className="text-xs font-mono whitespace-pre-wrap break-words text-[var(--text-primary)]">
                      {selectedCase.attack_prompt}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wider text-[var(--text-muted)] font-semibold mb-space-1">
                      Agent response
                    </p>
                    <pre className="text-xs font-mono whitespace-pre-wrap break-words text-[var(--text-primary)]">
                      {selectedCase.agent_response || "—"}
                    </pre>
                  </div>
                </Panel>
              </div>
            ) : null}
          </div>
        )}
      </QueryState>
    </div>
  );
}
