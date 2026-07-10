"use client";

import { memo, useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { replayApi } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { PageHeader } from "@/components/layout/page-header";
import { motion, AnimatePresence } from "framer-motion";
import { Compass, Loader2, AlertTriangle, GitBranch, Lightbulb, ChevronDown, ChevronRight, ArrowRight, Info, Sparkles, Play } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PageContent } from "@/components/layout/page-content";
interface Decision {
  step_index: number;
  decision: string;
  alternatives: string[];
  chosen_reason: string;
}
interface DecisionPath {
  trace_id: string;
  decisions: Decision[];
}
interface Reasoning {
  step_index: number;
  reasoning: string;
  supporting_evidence: string[];
}
export default function DecisionsPage() {
  const {
    currentOrg
  } = useOrg();
  const [error, setError] = useState("");

  // Decision path
  const [pathTraceId, setPathTraceId] = useState("");
  const [pathLoading, setPathLoading] = useState(false);
  const [pathData, setPathData] = useState<DecisionPath | null>(null);

  // Reasoning explainer
  const [explTraceId, setExplTraceId] = useState("");
  const [explStepIndex, setExplStepIndex] = useState("");
  const [explLoading, setExplLoading] = useState(false);
  const [explData, setExplData] = useState<Reasoning | null>(null);
  async function handlePath() {
    if (!currentOrg) return;
    setError("");
    if (!pathTraceId.trim()) {
      setError("Trace id is required.");
      return;
    }
    setPathLoading(true);
    try {
      const data = await replayApi.decisionPath(currentOrg.id, {
        trace_id: pathTraceId.trim()
      });
      setPathData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load decision path");
    } finally {
      setPathLoading(false);
    }
  }
  async function handleExplain() {
    if (!currentOrg) return;
    setError("");
    if (!explTraceId.trim() || explStepIndex.trim() === "") {
      setError("Trace id and step index are required.");
      return;
    }
    const idx = Number(explStepIndex);
    if (Number.isNaN(idx)) {
      setError("Step index must be a number.");
      return;
    }
    setExplLoading(true);
    try {
      const data = await replayApi.reasoningExplain(currentOrg.id, {
        trace_id: explTraceId.trim(),
        step_index: idx
      });
      setExplData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to explain step");
    } finally {
      setExplLoading(false);
    }
  }
  if (!currentOrg) {
    return (
      <PageContent size="wide">
        <NoOrgState icon={Compass} feature="Decision Intelligence" description="Step-by-step reasoning with alternatives considered — choose an organization to begin." />
      </PageContent>
    );
  }
  return <PageContent size="wide">
      <PageHeader title="Decisions" subtitle="Trace the choice points in your agent's reasoning" icon={Compass} eyebrow="Observe" />

      {error && <div className="bg-[var(--error-bg)] text-[var(--error)] text-sm px-4 py-3 rounded-xl flex items-center gap-2.5 border border-[var(--error)]/20">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>}

      {/* Decision Path Section */}
      <section className="space-y-4">
        <Card padding="lg" className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-[var(--accent)]" />
            Decision path
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Walk through every decision step in a trace and inspect the alternatives the agent considered.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input type="text" value={pathTraceId} onChange={e => setPathTraceId(e.target.value)} placeholder="trace_abc123" className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono" />
            <button onClick={handlePath} disabled={pathLoading} className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
              {pathLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Show path
            </button>
          </div>
        </Card>

        <AnimatePresence mode="wait">
          {pathLoading ? <motion.div key="path-loading" initial={{
          opacity: 0
        }} animate={{
          opacity: 1
        }} exit={{
          opacity: 0
        }} className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
            </motion.div> : pathData ? <motion.div key="path-result" initial={{
          opacity: 0,
          y: 8
        }} animate={{
          opacity: 1,
          y: 0
        }} exit={{
          opacity: 0,
          y: -6
        }} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  {pathData.decisions.length} decision step{pathData.decisions.length === 1 ? "" : "s"}
                </h3>
                <span className="text-xs text-[var(--text-muted)] font-mono">{pathData.trace_id}</span>
              </div>
              {pathData.decisions.length === 0 ? <EmptyState icon={GitBranch} title="No decision steps" description="This trace has no recorded decision steps." size="sm" /> : <ol className="relative space-y-4 ml-2">
                  <div className="absolute left-[10px] top-2 bottom-2 w-px bg-[var(--border-default)]" aria-hidden="true" />
                  {pathData.decisions.map(d => <DecisionStep key={d.step_index} decision={d} />)}
                </ol>}
            </motion.div> : null}
        </AnimatePresence>
      </section>

      {/* Reasoning Explainer Section */}
      <section className="space-y-4">
        <Card padding="lg" className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-[var(--accent)]" />
            Reasoning explainer
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Deep-dive into a specific step&apos;s reasoning and the evidence that supported it.
          </p>
          <div className="grid sm:grid-cols-3 gap-2">
            <div className="sm:col-span-2">
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Trace ID</label>
              <input type="text" value={explTraceId} onChange={e => setExplTraceId(e.target.value)} placeholder="trace_abc123" className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono" />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Step index</label>
              <input type="text" value={explStepIndex} onChange={e => setExplStepIndex(e.target.value)} placeholder="0" className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]" />
            </div>
          </div>
          <button onClick={handleExplain} disabled={explLoading} className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors">
            {explLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Explain
          </button>
        </Card>

        <AnimatePresence mode="wait">
          {explLoading ? <motion.div key="expl-loading" initial={{
          opacity: 0
        }} animate={{
          opacity: 1
        }} exit={{
          opacity: 0
        }} className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-[var(--accent)]" />
            </motion.div> : explData ? <motion.div key="expl-result" initial={{
          opacity: 0,
          y: 8
        }} animate={{
          opacity: 1,
          y: 0
        }} exit={{
          opacity: 0,
          y: -6
        }} className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--accent-faint)] text-[var(--accent)]">
                  Step {explData.step_index}
                </span>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Reasoning</h3>
              </div>
              <p className="text-sm text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap">
                {explData.reasoning}
              </p>

              {explData.supporting_evidence.length > 0 && <div>
                  <h4 className="text-xs font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wide flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5" />
                    Supporting evidence
                  </h4>
                  <ul className="space-y-1.5">
                    {explData.supporting_evidence.map((e, i) => <li key={i} className="flex items-start gap-2 text-xs text-[var(--text-secondary)] px-2 py-1.5 rounded bg-[var(--bg-secondary)]">
                        <ArrowRight className="w-3 h-3 text-[var(--accent)] mt-0.5 flex-shrink-0" />
                        <span className="whitespace-pre-wrap">{e}</span>
                      </li>)}
                  </ul>
                </div>}
            </motion.div> : null}
        </AnimatePresence>
      </section>
    </PageContent>;
}

// ──────────────────────────────────────────────────────────────────────────
// Decision Step (with alternatives accordion)
// ──────────────────────────────────────────────────────────────────────────

const DecisionStep = memo(function DecisionStep({
  decision
}: {
  decision: Decision;
}) {
  const [altOpen, setAltOpen] = useState(false);
  return <li className="relative pl-8">
      <div className="absolute left-0 top-0 w-5 h-5 rounded-full bg-[var(--accent)] text-[var(--bg-base)] flex items-center justify-center text-[10px] font-bold">
        {decision.step_index + 1}
      </div>
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 space-y-2">
        <p className="text-sm text-[var(--text-primary)]">{decision.decision}</p>
        {decision.chosen_reason && <p className="text-xs text-[var(--text-muted)] italic">Chose this because: {decision.chosen_reason}</p>}
        {decision.alternatives.length > 0 && <div>
            <button onClick={() => setAltOpen(!altOpen)} className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">
              {altOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {decision.alternatives.length} alternative{decision.alternatives.length === 1 ? "" : "s"}
            </button>
            <AnimatePresence>
              {altOpen && <motion.ul initial={{
            opacity: 0,
            height: 0
          }} animate={{
            opacity: 1,
            height: "auto"
          }} exit={{
            opacity: 0,
            height: 0
          }} className="mt-2 space-y-1.5 overflow-hidden">
                  {decision.alternatives.map((alt, i) => <li key={i} className="text-xs text-[var(--text-secondary)] px-2 py-1.5 rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                      {alt}
                    </li>)}
                </motion.ul>}
            </AnimatePresence>
          </div>}
      </div>
    </li>;
});