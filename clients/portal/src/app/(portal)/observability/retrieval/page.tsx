"use client";

import { useState, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { useOrgQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { ErrorState } from "@/components/ui/error-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageContent } from "@/components/layout/page-content";
import { useEmbeddedSurface } from "@/components/layout/embedded-surface";
import {
  ObserveBackToTraces,
  ObserveLeafHeader,
  WAVE10_SHELL_ATTR,
} from "@/app/(portal)/observability/_components/observe-leaf-shell";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CheckCircle2, Database, Lightbulb, Network, Search, Shuffle, Sparkles, XCircle, Zap } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Card } from "@/components/ui/card";
import { errorFromCaught } from "@/lib/safe-error-message";
import {
  retrievalApi,
  type RetrievalGap,
  type RetrievalUtilizationData,
} from "@/lib/api";

type SubTab = "gaps" | "utilization" | "reorder";

export default function RetrievalIntelligencePage() {
  const { currentOrg } = useOrg();
  const embedded = useEmbeddedSurface();
  const [activeTab, setActiveTab] = useState<SubTab>("gaps");
  const [error, setError] = useState("");

  if (!currentOrg) {
    return (
      <NoOrgState
        icon={Database}
        feature="Retrieval Intelligence"
        description="RAG usage, knowledge gaps, and reordering suggestions will appear once your organization is configured."
      />
    );
  }

  return (
    <PageContent size="wide">
      <div {...WAVE10_SHELL_ATTR} className="contents">
      <ObserveBackToTraces />
      <ObserveLeafHeader
        title="Retrieval"
        subtitle="Chunk attribution, gaps, reorder — advanced under Traces facets"
        icon={Network}
      />
      </div>

      {error ? (
        <ErrorState
          title="Could not load retrieval data"
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
            value="gaps"
            variant={embedded ? "pills" : "underline"}
            className="flex items-center gap-2 min-h-11"
          >
            <Lightbulb className="w-4 h-4" />
            Knowledge Gaps
          </TabsTrigger>
          <TabsTrigger
            value="utilization"
            variant={embedded ? "pills" : "underline"}
            className="flex items-center gap-2 min-h-11"
          >
            <Sparkles className="w-4 h-4" />
            Utilization
          </TabsTrigger>
          <TabsTrigger
            value="reorder"
            variant={embedded ? "pills" : "underline"}
            className="flex items-center gap-2 min-h-11"
          >
            <Shuffle className="w-4 h-4" />
            Reorder
          </TabsTrigger>
        </TabsList>

        <TabsContent value="gaps" className="mt-6">
          <GapsTab orgId={currentOrg.id} />
        </TabsContent>
        <TabsContent value="utilization" className="mt-6">
          <UtilizationTab orgId={currentOrg.id} setError={setError} />
        </TabsContent>
        <TabsContent value="reorder" className="mt-6">
          <ReorderTab orgId={currentOrg.id} setError={setError} />
        </TabsContent>
      </Tabs>
    </PageContent>
  );
}

function GapsTab({ orgId }: { orgId: string }) {
  const [window, setWindow] = useState("7d");
  const gapsQuery = useOrgQuery(
    ["retrieval", "gaps", orgId, window] as const,
    orgId,
    async () => {
      const data = await retrievalApi.gaps(orgId, { window });
      return { gaps: data.gaps ?? [], message: data.message ?? null };
    },
  );
  const gaps: RetrievalGap[] = gapsQuery.data?.gaps ?? [];
  const beMessage = gapsQuery.data?.message ?? null;
  const loading = gapsQuery.isLoading;

  const emptyDescription = beMessage
    ? beMessage
    : "No knowledge gaps flagged in this window.";

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-xs text-[var(--text-muted)]">
          Queries with low hit rate or utilization — highest-ROI training candidates
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={window}
            onChange={(e) => setWindow(e.target.value)}
            placeholder="7d"
            className="w-24 px-2 py-1.5 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-xs text-[var(--text-primary)] font-mono"
          />
          <Button
            variant="secondary"
            size="sm"
            className="min-h-11"
            onClick={() => void gapsQuery.refetch()}
            loading={loading}
          >
            <Zap className="w-3.5 h-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {gapsQuery.isError && gaps.length === 0 ? (
        <ErrorState
          title="Could not load knowledge gaps"
          message={errorFromCaught(gapsQuery.error, "Failed to load gaps")}
          action={
            <Button size="sm" variant="outline" onClick={() => void gapsQuery.refetch()}>
              Try again
            </Button>
          }
        />
      ) : loading && gaps.length === 0 ? (
        <div className="space-y-3 py-6" aria-busy="true" aria-live="polite">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : gaps.length === 0 ? (
        <Card padding="lg">
          <EmptyState icon={Lightbulb} title="No knowledge gaps detected" description={emptyDescription} size="lg" />
        </Card>
      ) : (
        <Card padding="lg" className="overflow-hidden">
          <DataTable
            columns={[
              {
                key: "query_pattern",
                header: "Query",
                sortable: true,
                cell: (g) => <span className="text-[var(--text-primary)]">{g.query_pattern}</span>,
              },
              {
                key: "hit_rate",
                header: "Hit rate",
                sortable: true,
                align: "right",
                cell: (g) => (
                  <span className="text-xs text-[var(--text-secondary)]">{(g.hit_rate * 100).toFixed(0)}%</span>
                ),
              },
              {
                key: "utilization",
                header: "Utilization",
                sortable: true,
                align: "right",
                cell: (g) => {
                  const util = g.utilization;
                  if (util == null) return <span className="text-xs text-[var(--text-muted)]">—</span>;
                  return (
                    <span
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full font-medium",
                        util >= 0.7
                          ? "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          : util >= 0.4
                            ? "bg-[var(--warning-bg)] text-[var(--warning)]"
                            : "bg-[var(--error-bg)] text-[var(--error)]",
                      )}
                    >
                      {(util * 100).toFixed(0)}%
                    </span>
                  );
                },
              },
              {
                key: "sample_size",
                header: "Samples",
                sortable: true,
                align: "right",
                cell: (g) => <span className="text-xs text-[var(--text-muted)]">{g.sample_size}</span>,
              },
              {
                key: "suggested_action",
                header: "Suggested",
                cell: (g) => (
                  <span className="text-xs text-[var(--text-secondary)]">{g.suggested_action || "—"}</span>
                ),
              },
            ]}
            rows={gaps}
            rowKey={(g, i) => `${g.query_hash}-${i}`}
            defaultSort={{ key: "sample_size", direction: "desc" }}
            emptyTitle="No knowledge gaps detected"
            emptyDescription={emptyDescription}
            emptyIcon={Lightbulb}
            pageSize={25}
          />
        </Card>
      )}
    </div>
  );
}

function UtilizationTab({ orgId, setError }: { orgId: string; setError: (e: string) => void }) {
  const [traceId, setTraceId] = useState("");
  const [result, setResult] = useState<RetrievalUtilizationData | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleRun() {
    if (!traceId.trim()) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const data = await retrievalApi.utilization(orgId, traceId.trim());
      setResult(data);
    } catch (err) {
      setError(errorFromCaught(err, "Utilization failed"));
    } finally {
      setLoading(false);
    }
  }

  const rate = result?.utilization_rate ?? (result && result.retrieved > 0 ? result.actually_used / result.retrieved : 0);
  const usedChunks = (result?.by_chunk ?? []).filter((c) => c.used).map((c) => c.chunk_id);
  const unusedChunks = (result?.by_chunk ?? []).filter((c) => !c.used).map((c) => c.chunk_id);

  return (
    <div className="space-y-4">
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
          <Search className="w-4 h-4 text-[var(--accent)]" />
          Trace utilization
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
            <Sparkles className="w-4 h-4" />
            Analyze
          </Button>
        </div>
      </Card>

      {loading ? (
        <div className="space-y-3 py-4" aria-busy="true" aria-live="polite">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      ) : null}

      {result && (
        <div className="space-y-4">
          {result.message && (
            <Alert variant="warning" title="Note" description={result.message} />
          )}
          <Card padding="lg">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Utilization score</h3>
              <span
                className={cn(
                  "text-2xl font-bold",
                  rate > 0.7 ? "text-[var(--terminal)]" : rate > 0.4 ? "text-[var(--warning)]" : "text-[var(--error)]",
                )}
              >
                {(rate * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-3 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  rate > 0.7 ? "bg-[var(--terminal)]" : rate > 0.4 ? "bg-[var(--warning)]" : "bg-[var(--error)]",
                )}
                style={{ width: `${rate * 100}%` }}
              />
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-2">
              {result.actually_used} used · {result.retrieved - result.actually_used} unused · {result.retrieved} retrieved
            </p>
          </Card>

          <div className="grid sm:grid-cols-2 gap-4">
            <ChunkList title="Used chunks" icon={CheckCircle2} iconClass="text-[var(--terminal)]" chunks={usedChunks} tone="used" />
            <ChunkList title="Unused chunks (dead weight)" icon={XCircle} iconClass="text-[var(--error)]" chunks={unusedChunks} tone="unused" />
          </div>
        </div>
      )}

      {!result && !loading && (
        <Card padding="lg">
          <EmptyState
            icon={Sparkles}
            title="Enter a trace ID"
            description="See exactly which chunks your retrieval layer paid for vs which the model actually used"
            size="md"
          />
        </Card>
      )}
    </div>
  );
}

function ChunkList({
  title,
  icon: Icon,
  iconClass,
  chunks,
  tone,
}: {
  title: string;
  icon: typeof CheckCircle2;
  iconClass: string;
  chunks: string[];
  tone: "used" | "unused";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        tone === "used"
          ? "border-[var(--terminal)]/20 bg-[var(--terminal-faint)]/20"
          : "border-[var(--error)]/20 bg-[var(--error-bg)]/30",
      )}
    >
      <h4 className="text-xs font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
        <Icon className={cn("w-4 h-4", iconClass)} />
        {title}
      </h4>
      {chunks.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">None</p>
      ) : (
        <ul className="space-y-1.5 max-h-64 overflow-auto">
          {chunks.map((c) => (
            <li key={c} className="font-mono text-xs text-[var(--text-secondary)] truncate">
              {c}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReorderTab({ orgId, setError }: { orgId: string; setError: (e: string) => void }) {
  const [collection, setCollection] = useState("");
  const [entries, setEntries] = useState<Array<{ chunk_id: string; new_position: number }>>([]);
  const [beMessage, setBeMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!collection.trim()) {
      setError("Collection is required.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const data = await retrievalApi.reorder(orgId, { collection: collection.trim() });
      const order = data.suggested_order ?? [];
      setEntries(order.map((chunk_id, i) => ({ chunk_id, new_position: i + 1 })));
      setBeMessage(data.message ?? null);
      setHasLoaded(true);
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load reorder"));
    } finally {
      setLoading(false);
    }
  }, [orgId, collection, setError]);

  const emptyDescription = beMessage
    ? beMessage
    : "No reordering suggested for this collection.";

  return (
    <div className="space-y-4">
      <Card padding="lg" className="space-y-3">
        <p className="text-xs text-[var(--text-muted)]">
          Suggested chunk ordering for a collection — front-load chunks the model actually uses
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            placeholder="collection name"
            className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono"
          />
          <Button
            variant="secondary"
            size="sm"
            className="min-h-11"
            onClick={() => void load()}
            disabled={!collection.trim()}
            loading={loading}
          >
            <Zap className="w-3.5 h-3.5" />
            {hasLoaded ? "Refresh" : "Suggest order"}
          </Button>
        </div>
      </Card>

      {!hasLoaded && !loading ? (
        <Card padding="lg">
          <EmptyState
            icon={Shuffle}
            title="Enter a collection"
            description="Provide the collection name the backend should reorder."
            size="lg"
          />
        </Card>
      ) : loading && entries.length === 0 ? (
        <div className="space-y-3 py-6" aria-busy="true" aria-live="polite">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : entries.length === 0 ? (
        <Card padding="lg">
          <EmptyState icon={Shuffle} title="No reordering suggested" description={emptyDescription} size="lg" />
        </Card>
      ) : (
        <Card padding="lg" className="overflow-hidden">
          {beMessage && (
            <p className="text-xs text-[var(--text-muted)] px-4 pt-3">{beMessage}</p>
          )}
          <DataTable
            columns={[
              {
                key: "chunk_id",
                header: "Chunk ID",
                sortable: true,
                cell: (e) => <span className="font-mono text-xs text-[var(--text-primary)]">{e.chunk_id}</span>,
              },
              {
                key: "new_position",
                header: "New position",
                sortable: true,
                align: "right",
                cell: (e) => (
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--accent-faint)] text-[var(--accent)]">
                    #{e.new_position}
                  </span>
                ),
              },
            ]}
            rows={entries}
            rowKey={(e) => e.chunk_id}
            defaultSort={{ key: "new_position", direction: "asc" }}
            emptyTitle="No reordering suggested"
            emptyDescription={emptyDescription}
            emptyIcon={Shuffle}
            pageSize={25}
          />
        </Card>
      )}
    </div>
  );
}
