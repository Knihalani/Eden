"use client";

import { useState } from "react";
import { useOrgQuery } from "@/hooks/use-api-query";
import { queryKeys } from "@/lib/query-keys";
import { useOrg } from "@/hooks/use-org";
import { memoryApi, type MemoryAttributionData, type MemoryImpactData, type MemoryReaverData } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryState } from "@/components/ui/query-state";
import { PageContent } from "@/components/layout/page-content";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import { ObserveLeafHeader } from "@/app/(portal)/observability/_components/observe-leaf-shell";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Archive, Brain, Combine, Search, TrendingDown, Zap } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { Card } from "@/components/ui/card";
import { errorFromCaught } from "@/lib/safe-error-message";

type SubTab = "attribution" | "impact" | "reaver";
type ReaverSuggestion = MemoryReaverData["suggestions"][number];

export default function MemoryIntelligencePage() {
  const { currentOrg } = useOrg();
  const embedded = useEmbeddedSurface();
  const [activeTab, setActiveTab] = useState<SubTab>("attribution");
  const [error, setError] = useState("");
  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Brain}
        feature="Memory Intelligence"
        description="Memory attribution, impact scoring, and reweaver suggestions will appear once your organization is configured."
      />
    );
  }
  return (
    <PageContent size="wide">
      <ObserveLeafHeader
        title="Memory"
        subtitle="Episodic + semantic memory attribution and reweaving"
        icon={Brain}
        description="Advanced under Traces — attributes memories that influenced a trace; not a knowledge-base browser."
      />

      {error ? (
        <ErrorState
          title="Could not load memory data"
          message={error}
          action={
            <Button size="sm" variant="outline" onClick={() => setError("")}>
              Dismiss
            </Button>
          }
        />
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v as SubTab);
          setError("");
        }}
      >
        <TabsList
          variant={embedded ? "pills" : "underline"}
          className={
            embedded
              ? "w-full justify-start"
              : "border-b border-[var(--border-default)] w-full justify-start"
          }
        >
          <TabsTrigger
            value="attribution"
            variant={embedded ? "pills" : "underline"}
            className="flex items-center gap-2 min-h-11"
          >
            <Search className="w-4 h-4" />
            Attribution
          </TabsTrigger>
          <TabsTrigger
            value="impact"
            variant={embedded ? "pills" : "underline"}
            className="flex items-center gap-2 min-h-11"
          >
            <Zap className="w-4 h-4" />
            Impact
          </TabsTrigger>
          <TabsTrigger
            value="reaver"
            variant={embedded ? "pills" : "underline"}
            className="flex items-center gap-2 min-h-11"
          >
            <Combine className="w-4 h-4" />
            Reweaver
          </TabsTrigger>
        </TabsList>

        <TabsContent value="attribution" className="mt-6">
          <AttributionTab orgId={currentOrg.id} setError={setError} />
        </TabsContent>
        <TabsContent value="impact" className="mt-6">
          <ImpactTab orgId={currentOrg.id} setError={setError} />
        </TabsContent>
        <TabsContent value="reaver" className="mt-6">
          <ReaverTab orgId={currentOrg.id} setError={setError} />
        </TabsContent>
      </Tabs>
    </PageContent>
  );
}

function AttributionTab({
  orgId,
  setError,
}: {
  orgId: string;
  setError: (e: string) => void;
}) {
  const [traceId, setTraceId] = useState("");
  const [result, setResult] = useState<MemoryAttributionData | null>(null);
  const [loading, setLoading] = useState(false);
  async function handleRun() {
    if (!traceId.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const data = await memoryApi.attribute(orgId, traceId.trim());
      setResult(data);
    } catch (err) {
      setError(errorFromCaught(err, "Attribution failed"));
    } finally {
      setLoading(false);
    }
  }
  const memories = result?.per_memory ?? [];
  return (
    <div className="space-y-4">
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
          <Search className="w-4 h-4 text-[var(--accent)]" />
          Trace attribution
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={traceId}
            onChange={(e) => setTraceId(e.target.value)}
            placeholder="Enter trace ID..."
            className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <Button variant="default" className="min-h-11" onClick={handleRun} disabled={loading || !traceId.trim()} loading={loading}>
            <Brain className="w-4 h-4" />
            Attribute
          </Button>
        </div>
      </Card>

      {loading ? (
        <div className="space-y-3 py-4" aria-busy="true" aria-live="polite">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : null}

      {result && (
        <div className="space-y-3">
          <Card padding="lg">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Memories that influenced this trace
            </h3>
            {result.message && (
              <p className="text-xs text-[var(--text-muted)] mb-3">{result.message}</p>
            )}
            {memories.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No memories influenced this trace.</p>
            ) : (
              <ul className="space-y-2">
                {memories.map((m) => (
                  <li
                    key={m.memory_id}
                    className="flex items-center gap-3 p-2.5 rounded-lg bg-[var(--bg-secondary)]"
                  >
                    <span className="font-mono text-xs text-[var(--text-primary)] flex-1 truncate">
                      {m.memory_id}
                    </span>
                    {m.role && (
                      <span className="text-2xs uppercase tracking-wide text-[var(--text-muted)]">
                        {m.role}
                      </span>
                    )}
                    <div className="w-40 flex-shrink-0">
                      <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] rounded-full"
                          style={{
                            width: `${Math.max(0, Math.min(1, m.influence_score)) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                    <span className="text-xs text-[var(--text-muted)] w-12 text-right tabular-nums">
                      {(m.influence_score * 100).toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {!result && !loading && (
        <Card padding="lg">
          <EmptyState
            icon={Brain}
            title="Enter a trace ID"
            description="See which memories contributed to a response"
            size="md"
          />
        </Card>
      )}
    </div>
  );
}

function ImpactTab({
  orgId,
  setError,
}: {
  orgId: string;
  setError: (e: string) => void;
}) {
  const [traceId, setTraceId] = useState("");
  const [result, setResult] = useState<MemoryImpactData | null>(null);
  const [loading, setLoading] = useState(false);
  async function handleRun() {
    if (!traceId.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const data = await memoryApi.impact(orgId, traceId.trim());
      setResult(data);
    } catch (err) {
      setError(errorFromCaught(err, "Impact scoring failed"));
    } finally {
      setLoading(false);
    }
  }
  const memories = result?.per_memory ?? [];
  const topScore = memories[0]?.score ?? 0;
  return (
    <div className="space-y-4">
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
          <Zap className="w-4 h-4 text-[var(--accent)]" />
          Trace impact score
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={traceId}
            onChange={(e) => setTraceId(e.target.value)}
            placeholder="Enter trace ID..."
            className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
          />
          <Button variant="default" className="min-h-11" onClick={handleRun} disabled={loading || !traceId.trim()} loading={loading}>
            <Zap className="w-4 h-4" />
            Score
          </Button>
        </div>
      </Card>

      {loading ? (
        <div className="space-y-3 py-4" aria-busy="true" aria-live="polite">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : null}

      {result && (
        <div className="space-y-4">
          <Card padding="lg">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Top impact</h3>
              <span
                className={cn(
                  "text-2xl font-bold",
                  topScore > 0.7
                    ? "text-[var(--terminal)]"
                    : topScore > 0.4
                      ? "text-[var(--warning)]"
                      : "text-[var(--text-muted)]",
                )}
              >
                {(topScore * 100).toFixed(1)}%
              </span>
            </div>
            {result.message && (
              <p className="text-xs text-[var(--text-muted)] mb-3">{result.message}</p>
            )}
            {result.primary_memory_id && (
              <p className="text-xs text-[var(--text-secondary)] font-mono mb-3">
                Primary: {result.primary_memory_id}
              </p>
            )}
          </Card>

          {memories.length > 0 ? (
            <Card padding="lg">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                Per-memory impact
              </h3>
              <ul className="space-y-2">
                {memories.map((m) => {
                  const pct = Math.max(0, Math.min(1, m.score));
                  return (
                    <li key={m.memory_id} className="flex items-center gap-3">
                      <span className="text-xs font-mono text-[var(--text-secondary)] w-40 flex-shrink-0 truncate">
                        {m.memory_id}
                      </span>
                      <div className="flex-1 h-2.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] rounded-full"
                          style={{ width: `${pct * 100}%` }}
                        />
                      </div>
                      <span className="text-xs text-[var(--text-muted)] w-12 text-right tabular-nums">
                        {(pct * 100).toFixed(0)}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          ) : (
            <Card padding="lg">
              <EmptyState
                icon={Zap}
                title="No memory impact"
                description="No memories were used in this trace."
                size="md"
              />
            </Card>
          )}
        </div>
      )}

      {!result && !loading && (
        <Card padding="lg">
          <EmptyState
            icon={Zap}
            title="Enter a trace ID"
            description="See per-memory impact scores for a trace"
            size="md"
          />
        </Card>
      )}
    </div>
  );
}

function ReaverTab({
  orgId,
  setError,
}: {
  orgId: string;
  setError: (e: string) => void;
}) {
  const reaverQuery = useOrgQuery(
    queryKeys.memory.reaver(orgId),
    orgId,
    async () => (await memoryApi.reweaverSuggest(orgId, { memory_id: "", window: "30d" })).suggestions ?? [],
  );
  const suggestions = reaverQuery.data ?? [];
  const loading = reaverQuery.isLoading || reaverQuery.isFetching;
  const load = async () => {
    setError("");
    const res = await reaverQuery.refetch();
    if (res.error) setError(errorFromCaught(res.error, "Failed to load suggestions"));
  };
  return (
    <div className="space-y-space-4">
      <div className="flex items-center justify-between gap-space-3">
        <p className="text-xs text-[var(--text-muted)]">
          Reweaver suggestions — merge duplicates, archive dead memories, demote low-influence ones
        </p>
        <Button variant="secondary" size="sm" className="min-h-11" onClick={() => void load()} loading={loading}>
          <Combine className="w-3.5 h-3.5" />
          Refresh
        </Button>
      </div>

      <QueryState
        loading={loading && suggestions.length === 0}
        error={reaverQuery.isError && suggestions.length === 0 ? reaverQuery.error : null}
        data={reaverQuery.data ?? []}
        onRetry={() => void load()}
        errorTitle="Could not load reweaver suggestions"
        loadingSlot={
          <div className="space-y-space-3 py-space-6" aria-busy="true" aria-live="polite">
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
            <Skeleton className="h-10 w-full rounded-lg" />
          </div>
        }
        isEmpty={(d) => d.length === 0}
        emptySlot={
          <Card padding="lg">
            <EmptyState
              icon={Combine}
              title="No reweaver suggestions"
              description="Your memory store is already clean — nothing to merge, archive, or demote"
              size="md"
            />
          </Card>
        }
      >
        {(rows) => (
          <Card padding="lg" className="overflow-hidden">
            <DataTable
              columns={[
                {
                  key: "memory_id",
                  header: "Memory ID",
                  sortable: true,
                  cell: (s) => (
                    <span className="font-mono text-xs text-[var(--text-primary)]">{s.memory_id}</span>
                  ),
                },
                {
                  key: "action",
                  header: "Action",
                  sortable: true,
                  cell: (s) => <ActionBadge action={s.action} />,
                },
                {
                  key: "rationale",
                  header: "Rationale",
                  cell: (s) => (
                    <span className="text-[var(--text-secondary)] text-xs">{s.rationale}</span>
                  ),
                },
              ]}
              rows={rows}
              rowKey={(s) => `${s.memory_id}:${s.action}:${s.with_memory_id ?? ""}`}
              loading={loading}
              defaultSort={{ key: "action", direction: "asc" }}
              emptyTitle="No reweaver suggestions"
              emptyDescription="Your memory store is already clean — nothing to merge, archive, or demote"
              emptyIcon={Combine}
              pageSize={25}
            />
          </Card>
        )}
      </QueryState>
    </div>
  );
}

function ActionBadge({ action }: { action: ReaverSuggestion["action"] }) {
  const map: Record<
    ReaverSuggestion["action"],
    { classes: string; icon: typeof Combine }
  > = {
    merge: {
      classes: "bg-[var(--accent-faint)] text-[var(--accent)]",
      icon: Combine,
    },
    archive: {
      classes: "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]",
      icon: Archive,
    },
    demote: {
      classes: "bg-[var(--warning-bg)] text-[var(--warning)]",
      icon: TrendingDown,
    },
  };
  const cfg = map[action] || map.archive;
  const Icon = cfg.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium",
        cfg.classes,
      )}
    >
      <Icon className="w-3 h-3" />
      {action}
    </span>
  );
}
