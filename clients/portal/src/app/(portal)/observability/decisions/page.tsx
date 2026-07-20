"use client";

import { memo, useState } from "react";
import { useOrg } from "@/hooks/use-org";
import { replayApi, type DecisionExplainStep, type DecisionPathStep } from "@/lib/api";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { NoOrgState } from "@/components/ui/no-org-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Compass, Loader2, GitBranch, Lightbulb, Info, Sparkles, Play, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { PageContent } from "@/components/layout/page-content";
import { errorFromCaught } from "@/lib/safe-error-message";

interface DecisionPath {
  trace_id: string;
  steps: DecisionPathStep[];
}

type LastAction = "path" | "explain" | null;

export default function DecisionsPage() {
  const { currentOrg } = useOrg();
  const [error, setError] = useState("");
  const [lastAction, setLastAction] = useState<LastAction>(null);

  const [pathTraceId, setPathTraceId] = useState("");
  const [pathLoading, setPathLoading] = useState(false);
  const [pathData, setPathData] = useState<DecisionPath | null>(null);

  const [explTraceId, setExplTraceId] = useState("");
  const [explStepIndex, setExplStepIndex] = useState("");
  const [explLoading, setExplLoading] = useState(false);
  const [explSteps, setExplSteps] = useState<DecisionExplainStep[]>([]);
  const [explTraceLabel, setExplTraceLabel] = useState("");

  async function handlePath() {
    if (!currentOrg) return;
    setError("");
    setLastAction("path");
    if (!pathTraceId.trim()) {
      setError("Trace id is required.");
      return;
    }
    setPathLoading(true);
    try {
      const data = await replayApi.decisionPath(currentOrg.id, pathTraceId.trim());
      setPathData({ trace_id: data.trace_id, steps: data.steps ?? [] });
    } catch (err) {
      setError(errorFromCaught(err, "Failed to load decision path"));
    } finally {
      setPathLoading(false);
    }
  }

  async function handleExplain() {
    if (!currentOrg) return;
    setError("");
    setLastAction("explain");
    if (!explTraceId.trim()) {
      setError("Trace id is required.");
      return;
    }
    let filterIdx: number | null = null;
    if (explStepIndex.trim() !== "") {
      const idx = Number(explStepIndex);
      if (Number.isNaN(idx)) {
        setError("Step index must be a number.");
        return;
      }
      filterIdx = idx;
    }
    setExplLoading(true);
    try {
      const data = await replayApi.reasoningExplain(currentOrg.id, explTraceId.trim());
      const steps = data.steps ?? [];
      setExplTraceLabel(data.trace_id);
      if (filterIdx === null) {
        setExplSteps(steps);
      } else {
        const match = steps.filter((s) => s.step_index === filterIdx);
        if (match.length === 0) {
          setExplSteps([]);
          setError(`No reasoning step at index ${filterIdx}.`);
        } else {
          setExplSteps(match);
        }
      }
    } catch (err) {
      setError(errorFromCaught(err, "Failed to explain step"));
    } finally {
      setExplLoading(false);
    }
  }

  function retryLast() {
    if (lastAction === "path") void handlePath();
    else if (lastAction === "explain") void handleExplain();
  }

  if (!currentOrg) {
    return (
      <PageContent size="wide">
        <NoOrgState icon={Compass} feature="Decision Intelligence" description="Step-by-step reasoning with alternatives considered — choose an organization to begin." />
      </PageContent>
    );
  }

  return (
    <PageContent size="wide">
      <PageHeader title="Decisions" subtitle="Trace the choice points in your agent's reasoning" icon={Compass} eyebrow="Observe" />

      {error ? (
        <ErrorState
          title="Could not load decisions"
          message={error}
          action={
            lastAction ? (
              <Button size="sm" variant="outline" onClick={retryLast}>
                Try again
              </Button>
            ) : undefined
          }
        />
      ) : null}

      <section className="space-y-4">
        <Card padding="lg" className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-[var(--accent)]" />
            Decision path
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Walk through every decision step in a trace and inspect the action the agent chose.
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={pathTraceId}
              onChange={(e) => setPathTraceId(e.target.value)}
              placeholder="trace_abc123"
              className="flex-1 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono"
            />
            <button
              onClick={handlePath}
              disabled={pathLoading}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {pathLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              Show path
            </button>
          </div>
        </Card>

        {pathLoading ? (
          <div className="space-y-3 py-4" aria-busy="true" aria-live="polite">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : pathData ? (
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {pathData.steps.length} decision step{pathData.steps.length === 1 ? "" : "s"}
              </h3>
              <span className="text-xs text-[var(--text-muted)] font-mono">{pathData.trace_id}</span>
            </div>
            {pathData.steps.length === 0 ? (
              <EmptyState icon={GitBranch} title="No decision steps" description="This trace has no recorded decision steps." size="sm" />
            ) : (
              <ol className="relative space-y-4 ml-2">
                <div className="absolute left-[10px] top-2 bottom-2 w-px bg-[var(--border-default)]" aria-hidden="true" />
                {pathData.steps.map((d) => (
                  <DecisionStep key={d.step_index} step={d} />
                ))}
              </ol>
            )}
          </div>
        ) : null}
      </section>

      <section className="space-y-4">
        <Card padding="lg" className="space-y-3">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Lightbulb className="w-4 h-4 text-[var(--accent)]" />
            Reasoning explainer
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Deep-dive into each step&apos;s reasoning text and the observation that preceded it. Optionally filter by step index.
          </p>
          <div className="grid sm:grid-cols-3 gap-2">
            <div className="sm:col-span-2">
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Trace ID</label>
              <input
                type="text"
                value={explTraceId}
                onChange={(e) => setExplTraceId(e.target.value)}
                placeholder="trace_abc123"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">Step index (optional)</label>
              <input
                type="text"
                value={explStepIndex}
                onChange={(e) => setExplStepIndex(e.target.value)}
                placeholder="all"
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
              />
            </div>
          </div>
          <button
            onClick={handleExplain}
            disabled={explLoading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--bg-base)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
          >
            {explLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            Explain
          </button>
        </Card>

        {explLoading ? (
          <div className="space-y-3 py-4" aria-busy="true" aria-live="polite">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        ) : explSteps.length > 0 ? (
          <div className="space-y-3">
            {explTraceLabel && (
              <p className="text-xs text-[var(--text-muted)] font-mono">{explTraceLabel}</p>
            )}
            {explSteps.map((step) => (
              <div
                key={step.step_index}
                className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5 space-y-3"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-[var(--accent-faint)] text-[var(--accent)]">
                    Step {step.step_index}
                  </span>
                  {step.action && (
                    <span className="text-xs text-[var(--text-secondary)] font-mono">{step.action}</span>
                  )}
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">Reasoning</h3>
                </div>
                <p className="text-sm text-[var(--text-primary)] leading-relaxed whitespace-pre-wrap">
                  {step.reasoning_text || "—"}
                </p>
                {step.observation && (
                  <div>
                    <h4 className="text-xs font-semibold text-[var(--text-muted)] mb-2 uppercase tracking-wide flex items-center gap-1.5">
                      <Info className="w-3.5 h-3.5" />
                      Observation
                    </h4>
                    <div className="flex items-start gap-2 text-xs text-[var(--text-secondary)] px-2 py-1.5 rounded bg-[var(--bg-secondary)]">
                      <ArrowRight className="w-3 h-3 text-[var(--accent)] mt-0.5 flex-shrink-0" />
                      <span className="whitespace-pre-wrap">{step.observation}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </PageContent>
  );
}

const DecisionStep = memo(function DecisionStep({ step }: { step: DecisionPathStep }) {
  return (
    <li className="relative pl-8">
      <div className="absolute left-0 top-0 w-5 h-5 rounded-full bg-[var(--accent)] text-[var(--bg-base)] flex items-center justify-center text-[10px] font-bold">
        {step.step_index + 1}
      </div>
      <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 space-y-2">
        <p className="text-sm text-[var(--text-primary)] font-medium">
          {step.chosen_action || "(no action)"}
        </p>
        {step.event_type && (
          <span className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{step.event_type}</span>
        )}
        {step.reasoning && (
          <p className="text-xs text-[var(--text-muted)] italic">Reasoning: {step.reasoning}</p>
        )}
      </div>
    </li>
  );
});
