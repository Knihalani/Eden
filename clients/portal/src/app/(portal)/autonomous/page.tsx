"use client";

import { useEffect, useState } from "react";
import {
  Loader2,
  AlertTriangle,
  Send,
  Search,
  Lightbulb,
  Wrench,
  ShieldAlert,
  Database,
  Wand2,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { useOrg } from "@/hooks/use-org";
import { autonomousApi } from "@/lib/api";
import { PageHeader } from "@/components/layout/page-header";
import { cn } from "@/lib/utils";

/* ----------------------- NL Query section ---------------------------- */

function NLQuerySection() {
  const { currentOrg } = useOrg();
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<{
    question: string;
    sql: string;
    rows: Array<Record<string, unknown>>;
    explanation: string;
  } | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg || !question.trim()) return;
    setSubmitting(true);
    setError("");
    setResult(null);
    try {
      const res = await autonomousApi.nlQuery(currentOrg.id, { question: question.trim() });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run NL query");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Natural language query</CardTitle>
        <CardDescription>Ask anything about your traces, agents, or cost</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Top 5 agents by total cost this week…"
            className="flex-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
          />
          <button
            type="submit"
            disabled={submitting || !question.trim()}
            className={cn(
              "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
              "bg-[var(--accent)] text-[var(--bg-primary)] shadow-sm hover:bg-[var(--accent-hover)]",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Ask
          </button>
        </form>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-start gap-2 rounded-md border border-[var(--error)] bg-[var(--error-bg)] p-3 text-xs text-[var(--error)]"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-3"
            >
              {/* Generated SQL */}
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Generated SQL
                </p>
                <pre className="overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 font-mono text-xs text-[var(--text-secondary)]">
                  {result.sql}
                </pre>
              </div>

              {/* Rows */}
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Result · {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
                </p>
                {result.rows.length > 0 ? (
                  <div className="rounded-md border border-[var(--border-subtle)]">
                    <DataTable
                      columns={Object.keys(result.rows[0]).map((k) => ({
                        key: k,
                        header: k,
                        cell: (r: Record<string, unknown>) => (
                          <span className="font-mono text-xs text-[var(--text-secondary)]">
                            {(() => {
                              const v = r[k];
                              return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "—");
                            })()}
                          </span>
                        ),
                      }))}
                      rows={result.rows as Array<Record<string, unknown>>}
                      rowKey={(_, i) => `row_${i}`}
                      pageSize={50}
                    />
                  </div>
                ) : (
                  <EmptyState icon={Database} title="No rows returned" size="sm" />
                )}
              </div>

              {/* Explanation */}
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Explanation
                </p>
                <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-sm text-[var(--text-primary)]">
                  {result.explanation}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

/* ----------------------- Investigate tab ----------------------------- */

function InvestigateTab() {
  const { currentOrg } = useOrg();
  const [traceId, setTraceId] = useState("");
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<{
    investigation_id: string;
    findings: string;
    recommended_actions: string[];
    confidence: number;
  } | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg || !question.trim()) return;
    setSubmitting(true);
    setError("");
    setResult(null);
    try {
      const res = await autonomousApi.investigate(currentOrg.id, {
        ...(traceId.trim() ? { trace_id: traceId.trim() } : {}),
        question: question.trim(),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to run investigation");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Investigate</CardTitle>
        <CardDescription>Run an autonomous investigation on a trace or topic</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Trace ID (optional)
            </span>
            <input
              type="text"
              value={traceId}
              onChange={(e) => setTraceId(e.target.value)}
              placeholder="trc_…"
              className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Question
            </span>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              required
              rows={3}
              placeholder="Why did this trace fail…"
              className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={submitting || !question.trim()}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
              "bg-[var(--accent)] text-[var(--bg-primary)] shadow-sm hover:bg-[var(--accent-hover)]",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            Investigate
          </button>
        </form>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-start gap-2 rounded-md border border-[var(--error)] bg-[var(--error-bg)] p-3 text-xs text-[var(--error)]"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-3"
            >
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Findings · confidence {(result.confidence * 100).toFixed(0)}%
                </p>
                <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-sm text-[var(--text-primary)]">
                  {result.findings}
                </p>
              </div>
              {result.recommended_actions.length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                    Recommended actions
                  </p>
                  <ul className="space-y-1 rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-sm text-[var(--text-primary)]">
                    {result.recommended_actions.map((a, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                        <span>{a}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

/* ----------------------- Recommendations tab ------------------------ */

const IMPACT_COLORS: Record<string, string> = {
  high: "bg-[var(--error-bg)] text-[var(--error)]",
  medium: "bg-[var(--warning-bg)] text-[var(--warning)]",
  low: "bg-[var(--success-bg)] text-[var(--success)]",
};

function RecommendationsTab() {
  const { currentOrg } = useOrg();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [items, setItems] = useState<
    Array<{ id: string; title: string; impact: string; effort: string; rationale: string }>
  >([]);

  useEffect(() => {
    if (!currentOrg) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError("");
    });
    autonomousApi
      .recommendations(currentOrg.id)
      .then((res: { recommendations?: Array<{ id: string; title: string; impact: string; effort: string; rationale: string }> }) => {
        if (cancelled) return;
        setItems(res.recommendations ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load recommendations");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }
  if (error) {
    return <EmptyState icon={AlertTriangle} title="Could not load recommendations" description={error} size="md" />;
  }
  if (items.length === 0) {
    return <EmptyState icon={Lightbulb} title="No recommendations" size="md" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recommendations</CardTitle>
        <CardDescription>Suggestions ranked by impact and effort</CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <DataTable
          columns={[
            { key: "title", header: "Title", cell: (r) => <span className="font-medium text-[var(--text-primary)]">{r.title}</span>, sortable: true },
            {
              key: "impact",
              header: "Impact",
              cell: (r) => (
                <span
                  className={cn(
                    "inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                    IMPACT_COLORS[r.impact] ?? "bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                  )}
                >
                  {r.impact}
                </span>
              ),
            },
            { key: "effort", header: "Effort", cell: (r) => <span className="text-[var(--text-secondary)]">{r.effort}</span> },
            { key: "rationale", header: "Rationale", cell: (r) => <span className="max-w-md text-[var(--text-secondary)]">{r.rationale}</span> },
          ]}
          rows={items}
          rowKey={(r) => r.id}
          defaultSort={{ key: "title", direction: "asc" }}
          emptyIcon={Lightbulb}
          emptyTitle="No recommendations"
        />
      </CardContent>
    </Card>
  );
}

/* ----------------------- Self-heal tab ------------------------------- */

const HEAL_COMPONENTS = [
  { value: "PromotionLoop", label: "PromotionLoop" },
  { value: "ModelRouter", label: "ModelRouter" },
  { value: "SemanticCache", label: "SemanticCache" },
];

function HealTab() {
  const { currentOrg } = useOrg();
  const [component, setComponent] = useState("PromotionLoop");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<{
    heal_id: string;
    status: "pending_approval" | "applied" | "rejected";
    before_state: Record<string, unknown>;
    proposed_change: string;
  } | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg || !description.trim()) return;
    setSubmitting(true);
    setError("");
    setResult(null);
    try {
      const res = await autonomousApi.heal(currentOrg.id, {
        component,
        description: description.trim(),
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to request heal");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Self-heal</CardTitle>
        <CardDescription>
          Propose a safe, reversible change. Heals are <strong>never</strong> auto-applied — they
          always require admin approval.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Component
            </span>
            <select
              value={component}
              onChange={(e) => setComponent(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
            >
              {HEAL_COMPONENTS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Description
            </span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              rows={3}
              placeholder="Describe the issue and the proposed change…"
              className="mt-1 w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={submitting || !description.trim()}
            className={cn(
              "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
              "bg-[var(--accent)] text-[var(--bg-primary)] shadow-sm hover:bg-[var(--accent-hover)]",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wrench className="h-4 w-4" />}
            Propose heal
          </button>
        </form>

        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-start gap-2 rounded-md border border-[var(--error)] bg-[var(--error-bg)] p-3 text-xs text-[var(--error)]"
            >
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="space-y-3"
            >
              <div className="flex items-start gap-2 rounded-md border border-[var(--warning)] bg-[var(--warning-bg)] p-3 text-xs text-[var(--warning)]">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <span>
                  Status: <strong>{result.status}</strong>. This change has not been applied and
                  requires explicit admin approval before execution.
                </span>
              </div>
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Heal ID
                </p>
                <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-2 font-mono text-xs text-[var(--text-secondary)]">
                  {result.heal_id}
                </p>
              </div>
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Proposed change
                </p>
                <p className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 text-sm text-[var(--text-primary)]">
                  {result.proposed_change}
                </p>
              </div>
              <div>
                <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                  Before state (for diff)
                </p>
                <pre className="overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3 font-mono text-xs text-[var(--text-secondary)]">
                  {JSON.stringify(result.before_state, null, 2)}
                </pre>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}

/* ----------------------- Page ---------------------------------------- */

type Tab = "investigate" | "recommendations" | "heal";

export default function AutonomousPage() {
  const { currentOrg } = useOrg();
  const [tab, setTab] = useState<Tab>("investigate");

  if (!currentOrg) {
    return <NoOrgState feature="Autonomous intelligence" icon={Wand2} description="Select an organization to run investigations and self-heals" />;
  }

  return (
    <div className="page-enter mx-auto max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Autonomous intelligence"
        subtitle="Ask questions in plain English, run investigations, and propose self-heals."
        icon={Wand2}
      />

      <NLQuerySection />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList variant="underline" className="w-full">
          <TabsTrigger value="investigate" variant="underline">
            Investigate
          </TabsTrigger>
          <TabsTrigger value="recommendations" variant="underline">
            Recommendations
          </TabsTrigger>
          <TabsTrigger value="heal" variant="underline">
            Self-heal
          </TabsTrigger>
        </TabsList>

        <AnimatePresence mode="wait">
          {tab === "investigate" && (
            <TabsContent value="investigate">
              <motion.div
                key="investigate"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "investigate" && <InvestigateTab />}
              </motion.div>
            </TabsContent>
          )}
          {tab === "recommendations" && (
            <TabsContent value="recommendations">
              <motion.div
                key="recommendations"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "recommendations" && <RecommendationsTab />}
              </motion.div>
            </TabsContent>
          )}
          {tab === "heal" && (
            <TabsContent value="heal">
              <motion.div
                key="heal"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
              >
                {tab === "heal" && <HealTab />}
              </motion.div>
            </TabsContent>
          )}
        </AnimatePresence>
      </Tabs>
    </div>
  );
}
