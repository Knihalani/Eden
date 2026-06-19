"use client";

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "@/hooks/use-org";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  AlertTriangle,
  Archive,
  Brain,
  Combine,
  Loader2,
  Search,
  TrendingDown,
  Zap,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

async function callApi<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Request failed" }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const memoryApi = {
  attribute: (orgId: string, traceId: string) =>
    callApi<{ trace_id: string; memories: Array<{ memory_id: string; influence: number }>; }>(`/orgs/${orgId}/intelligence/memory/${traceId}/attribute`, { method: "POST" }),
  impact: (orgId: string, traceId: string) =>
    callApi<{ trace_id: string; impact_score: number; components: Record<string, number>; }>(`/orgs/${orgId}/intelligence/memory/${traceId}/impact`, { method: "POST" }),
  reaverSuggest: (orgId: string) =>
    callApi<{ suggestions: Array<{ memory_id: string; action: "merge" | "archive" | "demote"; reason: string }>; }>(`/orgs/${orgId}/intelligence/memory/reaver/suggest`, { method: "POST" }),
};

type SubTab = "attribution" | "impact" | "reaver";

interface AttributionResult {
  trace_id: string;
  memories: Array<{ memory_id: string; influence: number }>;
}

interface ImpactResult {
  trace_id: string;
  impact_score: number;
  components: Record<string, number>;
}

interface ReaverSuggestion {
  memory_id: string;
  action: "merge" | "archive" | "demote";
  reason: string;
}

export default function MemoryIntelligencePage() {
  const { currentOrg } = useOrg();
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
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--text-primary)] flex items-center gap-2">
          <Brain className="w-6 h-6 text-[var(--accent)]" />
          Memory Intelligence
        </h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">
          Find which memories actually matter — score their impact, attribute per-trace influence, and reweave duplicates into a single source of truth
        </p>
      </div>

      {error && (
        <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v as SubTab);
          setError("");
        }}
      >
        <TabsList variant="underline" className="border-b border-[var(--border-default)] w-full justify-start">
          <TabsTrigger value="attribution" variant="underline" className="flex items-center gap-2">
            <Search className="w-4 h-4" />
            Attribution
          </TabsTrigger>
          <TabsTrigger value="impact" variant="underline" className="flex items-center gap-2">
            <Zap className="w-4 h-4" />
            Impact
          </TabsTrigger>
          <TabsTrigger value="reaver" variant="underline" className="flex items-center gap-2">
            <Combine className="w-4 h-4" />
            Reweaver
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
          >
            <TabsContent value="attribution" className="mt-6">
              <AttributionTab orgId={currentOrg.id} setError={setError} />
            </TabsContent>
            <TabsContent value="impact" className="mt-6">
              <ImpactTab orgId={currentOrg.id} setError={setError} />
            </TabsContent>
            <TabsContent value="reaver" className="mt-6">
              <ReaverTab orgId={currentOrg.id} setError={setError} />
            </TabsContent>
          </motion.div>
        </AnimatePresence>
      </Tabs>
    </div>
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
  const [result, setResult] = useState<AttributionResult | null>(null);
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
      setError(err instanceof Error ? err.message : "Attribution failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
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
          <button
            onClick={handleRun}
            disabled={loading || !traceId.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
            Attribute
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>
      )}

      {result && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-3"
        >
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
              Memories that influenced this trace
            </h3>
            {result.memories.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">
                No memories influenced this trace.
              </p>
            ) : (
              <ul className="space-y-2">
                {result.memories.map((m) => (
                  <li
                    key={m.memory_id}
                    className="flex items-center gap-3 p-2.5 rounded-lg bg-[var(--bg-secondary)]"
                  >
                    <span className="font-mono text-xs text-[var(--text-primary)] flex-1 truncate">
                      {m.memory_id}
                    </span>
                    <div className="w-40 flex-shrink-0">
                      <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] rounded-full"
                          style={{ width: `${Math.max(0, Math.min(1, m.influence)) * 100}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-xs text-[var(--text-muted)] w-12 text-right tabular-nums">
                      {(m.influence * 100).toFixed(0)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </motion.div>
      )}

      {!result && !loading && (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
          <EmptyState
            icon={Brain}
            title="Enter a trace ID"
            description="See which memories contributed to a response"
            size="md"
          />
        </div>
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
  const [result, setResult] = useState<ImpactResult | null>(null);
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
      setError(err instanceof Error ? err.message : "Impact scoring failed");
    } finally {
      setLoading(false);
    }
  }

  const componentEntries = result
    ? Object.entries(result.components).sort((a, b) => b[1] - a[1])
    : [];

  return (
    <div className="space-y-4">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
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
          <button
            onClick={handleRun}
            disabled={loading || !traceId.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Score
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
        </div>
      )}

      {result && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Impact score
              </h3>
              <span
                className={cn(
                  "text-2xl font-bold",
                  result.impact_score > 0.7
                    ? "text-[var(--terminal)]"
                    : result.impact_score > 0.4
                      ? "text-[var(--warning)]"
                      : "text-[var(--text-muted)]"
                )}
              >
                {(result.impact_score * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-3 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  result.impact_score > 0.7
                    ? "bg-[var(--terminal)]"
                    : result.impact_score > 0.4
                      ? "bg-[var(--warning)]"
                      : "bg-[var(--text-muted)]"
                )}
                style={{ width: `${Math.max(0, Math.min(1, result.impact_score)) * 100}%` }}
              />
            </div>
          </div>

          {componentEntries.length > 0 && (
            <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                Component breakdown
              </h3>
              <ul className="space-y-2">
                {componentEntries.map(([name, value]) => {
                  const pct = Math.max(0, Math.min(1, value));
                  return (
                    <li key={name} className="flex items-center gap-3">
                      <span className="text-xs text-[var(--text-secondary)] w-32 flex-shrink-0 truncate">
                        {name.replace(/_/g, " ")}
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
            </div>
          )}
        </motion.div>
      )}

      {!result && !loading && (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
          <EmptyState
            icon={Zap}
            title="Enter a trace ID"
            description="See the composite impact score and component breakdown for a trace"
            size="md"
          />
        </div>
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
  const [suggestions, setSuggestions] = useState<ReaverSuggestion[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await memoryApi.reaverSuggest(orgId);
      setSuggestions(data.suggestions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load suggestions");
    } finally {
      setLoading(false);
    }
  }, [orgId, setError]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">
          Reweaver suggestions — merge duplicates, archive dead memories, demote low-influence ones
        </p>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] disabled:opacity-50 transition-colors"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Combine className="w-3.5 h-3.5" />}
          Refresh
        </button>
      </div>

      {loading && suggestions.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-[var(--accent)]" />
        </div>
      ) : suggestions.length === 0 ? (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
          <EmptyState
            icon={Combine}
            title="No reweaver suggestions"
            description="Your memory store is already clean — nothing to merge, archive, or demote"
            size="lg"
          />
        </div>
      ) : (
        <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Memory ID</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide w-36">Action</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">Reason</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {suggestions.map((s) => (
                  <tr key={s.memory_id} className="hover:bg-[var(--bg-tertiary)]/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">
                      {s.memory_id}
                    </td>
                    <td className="px-4 py-3">
                      <ActionBadge action={s.action} />
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)] text-xs">
                      {s.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionBadge({ action }: { action: ReaverSuggestion["action"] }) {
  const map: Record<ReaverSuggestion["action"], { classes: string; icon: typeof Combine }> = {
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
        cfg.classes
      )}
    >
      <Icon className="w-3 h-3" />
      {action}
    </span>
  );
}
