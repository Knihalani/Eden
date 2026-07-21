"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  ChevronRight,
  GitCompare,
  Sparkles,
  Wrench,
} from "lucide-react";
import { useOrg } from "@/hooks/use-org";
import {
  toolsApi,
  type ToolAttributionData,
  type ToolCompareData,
  type ToolRecommendData,
} from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryState } from "@/components/ui/query-state";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { errorFromCaught } from "@/lib/safe-error-message";

type Mode = "attribution" | "compare" | "recommender" | "taxonomy";

/** Thin Tools panel — underline modes only (no accent pill toggles / Card walls). */
export function ToolsPanel() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const [mode, setMode] = useState<Mode>("attribution");
  const [actionError, setActionError] = useState("");

  const taxonomyQuery = useOrgQuery(queryKeys.tools.taxonomy(orgId), orgId, () =>
    toolsApi.taxonomy(orgId!),
  );
  const allToolNames = useMemo(
    () => (taxonomyQuery.data?.tools ?? []).map((t) => t.tool_name).filter(Boolean),
    [taxonomyQuery.data],
  );

  const [toolId, setToolId] = useState("");
  const [attrWindow, setAttrWindow] = useState("30d");
  const [attribution, setAttribution] = useState<ToolAttributionData | null>(null);
  const [attrLoading, setAttrLoading] = useState(false);

  const [toolA, setToolA] = useState("");
  const [toolB, setToolB] = useState("");
  const [compareWindow, setCompareWindow] = useState("7d");
  const [comparison, setComparison] = useState<ToolCompareData | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const [taskType, setTaskType] = useState("");
  const [recommendations, setRecommendations] = useState<ToolRecommendData | null>(
    null,
  );
  const [recommendLoading, setRecommendLoading] = useState(false);

  async function runAttribution() {
    if (!orgId || !toolId.trim()) return;
    setAttrLoading(true);
    setActionError("");
    setAttribution(null);
    try {
      setAttribution(
        await toolsApi.attribution(orgId, {
          tool_id: toolId.trim(),
          window: attrWindow,
        }),
      );
    } catch (err) {
      setActionError(errorFromCaught(err, "Attribution failed"));
    } finally {
      setAttrLoading(false);
    }
  }

  async function runCompare() {
    if (!orgId || !toolA.trim() || !toolB.trim()) return;
    setCompareLoading(true);
    setActionError("");
    setComparison(null);
    try {
      setComparison(
        await toolsApi.compare(orgId, {
          tool_a: toolA.trim(),
          tool_b: toolB.trim(),
          window: compareWindow,
        }),
      );
    } catch (err) {
      setActionError(errorFromCaught(err, "Comparison failed"));
    } finally {
      setCompareLoading(false);
    }
  }

  async function runRecommend() {
    if (!orgId) return;
    setRecommendLoading(true);
    setActionError("");
    setRecommendations(null);
    try {
      setRecommendations(
        await toolsApi.recommend(orgId, {
          task_type: taskType.trim() || undefined,
          k: 3,
        }),
      );
    } catch (err) {
      setActionError(errorFromCaught(err, "Recommendation failed"));
    } finally {
      setRecommendLoading(false);
    }
  }

  const compareColumns: DataTableColumn<ToolCompareData["tools"][number]>[] = [
    {
      key: "tool_name",
      header: "Tool",
      cell: (r) => <span className="font-mono text-xs">{r.tool_name}</span>,
    },
    {
      key: "n_calls",
      header: "Calls",
      align: "right",
      cell: (r) => <span className="tabular-nums">{r.n_calls}</span>,
    },
    {
      key: "success_rate",
      header: "Success",
      align: "right",
      cell: (r) => (
        <span className="tabular-nums">
          {r.success_rate != null ? `${(r.success_rate * 100).toFixed(1)}%` : "—"}
        </span>
      ),
    },
    {
      key: "p95_ms",
      header: "p95",
      align: "right",
      cell: (r) => (
        <span className="tabular-nums">
          {r.p95_ms != null ? `${r.p95_ms.toFixed(0)} ms` : "—"}
        </span>
      ),
    },
  ];

  return (
    <div data-testid="analytics-tools-panel" data-wave6-analytics="tools-thin">
      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <TabsList
          variant="underline"
          aria-label="Tool intelligence modes"
          className="h-auto w-full justify-start gap-1 overflow-x-auto bg-transparent"
        >
          {(
            [
              { key: "attribution" as const, label: "Attribution", icon: Activity },
              { key: "compare" as const, label: "Compare", icon: GitCompare },
              { key: "recommender" as const, label: "Recommender", icon: Sparkles },
              { key: "taxonomy" as const, label: "Taxonomy", icon: ChevronRight },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <TabsTrigger
              key={key}
              value={key}
              variant="underline"
              className="flex items-center gap-1.5"
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {actionError ? (
        <p role="alert" className="mt-2 text-sm text-[var(--error)]">
          {actionError}
        </p>
      ) : null}

      <div className="mt-3 space-y-3">
        {mode === "attribution" ? (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1">
                <label htmlFor="attr-tool" className="text-xs text-[var(--text-muted)]">
                  Tool ID
                </label>
                <input
                  id="attr-tool"
                  list="tool-suggestions"
                  value={toolId}
                  onChange={(e) => setToolId(e.target.value)}
                  className="min-h-11 w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 font-mono text-sm"
                  placeholder="tool_id…"
                />
                <datalist id="tool-suggestions">
                  {allToolNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </div>
              <select
                value={attrWindow}
                onChange={(e) => setAttrWindow(e.target.value)}
                aria-label="Attribution window"
                className="min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 text-sm"
              >
                <option value="7d">7d</option>
                <option value="30d">30d</option>
                <option value="90d">90d</option>
              </select>
              <Button
                onClick={() => void runAttribution()}
                disabled={!toolId.trim()}
                loading={attrLoading}
              >
                Attribute
              </Button>
            </div>
            {attribution ? (
              attribution.n_calls === 0 ? (
                <EmptyState
                  icon={Wrench}
                  title="No tool telemetry"
                  description={`No calls for ${attribution.tool_name} in ${attribution.window}.`}
                  size="sm"
                />
              ) : (
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Metric label="Calls" value={String(attribution.n_calls)} />
                  <Metric
                    label="Success"
                    value={
                      attribution.success_rate != null
                        ? `${(attribution.success_rate * 100).toFixed(1)}%`
                        : "—"
                    }
                  />
                  <Metric
                    label="p95"
                    value={
                      attribution.p95_ms != null
                        ? `${attribution.p95_ms.toFixed(0)} ms`
                        : "—"
                    }
                  />
                  <Metric
                    label="Contribution"
                    value={
                      attribution.contribution_score != null
                        ? attribution.contribution_score.toFixed(3)
                        : "—"
                    }
                  />
                </dl>
              )
            ) : !attrLoading ? (
              <EmptyState
                icon={Wrench}
                title="Enter a tool ID"
                description="Score success rate, latency, and contribution for one tool."
                size="sm"
              />
            ) : null}
          </>
        ) : null}

        {mode === "compare" ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                list="compare-a"
                value={toolA}
                onChange={(e) => setToolA(e.target.value)}
                placeholder="Tool A"
                aria-label="Tool A"
                className="min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 font-mono text-sm"
              />
              <datalist id="compare-a">
                {allToolNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <input
                list="compare-b"
                value={toolB}
                onChange={(e) => setToolB(e.target.value)}
                placeholder="Tool B"
                aria-label="Tool B"
                className="min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 font-mono text-sm"
              />
              <datalist id="compare-b">
                {allToolNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={compareWindow}
                onChange={(e) => setCompareWindow(e.target.value)}
                aria-label="Compare window"
                className="min-h-11 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 text-sm"
              >
                <option value="7d">7d</option>
                <option value="30d">30d</option>
              </select>
              <Button
                onClick={() => void runCompare()}
                disabled={!toolA.trim() || !toolB.trim()}
                loading={compareLoading}
              >
                Compare
              </Button>
            </div>
            {comparison ? (
              <>
                {comparison.winner ? (
                  <p className="text-sm text-[var(--text-secondary)]">
                    Winner:{" "}
                    <strong className="font-mono text-[var(--text-primary)]">
                      {comparison.winner}
                    </strong>
                  </p>
                ) : null}
                <DataTable
                  columns={compareColumns}
                  rows={comparison.tools}
                  rowKey={(r) => r.tool_name}
                  pageSize={10}
                />
              </>
            ) : null}
          </>
        ) : null}

        {mode === "recommender" ? (
          <>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={taskType}
                onChange={(e) => setTaskType(e.target.value)}
                placeholder="Task type (optional)"
                aria-label="Task type"
                className="min-h-11 flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 text-sm"
              />
              <Button onClick={() => void runRecommend()} loading={recommendLoading}>
                Recommend
              </Button>
            </div>
            {recommendations?.recommendations?.length ? (
              <ol className="space-y-2">
                {recommendations.recommendations.map((r, i) => (
                  <li
                    key={`${r.tool_name}-${i}`}
                    className="flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] py-2 text-sm"
                  >
                    <span className="font-mono text-xs">{r.tool_name}</span>
                    <span
                      className={cn(
                        "tabular-nums text-xs",
                        i === 0
                          ? "font-semibold text-[var(--text-primary)]"
                          : "text-[var(--text-muted)]",
                      )}
                    >
                      {r.score != null ? r.score.toFixed(3) : "—"}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
          </>
        ) : null}

        {mode === "taxonomy" ? (
          <QueryState
            loading={taxonomyQuery.isLoading}
            error={taxonomyQuery.error}
            data={taxonomyQuery.data}
            onRetry={() => void taxonomyQuery.refetch()}
            isEmpty={(d) => (d?.tools?.length ?? 0) === 0}
            emptySlot={
              <EmptyState
                icon={Wrench}
                title="No tools catalogued"
                description="Taxonomy fills in as tool spans are ingested."
                size="md"
              />
            }
            errorTitle="Couldn't load tool catalog"
          >
            {(data) => (
              <DataTable
                columns={[
                  {
                    key: "tool_name",
                    header: "Tool",
                    cell: (t) => (
                      <span className="font-mono text-xs">{t.tool_name}</span>
                    ),
                  },
                  {
                    key: "n_calls_30d",
                    header: "Calls 30d",
                    align: "right" as const,
                    cell: (t) => (
                      <span className="tabular-nums text-xs">{t.n_calls_30d}</span>
                    ),
                  },
                  {
                    key: "success_rate",
                    header: "Success",
                    align: "right" as const,
                    cell: (t) => (
                      <span className="tabular-nums text-xs">
                        {t.success_rate != null
                          ? `${(t.success_rate * 100).toFixed(0)}%`
                          : "—"}
                      </span>
                    ),
                  },
                ]}
                rows={data.tools ?? []}
                rowKey={(t) => t.tool_name}
                pageSize={25}
              />
            )}
          </QueryState>
        ) : null}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-[var(--text-muted)]">{label}</p>
      <p className="text-sm font-semibold tabular-nums text-[var(--text-primary)]">
        {value}
      </p>
    </div>
  );
}
