"use client";

/**
 * Heavy Trace detail panels — loaded via next/dynamic so list-only paint
 * does not pull virtualised tree / signals / ask chrome.
 */

import Link from "next/link";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { measureVirtualRow, VIRTUAL_SCROLL_ATTR } from "@/lab/virtual-list";
import { X } from "lucide-react";
import {
  formatDuration,
  type TraceFixture,
  type TranscriptStep,
} from "@/lab/fixtures/traces";
import { type IssueFixture } from "@/lab/fixtures/issues";
import { signalsForTrace } from "@/lab/fixtures/signals";
import {
  EmptyState,
  isBadStep,
  SeverityBadge,
  stepKindLabel,
} from "@/lab/lab-ui";
import { cn } from "@/lib/utils";

type TreeRow = {
  step: TranscriptStep;
  depth: number;
  hasChildren: boolean;
};

/**
 * Depth-first flatten of the span tree. Virtualising needs a flat,
 * index-addressable list — a recursive JSX walk can only render the
 * whole tree at once. `seen` guards against a malformed payload whose
 * parent pointers form a cycle (the old recursion would hang).
 */
export function flattenSpanTree(steps: TranscriptStep[]): TreeRow[] {
  const byParent = new Map<string | undefined, TranscriptStep[]>();
  for (const step of steps) {
    const key = step.parentId;
    const list = byParent.get(key) ?? [];
    list.push(step);
    byParent.set(key, list);
  }
  const roots = byParent.get(undefined) ?? steps.filter((s) => !s.parentId);

  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (nodes: TranscriptStep[], depth: number) => {
    for (const step of nodes) {
      if (seen.has(step.id)) continue;
      seen.add(step.id);
      const kids = byParent.get(step.spanId ?? step.id) ?? [];
      out.push({ step, depth, hasChildren: kids.length > 0 });
      if (kids.length > 0) walk(kids, depth + 1);
    }
  };
  walk(roots, 0);
  // Parents truncated by max_spans (or missing) used to drop orphans
  // entirely — Tree undercounted vs Transcript with no warning.
  const orphans = steps.filter((s) => !seen.has(s.id));
  if (orphans.length > 0) walk(orphans, 0);
  return out;
}

/** ~40px at the current density; real heights come from measureElement. */
const TREE_ROW_ESTIMATE = 40;

const TreeRowButton = memo(function TreeRowButton({
  step,
  depth,
  active,
  hasChildren,
  posInSet,
  setSize,
  onFocus,
}: {
  step: TranscriptStep;
  depth: number;
  active: boolean;
  hasChildren: boolean;
  posInSet: number;
  setSize: number;
  onFocus: (id: string) => void;
}) {
  const bad = isBadStep(step);
  const handleClick = useCallback(() => onFocus(step.id), [onFocus, step.id]);
  return (
    <button
      type="button"
      onClick={handleClick}
      role="treeitem"
      aria-level={depth + 1}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-selected={active}
      aria-expanded={hasChildren ? true : undefined}
      className={cn(
        "flex w-full items-center gap-2 py-2.5 pr-4 text-left transition-colors hover:bg-[var(--bg-hover)]",
        active && "bg-[var(--accent-muted)] shadow-[inset_2px_0_0_var(--accent)]",
        bad && !active && "bg-[var(--error-muted)]",
        bad && active && "shadow-[inset_2px_0_0_var(--error)]",
      )}
      style={{ paddingLeft: `${0.75 + depth * 1.1}rem` }}
    >
      <span className="ds-chip shrink-0 border border-[var(--line)] text-[var(--text-muted)]">
        {stepKindLabel(step.kind)}
      </span>
      <span
        className={cn(
          "type-ui min-w-0 flex-1 truncate !font-normal",
          bad ? "text-[var(--error)]" : "text-[var(--text)]",
        )}
      >
        {step.title}
      </span>
      <span className="type-value shrink-0 tabular-nums !text-[0.6875rem]">
        {formatDuration(step.durationMs)}
      </span>
    </button>
  );
});

export function TreePanel({
  steps,
  focusStepId,
  onFocus,
}: {
  steps: TranscriptStep[];
  focusStepId: string | null;
  onFocus: (id: string) => void;
}) {
  const rows = useMemo(() => flattenSpanTree(steps), [steps]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TREE_ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index) => rows[index]?.step.id ?? index,
    measureElement: measureVirtualRow,
  });

  // Bring the focused span into view even when its row is not mounted.
  useEffect(() => {
    if (!focusStepId) return;
    const index = rows.findIndex((r) => r.step.id === focusStepId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [focusStepId, rows, virtualizer]);

  if (rows.length === 0) {
    return <EmptyState title="No spans" />;
  }

  return (
    <div
      ref={scrollRef}
      className="min-h-0 h-full overflow-y-auto py-1"
      {...{ [VIRTUAL_SCROLL_ATTR]: "tree" }}
    >
      <ul
        role="tree"
        aria-label="Span tree"
        className="relative"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <li
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              role="none"
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <TreeRowButton
                step={row.step}
                depth={row.depth}
                active={focusStepId === row.step.id}
                hasChildren={row.hasChildren}
                posInSet={item.index + 1}
                setSize={rows.length}
                onFocus={onFocus}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SignalsPanel({
  trace,
  onJumpStep,
  dismissed,
  onDismiss,
  onRestore,
}: {
  trace: TraceFixture;
  onJumpStep: (stepId: string) => void;
  dismissed: boolean;
  onDismiss: () => void;
  onRestore: () => void;
}) {
  const detectors = signalsForTrace(trace.id);
  const badSteps = trace.steps.filter(isBadStep);
  // severity==="none" used to short-circuit to EmptyState even when
  // the API shipped a "Clean run" summary — so every successful trace
  // looked broken ("No signals").
  const empty =
    !trace.signals.title &&
    detectors.length === 0 &&
    badSteps.length === 0;

  if (empty) {
    return (
      <EmptyState
        title="No signals"
        body="No detectors matched and no failing spans on this run."
      />
    );
  }

  if (dismissed) {
    return (
      <EmptyState
        title="Signals dismissed"
        action={
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onRestore}
          >
            Show
          </button>
        }
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={trace.severity} />
            <p className="type-ui text-[var(--text)]">
              {trace.signals.title ||
                (trace.severity === "none" ? "Clean run" : "Signals")}
            </p>
          </div>
          <p className="type-body mt-2 text-[var(--text-secondary)]">
            {trace.signals.body ||
              (badSteps.length > 0
                ? `${badSteps.length} failing span${badSteps.length === 1 ? "" : "s"}.`
                : "No detectors matched this run.")}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {badSteps.length > 0 ? (
        <section className="space-y-2">
          <h3 className="type-label">Failing spans</h3>
          <ul className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
            {badSteps.map((step) => (
              <li key={step.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 py-3 text-left hover:bg-[var(--accent-muted)]"
                  onClick={() => onJumpStep(step.id)}
                >
                  <SeverityBadge severity="error" />
                  <div className="min-w-0 flex-1">
                    <p className="type-ui truncate text-[var(--text)]">
                      {step.title}
                    </p>
                    <p className="type-meta mt-0.5 break-words whitespace-pre-wrap">
                      {step.errorMessage ?? step.outputPreview ?? step.id}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {detectors.length > 0 ? (
        <section className="space-y-2">
          <h3 className="type-label">Matched detectors</h3>
          <ul className="space-y-1">
            {detectors.map((sig) => (
              <li key={sig.id}>
                <Link
                  href={`/signals?id=${sig.id}`}
                  className="block px-1 py-2.5 transition-colors hover:bg-[var(--accent-muted)]"
                >
                  <p className="type-ui text-[var(--text)]">{sig.name}</p>
                  <p className="type-mono mt-1 !text-[0.6875rem] !text-[var(--text-secondary)]">
                    {sig.condition}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function ChatPanel({
  trace,
  issue,
}: {
  trace: TraceFixture;
  issue?: IssueFixture;
}) {
  const agentHref = (() => {
    const q = new URLSearchParams();
    q.set("thread", "thr_empty");
    q.set("traceId", trace.id);
    q.set("agent", trace.agentId);
    if (issue) q.set("issueId", issue.id);
    return `/agent?${q.toString()}`;
  })();
  const [draft, setDraft] = useState("");

  function openInAgent() {
    const text = draft.trim();
    const q = new URLSearchParams();
    q.set("thread", "thr_empty");
    q.set("traceId", trace.id);
    q.set("agent", trace.agentId);
    if (issue) q.set("issueId", issue.id);
    if (text) q.set("ai_prompt", text);
    window.location.href = `/agent?${q.toString()}`;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2 sm:px-5">
        <p className="type-meta">Ask the assistant about this run</p>
        <Link href={agentHref} className="ds-btn ds-btn-ghost ds-btn-sm">
          Open Assistant
        </Link>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5">
        <p className="type-body text-[var(--text-secondary)]">
          {trace.signals.title
            ? `${trace.signals.title} — ${trace.signals.body || "Open the assistant to investigate."}`
            : `${trace.name} · ${trace.tokens.toLocaleString()} tokens · ${trace.costUsd != null ? `$${trace.costUsd.toFixed(4)}` : "—"}. Open the assistant for a real answer.`}
        </p>
      </div>
      <div className="flex shrink-0 gap-2 border-t border-[var(--line)] px-4 py-3 sm:px-5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openInAgent();
          }}
          placeholder="Ask about this run…"
          className="ds-input min-w-0 flex-1"
          aria-label="Ask about this run"
        />
        <button
          type="button"
          className="ds-btn ds-btn-primary ds-btn-sm shrink-0"
          onClick={openInAgent}
        >
          Ask
        </button>
      </div>
    </div>
  );
}
