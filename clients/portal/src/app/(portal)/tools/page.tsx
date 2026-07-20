"use client";

import { useState, useMemo } from "react";
import { useOrg } from "@/hooks/use-org";
import {
  toolsApi,
  type ToolAttributionData,
  type ToolCompareData,
  type ToolRecommendData,
  type ToolTaxonomyData,
} from "@/lib/api";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { PageContent } from "@/components/layout/page-content";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  Wrench,
  GitCompare,
  Sparkles,
  ChevronRight,
  Loader2,
  Activity,
  Search,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { errorFromCaught } from "@/lib/safe-error-message";

type Tab = "attribution" | "compare" | "recommender" | "taxonomy";

export default function ToolsPage() {
  const { currentOrg } = useOrg();
  const orgId = currentOrg?.id;
  const [activeTab, setActiveTab] = useState<Tab>("attribution");
  const [error, setError] = useState("");

  const taxonomyQuery = useOrgQuery(queryKeys.tools.taxonomy(orgId), orgId, () =>
    toolsApi.taxonomy(orgId!),
  );
  const taxonomy = taxonomyQuery.data ?? null;
  const allToolNames = useMemo(
    () => (taxonomy?.tools ?? []).map((t) => t.tool_name).filter(Boolean),
    [taxonomy],
  );

  // Attribution — per-tool (BE requires tool_id)
  const [toolId, setToolId] = useState("");
  const [attrWindow, setAttrWindow] = useState("30d");
  const [attribution, setAttribution] = useState<ToolAttributionData | null>(null);
  const [attrLoading, setAttrLoading] = useState(false);

  // Compare — pairwise
  const [toolA, setToolA] = useState("");
  const [toolB, setToolB] = useState("");
  const [compareWindow, setCompareWindow] = useState("7d");
  const [comparison, setComparison] = useState<ToolCompareData | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  // Recommender
  const [taskType, setTaskType] = useState("");
  const [recommendations, setRecommendations] = useState<ToolRecommendData | null>(null);
  const [recommendLoading, setRecommendLoading] = useState(false);

  const [taxonomyOpen, setTaxonomyOpen] = useState(true);

  const taxonomyError = taxonomyQuery.error?.message ?? null;
  const actionError = error || null;
  const displayError = actionError || (activeTab === "taxonomy" ? taxonomyError : null);

  function retryFailedFetch() {
    setError("");
    if (taxonomyError) void taxonomyQuery.refetch();
  }

  async function handleAttribution() {
    if (!currentOrg || !toolId.trim()) return;
    setAttrLoading(true);
    setError("");
    setAttribution(null);
    try {
      const data = await toolsApi.attribution(currentOrg.id, {
        tool_id: toolId.trim(),
        window: attrWindow,
      });
      setAttribution(data);
    } catch (err) {
      setError(errorFromCaught(err, "Attribution failed"));
    } finally {
      setAttrLoading(false);
    }
  }

  async function handleCompare() {
    if (!currentOrg || !toolA.trim() || !toolB.trim()) return;
    setCompareLoading(true);
    setError("");
    setComparison(null);
    try {
      const data = await toolsApi.compare(currentOrg.id, {
        tool_a: toolA.trim(),
        tool_b: toolB.trim(),
        window: compareWindow,
      });
      setComparison(data);
    } catch (err) {
      setError(errorFromCaught(err, "Comparison failed"));
    } finally {
      setCompareLoading(false);
    }
  }

  async function handleRecommend() {
    if (!currentOrg) return;
    setRecommendLoading(true);
    setError("");
    setRecommendations(null);
    try {
      const data = await toolsApi.recommend(currentOrg.id, {
        task_type: taskType.trim() || undefined,
        k: 3,
      });
      setRecommendations(data);
    } catch (err) {
      setError(errorFromCaught(err, "Recommendation failed"));
    } finally {
      setRecommendLoading(false);
    }
  }

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Wrench}
        feature="Tool Intelligence"
        description="Tool attribution, comparison, and recommendations light up once your organization is processing tool calls."
      />
    );
  }

  return (
    <PageContent size="wide">
      <PageHeader
        eyebrow="Observe"
        title="Tool Intelligence"
        subtitle="Per-tool attribution, pairwise comparison, and task-type recommendations"
        icon={Wrench}
      />

      {displayError && (
        <ErrorState
          title={taxonomyError && !actionError ? "Couldn't load tool catalog" : "Request failed"}
          message={displayError}
          size="sm"
          action={
            <button
              type="button"
              onClick={retryFailedFetch}
              className="text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
            >
              Try again
            </button>
          }
        />
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
        <TabsList
          aria-label="Tool intelligence sections"
          className="bg-[var(--bg-tertiary)] rounded-xl h-auto flex-wrap w-fit"
        >
          {(
            [
              { key: "attribution" as Tab, label: "Attribution", icon: Activity },
              { key: "compare" as Tab, label: "Compare", icon: GitCompare },
              { key: "recommender" as Tab, label: "Recommender", icon: Sparkles },
              { key: "taxonomy" as Tab, label: "Taxonomy", icon: ChevronRight },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <TabsTrigger
              key={key}
              value={key}
              className="flex items-center gap-2 data-[state=active]:text-[var(--text-primary)]"
            >
              <Icon className="w-4 h-4" aria-hidden />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {activeTab === "attribution" && (
          <AttributionTab
            toolId={toolId}
            onToolIdChange={setToolId}
            window={attrWindow}
            onWindowChange={setAttrWindow}
            allToolNames={allToolNames}
            onRun={handleAttribution}
            result={attribution}
            loading={attrLoading}
          />
        )}
        {activeTab === "compare" && (
          <CompareTab
            toolA={toolA}
            toolB={toolB}
            onToolAChange={setToolA}
            onToolBChange={setToolB}
            window={compareWindow}
            onWindowChange={setCompareWindow}
            allToolNames={allToolNames}
            onCompare={handleCompare}
            comparison={comparison}
            loading={compareLoading}
          />
        )}
        {activeTab === "recommender" && (
          <RecommenderTab
            taskType={taskType}
            onTaskTypeChange={setTaskType}
            onRecommend={handleRecommend}
            result={recommendations}
            loading={recommendLoading}
          />
        )}
        {activeTab === "taxonomy" && (
          <TaxonomyTab
            taxonomy={taxonomy}
            loading={taxonomyQuery.isLoading}
            loadError={taxonomyError}
            onRetry={() => void taxonomyQuery.refetch()}
            expanded={taxonomyOpen}
            onToggleExpanded={() => setTaxonomyOpen(!taxonomyOpen)}
          />
        )}
      </Tabs>
    </PageContent>
  );
}

function AttributionTab({
  toolId,
  onToolIdChange,
  window,
  onWindowChange,
  allToolNames,
  onRun,
  result,
  loading,
}: {
  toolId: string;
  onToolIdChange: (v: string) => void;
  window: string;
  onWindowChange: (v: string) => void;
  allToolNames: string[];
  onRun: () => void;
  result: ToolAttributionData | null;
  loading: boolean;
}) {
  return (
    <div className="space-y-4 mt-4">
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
          <Activity className="w-4 h-4 text-[var(--accent)]" />
          Per-tool attribution
        </h3>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          Attribution is per-tool — enter a tool ID. There is no fleet-wide aggregate endpoint.
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            list="tool-id-suggestions"
            value={toolId}
            onChange={(e) => onToolIdChange(e.target.value)}
            placeholder="tool_id…"
            className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm font-mono text-[var(--text-primary)]"
          />
          <datalist id="tool-id-suggestions">
            {allToolNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <select
            value={window}
            onChange={(e) => onWindowChange(e.target.value)}
            className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
          <button
            onClick={onRun}
            disabled={loading || !toolId.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
            Attribute
          </button>
        </div>
      </Card>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>
      )}

      {result && (
        <Card padding="lg">
          {result.message && (
            <p className="text-xs text-[var(--text-muted)] mb-3">{result.message}</p>
          )}
          {result.n_calls === 0 || result.success_rate == null ? (
            <EmptyState
              icon={Wrench}
              title="No tool telemetry"
              description={`No calls found for ${result.tool_name} in window ${result.window}.`}
              size="md"
            />
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Metric label="Tool" value={result.tool_name} mono />
              <Metric label="Calls" value={String(result.n_calls)} />
              <Metric
                label="Success rate"
                value={
                  result.success_rate != null
                    ? `${(result.success_rate * 100).toFixed(1)}%`
                    : "—"
                }
              />
              <Metric
                label="Contribution"
                value={
                  result.contribution_score != null
                    ? result.contribution_score.toFixed(3)
                    : "—"
                }
              />
              <Metric
                label="p50"
                value={result.p50_ms != null ? `${result.p50_ms.toFixed(0)} ms` : "—"}
              />
              <Metric
                label="p95"
                value={result.p95_ms != null ? `${result.p95_ms.toFixed(0)} ms` : "—"}
              />
            </div>
          )}
        </Card>
      )}

      {!result && !loading && (
        <Card padding="lg">
          <EmptyState
            icon={Wrench}
            title="Enter a tool ID"
            description="Score success rate, latency, and contribution for one tool."
            size="md"
          />
        </Card>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-[var(--text-muted)] mb-0.5">{label}</p>
      <p
        className={cn(
          "text-sm font-semibold text-[var(--text-primary)]",
          mono && "font-mono text-xs",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function CompareTab({
  toolA,
  toolB,
  onToolAChange,
  onToolBChange,
  window,
  onWindowChange,
  allToolNames,
  onCompare,
  comparison,
  loading,
}: {
  toolA: string;
  toolB: string;
  onToolAChange: (v: string) => void;
  onToolBChange: (v: string) => void;
  window: string;
  onWindowChange: (v: string) => void;
  allToolNames: string[];
  onCompare: () => void;
  comparison: ToolCompareData | null;
  loading: boolean;
}) {
  const columns: DataTableColumn<ToolCompareData["tools"][number]>[] = [
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
    {
      key: "cost_per_call_usd",
      header: "Cost/call",
      align: "right",
      cell: (r) => (
        <span className="tabular-nums">
          {r.cost_per_call_usd != null ? `$${r.cost_per_call_usd.toFixed(4)}` : "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6 mt-4">
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-[var(--accent)]" />
          Compare two tools
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <input
            type="text"
            list="compare-tool-a"
            value={toolA}
            onChange={(e) => onToolAChange(e.target.value)}
            placeholder="tool_a…"
            className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm font-mono text-[var(--text-primary)]"
          />
          <datalist id="compare-tool-a">
            {allToolNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <input
            type="text"
            list="compare-tool-b"
            value={toolB}
            onChange={(e) => onToolBChange(e.target.value)}
            placeholder="tool_b…"
            className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm font-mono text-[var(--text-primary)]"
          />
          <datalist id="compare-tool-b">
            {allToolNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-wrap gap-3">
          <select
            value={window}
            onChange={(e) => onWindowChange(e.target.value)}
            className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)]"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
          <button
            onClick={onCompare}
            disabled={loading || !toolA.trim() || !toolB.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitCompare className="w-4 h-4" />}
            Compare
          </button>
        </div>
      </Card>

      {comparison && (
        <div className="space-y-4">
          {comparison.message && (
            <p className="text-xs text-[var(--text-muted)]">{comparison.message}</p>
          )}
          <Card padding="md">
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                Winner:{" "}
                <strong className="font-mono text-[var(--accent)]">{comparison.winner}</strong>
              </span>
              <span className="text-[var(--text-muted)]">
                Δ success:{" "}
                {comparison.success_rate_diff != null
                  ? comparison.success_rate_diff.toFixed(3)
                  : "—"}
              </span>
              <span className="text-[var(--text-muted)]">
                confidence: {comparison.confidence.toFixed(2)}
              </span>
            </div>
          </Card>
          <DataTable
            columns={columns}
            rows={comparison.tools}
            rowKey={(r) => r.tool_name}
            pageSize={10}
            emptyTitle="No comparison data"
            emptyDescription="Neither tool returned telemetry for this window."
            emptyIcon={GitCompare}
          />
        </div>
      )}
    </div>
  );
}

function RecommenderTab({
  taskType,
  onTaskTypeChange,
  onRecommend,
  result,
  loading,
}: {
  taskType: string;
  onTaskTypeChange: (t: string) => void;
  onRecommend: () => void;
  result: ToolRecommendData | null;
  loading: boolean;
}) {
  const recommendations = result?.recommendations ?? null;
  return (
    <div className="space-y-6 mt-4">
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-[var(--accent)]" />
          Tool recommendations
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={taskType}
            onChange={(e) => onTaskTypeChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRecommend();
            }}
            placeholder="task_type (optional) — e.g. retrieval"
            aria-label="Task type"
            className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <button
            onClick={onRecommend}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Recommend
          </button>
        </div>
      </Card>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : recommendations && recommendations.length > 0 ? (
        <div className="space-y-3">
          <p className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Top picks</p>
          {recommendations.slice(0, 3).map((rec, idx) => (
            <Card padding="md" key={rec.tool_name}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold",
                      idx === 0
                        ? "bg-[var(--accent)] text-[var(--bg-base)]"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
                    )}
                  >
                    {idx + 1}
                  </span>
                  <span className="font-mono text-sm text-[var(--text-primary)]">
                    {rec.tool_name}
                  </span>
                </div>
                <div className="text-right">
                  <p className="text-xs text-[var(--text-muted)]">Score</p>
                  <p className="text-sm font-semibold text-[var(--accent)] tabular-nums">
                    {rec.score.toFixed(3)}
                  </p>
                </div>
              </div>
              <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
                {rec.rationale}
              </p>
            </Card>
          ))}
        </div>
      ) : recommendations && recommendations.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No recommendations"
          description={result?.message ?? "No tool telemetry available to score."}
          size="md"
        />
      ) : null}
    </div>
  );
}

function TaxonomyTab({
  taxonomy,
  loading,
  loadError,
  onRetry,
  expanded,
  onToggleExpanded,
}: {
  taxonomy: ToolTaxonomyData | null;
  loading: boolean;
  loadError: string | null;
  onRetry: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const tools = taxonomy?.tools ?? [];
  const columns: DataTableColumn<(typeof tools)[number]>[] = [
    {
      key: "tool_name",
      header: "Tool",
      sortable: true,
      cell: (r) => <span className="font-mono text-xs">{r.tool_name}</span>,
    },
    {
      key: "tool_version",
      header: "Version",
      cell: (r) => (
        <span className="text-xs text-[var(--text-muted)]">{r.tool_version ?? "—"}</span>
      ),
    },
    {
      key: "n_calls_30d",
      header: "Calls (30d)",
      sortable: true,
      align: "right",
      cell: (r) => <span className="tabular-nums">{r.n_calls_30d.toLocaleString()}</span>,
    },
    {
      key: "success_rate",
      header: "Success",
      sortable: true,
      align: "right",
      cell: (r) => (
        <span className="tabular-nums">
          {r.success_rate != null ? `${(r.success_rate * 100).toFixed(1)}%` : "—"}
        </span>
      ),
    },
  ];

  return (
    <Card padding="lg" className="mt-4">
      <button
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        aria-controls="taxonomy-panel"
        className="w-full px-1 py-2 flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <ChevronRight
            className={cn(
              "w-4 h-4 text-[var(--text-muted)] transition-transform",
              expanded && "rotate-90",
            )}
          />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Tool catalog</h3>
          {taxonomy && (
            <span className="text-xs text-[var(--text-muted)]">{tools.length} tools</span>
          )}
        </div>
        {loading && <Loader2 className="w-4 h-4 animate-spin text-[var(--accent)]" aria-hidden />}
      </button>

      {expanded && (
        <div id="taxonomy-panel" className="border-t border-[var(--border-default)] pt-4">
          {loadError ? (
            <ErrorState
              title="Couldn't load tool catalog"
              message={loadError}
              size="sm"
              action={
                <button
                  type="button"
                  onClick={onRetry}
                  className="text-sm font-medium text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors"
                >
                  Try again
                </button>
              }
            />
          ) : (
            <>
              {taxonomy?.message && (
                <p className="text-xs text-[var(--text-muted)] mb-3">{taxonomy.message}</p>
              )}
              <DataTable
                columns={columns}
                rows={tools}
                rowKey={(r) => r.tool_name}
                loading={loading && tools.length === 0}
                defaultSort={{ key: "n_calls_30d", direction: "desc" }}
                emptyTitle="No tools yet"
                emptyDescription="Tool taxonomy populates once agents start invoking tools."
                emptyIcon={Wrench}
                pageSize={25}
              />
            </>
          )}
        </div>
      )}
    </Card>
  );
}
