"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
;
;
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CheckCircle2, Database, Lightbulb, Loader2, Network, Search, Shuffle, Sparkles, XCircle, Zap } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { DataTable } from "@/components/ui/data-table";
;
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Card } from "@/components/ui/card";
async function callApi<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  // Delegate to the shared api client — it knows about Clerk refresh,
  // SSE, the catch-all proxy, and the in-flight de-dup map. The
  // previous local ``API_BASE = NEXT_PUBLIC_API_URL || http://localhost:8000``
  // pointed at the dev process in production, which doesn't exist.
  const res = await fetch(endpoint.startsWith("http") ? endpoint : `/api/proxy${endpoint}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    },
    ...init
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({
      detail: "Request failed"
    }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}
const retrievalApi = {
  gaps: (orgId: string) => callApi<{
    gaps: Array<{
      query: string;
      gap_score: number;
      example_trace_id: string;
    }>;
  }>(`/orgs/${orgId}/intelligence/retrieval/gaps`, {
    method: "POST"
  }),
  utilization: (orgId: string, traceId: string) => callApi<{
    trace_id: string;
    utilization: number;
    used_chunks: string[];
    unused_chunks: string[];
  }>(`/orgs/${orgId}/intelligence/retrieval/${traceId}/utilization`, {
    method: "POST"
  }),
  reorder: (orgId: string) => callApi<{
    reordering: Array<{
      chunk_id: string;
      new_position: number;
      reason: string;
    }>;
  }>(`/orgs/${orgId}/intelligence/retrieval/reorder`, {
    method: "POST"
  })
};
type SubTab = "gaps" | "utilization" | "reorder";
interface Gap {
  query: string;
  gap_score: number;
  example_trace_id: string;
}
interface UtilizationResult {
  trace_id: string;
  utilization: number;
  used_chunks: string[];
  unused_chunks: string[];
}
interface ReorderEntry {
  chunk_id: string;
  new_position: number;
  reason: string;
}
export default function RetrievalIntelligencePage() {
  const {
    currentOrg
  } = useOrg();
  const [activeTab, setActiveTab] = useState<SubTab>("gaps");
  const [error, setError] = useState("");
  if (!currentOrg) {
    return <NoOrgState icon={Database} feature="Retrieval Intelligence" description="RAG usage, knowledge gaps, and reordering suggestions will appear once your organization is configured." />;
  }
  return <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <PageHeader title="Retrieval" subtitle="Chunk attribution, gap detection, and reorder signals" icon={Network} eyebrow="Observe" />

      {error && <Alert variant="error" title="Request failed" description={error} onDismiss={() => setError("")} />}

      <Tabs value={activeTab} onValueChange={v => {
      setActiveTab(v as SubTab);
      setError("");
    }}>
        <TabsList variant="underline" className="border-b border-[var(--border-default)] w-full justify-start">
          <TabsTrigger value="gaps" variant="underline" className="flex items-center gap-2">
            <Lightbulb className="w-4 h-4" />
            Knowledge Gaps
          </TabsTrigger>
          <TabsTrigger value="utilization" variant="underline" className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Utilization
          </TabsTrigger>
          <TabsTrigger value="reorder" variant="underline" className="flex items-center gap-2">
            <Shuffle className="w-4 h-4" />
            Reorder
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          <motion.div key={activeTab} initial={{
          opacity: 0,
          y: 8
        }} animate={{
          opacity: 1,
          y: 0
        }} exit={{
          opacity: 0,
          y: -6
        }} transition={{
          duration: 0.2
        }}>
            <TabsContent value="gaps" className="mt-6">
              <GapsTab orgId={currentOrg.id} setError={setError} />
            </TabsContent>
            <TabsContent value="utilization" className="mt-6">
              <UtilizationTab orgId={currentOrg.id} setError={setError} />
            </TabsContent>
            <TabsContent value="reorder" className="mt-6">
              <ReorderTab orgId={currentOrg.id} setError={setError} />
            </TabsContent>
          </motion.div>
        </AnimatePresence>
      </Tabs>
    </div>;
}
function GapsTab({
  orgId,
  setError
}: {
  orgId: string;
  setError: (e: string) => void;
}) {
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await retrievalApi.gaps(orgId);
      setGaps(data.gaps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load gaps");
    } finally {
      setLoading(false);
    }
  }, [orgId, setError]);
  useEffect(() => {
    load();
  }, [load]);
  return <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">
          Top queries your retrieval layer couldn&apos;t answer — the highest-ROI training data
        </p>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {loading && gaps.length === 0 ? <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div> : gaps.length === 0 ? <Card padding="lg">
          <EmptyState icon={Lightbulb} title="No knowledge gaps detected" description="Your retrieval layer is covering every query — nice work." size="lg" />
        </Card> : <Card padding="lg" className="overflow-hidden">
          <DataTable columns={[{
        key: "query",
        header: "Query",
        sortable: true,
        cell: g => <span className="text-[var(--text-primary)]">{g.query}</span>
      }, {
        key: "gap_score",
        header: "Gap score",
        sortable: true,
        align: "right",
        cell: g => <span className={cn("text-xs px-2 py-0.5 rounded-full font-medium", g.gap_score >= 0.7 ? "bg-[var(--error-bg)] text-[var(--error)]" : g.gap_score >= 0.4 ? "bg-[var(--warning-bg)] text-[var(--warning)]" : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)]")}>
                    {(g.gap_score * 100).toFixed(0)}%
                  </span>
      }, {
        key: "example_trace_id",
        header: "Example trace",
        cell: g => <span className="font-mono text-xs text-[var(--text-muted)]">
                    {g.example_trace_id?.slice(0, 20) ?? "—"}…
                  </span>
      }]} rows={gaps} rowKey={(_g, i) => String(i)} defaultSort={{
        key: "gap_score",
        direction: "desc"
      }} emptyTitle="No knowledge gaps detected" emptyDescription="Your retrieval layer is covering every query — nice work." emptyIcon={Lightbulb} pageSize={25} />
        </Card>}
    </div>;
}
function UtilizationTab({
  orgId,
  setError
}: {
  orgId: string;
  setError: (e: string) => void;
}) {
  const [traceId, setTraceId] = useState("");
  const [result, setResult] = useState<UtilizationResult | null>(null);
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
      setError(err instanceof Error ? err.message : "Utilization failed");
    } finally {
      setLoading(false);
    }
  }
  return <div className="space-y-4">
      <Card padding="lg">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
          <Search className="w-4 h-4 text-[var(--accent)]" />
          Trace utilization
        </h3>
        <div className="flex flex-col sm:flex-row gap-3">
          <input type="text" value={traceId} onChange={e => setTraceId(e.target.value)} placeholder="Enter trace ID..." className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]" />
          <button onClick={handleRun} disabled={loading || !traceId.trim()} className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Analyze
          </button>
        </div>
      </Card>

      {loading && <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>}

      {result && <motion.div initial={{
      opacity: 0,
      y: 8
    }} animate={{
      opacity: 1,
      y: 0
    }} className="space-y-4">
          <Card padding="lg">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Utilization score
              </h3>
              <span className={cn("text-2xl font-bold", result.utilization > 0.7 ? "text-[var(--terminal)]" : result.utilization > 0.4 ? "text-[var(--warning)]" : "text-[var(--error)]")}>
                {(result.utilization * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-3 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
              <div className={cn("h-full rounded-full transition-all", result.utilization > 0.7 ? "bg-[var(--terminal)]" : result.utilization > 0.4 ? "bg-[var(--warning)]" : "bg-[var(--error)]")} style={{
            width: `${result.utilization * 100}%`
          }} />
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-2">
              {result.used_chunks.length} used · {result.unused_chunks.length} unused
            </p>
          </Card>

          <div className="grid sm:grid-cols-2 gap-4">
            <ChunkList title="Used chunks" icon={CheckCircle2} iconClass="text-[var(--terminal)]" chunks={result.used_chunks} tone="used" />
            <ChunkList title="Unused chunks (dead weight)" icon={XCircle} iconClass="text-[var(--error)]" chunks={result.unused_chunks} tone="unused" />
          </div>
        </motion.div>}

      {!result && !loading && <Card padding="lg">
          <EmptyState icon={Sparkles} title="Enter a trace ID" description="See exactly which chunks your retrieval layer paid for vs which the model actually used" size="md" />
        </Card>}
    </div>;
}
function ChunkList({
  title,
  icon: Icon,
  iconClass,
  chunks,
  tone
}: {
  title: string;
  icon: typeof CheckCircle2;
  iconClass: string;
  chunks: string[];
  tone: "used" | "unused";
}) {
  return <div className={cn("rounded-xl border p-4", tone === "used" ? "border-[var(--terminal)]/20 bg-[var(--terminal-faint)]/20" : "border-[var(--error)]/20 bg-[var(--error-bg)]/30")}>
      <h4 className="text-xs font-semibold text-[var(--text-primary)] mb-3 flex items-center gap-2">
        <Icon className={cn("w-4 h-4", iconClass)} />
        {title}
      </h4>
      {chunks.length === 0 ? <p className="text-xs text-[var(--text-muted)]">None</p> : <ul className="space-y-1.5 max-h-64 overflow-auto">
          {chunks.map(c => <li key={c} className="font-mono text-xs text-[var(--text-secondary)] truncate">
              {c}
            </li>)}
        </ul>}
    </div>;
}
function ReorderTab({
  orgId,
  setError
}: {
  orgId: string;
  setError: (e: string) => void;
}) {
  const [entries, setEntries] = useState<ReorderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await retrievalApi.reorder(orgId);
      setEntries(data.reordering ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reorder");
    } finally {
      setLoading(false);
    }
  }, [orgId, setError]);
  useEffect(() => {
    load();
  }, [load]);
  return <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">
          Suggested chunk ordering — front-load the chunks the model actually reads
        </p>
        <button onClick={load} disabled={loading} className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {loading && entries.length === 0 ? <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div> : entries.length === 0 ? <Card padding="lg">
          <EmptyState icon={Shuffle} title="No reordering suggested" description="Your current chunk ordering is already optimal" size="lg" />
        </Card> : <Card padding="lg" className="overflow-hidden">
          <DataTable columns={[{
        key: "chunk_id",
        header: "Chunk ID",
        sortable: true,
        cell: e => <span className="font-mono text-xs text-[var(--text-primary)]">{e.chunk_id}</span>
      }, {
        key: "new_position",
        header: "New position",
        sortable: true,
        align: "right",
        cell: e => <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--accent-faint)] text-[var(--accent)]">#{e.new_position}</span>
      }, {
        key: "reason",
        header: "Reason",
        cell: e => <span className="text-[var(--text-secondary)] text-xs">{e.reason}</span>
      }]} rows={entries} rowKey={e => e.chunk_id} defaultSort={{
        key: "new_position",
        direction: "asc"
      }} emptyTitle="No reordering suggested" emptyDescription="Your current chunk ordering is already optimal" emptyIcon={Shuffle} pageSize={25} />
        </Card>}
    </div>;
}