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
import { agentById } from "@/lab/fixtures/agents";
import { type IssueFixture } from "@/lab/fixtures/issues";
import { signalsForTrace } from "@/lab/fixtures/signals";
import {
  EmptyState,
  isBadStep,
  SeverityBadge,
  stepKindLabel,
} from "@/lab/lab-ui";
import { agentLaneColor } from "@/lib/observability/build-transcript-rows";
import { cn } from "@/lib/utils";
import { useOrg } from "@/hooks/use-org";
import { fixtureExportApi } from "@/lib/api/portal";

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
  const laneColor = agentLaneColor(step.agentId);
  const agentLabel = step.agentId
    ? agentById(step.agentId)?.name ?? step.agentId
    : undefined;
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
      data-agent-id={step.agentId}
      className={cn(
        "flex w-full items-center gap-2 py-2.5 pr-4 text-left transition-colors hover:bg-[var(--bg-hover)]",
        active && "bg-[var(--accent-muted)] shadow-[inset_2px_0_0_var(--accent)]",
        bad && !active && "bg-[var(--error-muted)]",
        bad && active && "shadow-[inset_2px_0_0_var(--error)]",
      )}
      style={{
        paddingLeft: `${0.75 + depth * 1.1}rem`,
        ...(laneColor
          ? { borderLeft: `3px solid ${laneColor}` }
          : undefined),
      }}
    >
      <span className="ds-chip shrink-0 border border-[var(--line)] text-[var(--text-muted)]">
        {stepKindLabel(step.kind)}
      </span>
      {agentLabel ? (
        <span
          className="ds-chip hidden max-w-[6rem] shrink-0 truncate border border-[var(--line)] text-[var(--text-muted)] sm:inline"
          title={step.agentId}
        >
          {agentLabel}
        </span>
      ) : null}
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
  const [exporting, setExporting] = useState(false);
  const { currentOrg } = useOrg();

  async function handleExportFixture() {
    if (!currentOrg?.id || exporting) return;
    setExporting(true);
    try {
      const res = await fixtureExportApi.exportTrace(currentOrg.id, trace.id);
      const blob = new Blob([res.data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `eden-trace-${trace.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Silently fail — user can retry; no toast infrastructure here.
    } finally {
      setExporting(false);
    }
  }

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
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={() => { void handleExportFixture(); }}
            disabled={exporting || !currentOrg?.id}
            aria-label="Export trace as JSON fixture"
          >
            {exporting ? "Exporting…" : "Export fixture"}
          </button>
          <Link href={agentHref} className="ds-btn ds-btn-ghost ds-btn-sm">
            Open Assistant
          </Link>
        </div>
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

// ── Agent graph panel (W4-5) ─────────────────────────────────────────────────

const NODE_W = 144;
const NODE_H = 60;
/** Left-edge to left-edge horizontal distance between columns. */
const COL_GAP = 200;
/** Top-edge to top-edge vertical distance between rows within a column. */
const ROW_GAP = 80;
const CANVAS_PAD = 16;

type AgentNodeData = {
  id: string;
  label: string;
  spanCount: number;
  totalMs: number;
  /** Zero-based column (x tier). */
  col: number;
  /** Zero-based row within the column. */
  row: number;
};

type AgentEdgeData = {
  from: string;
  to: string;
  /** Number of handoff spans on this edge. */
  count: number;
};

type AgentGraph = {
  nodes: AgentNodeData[];
  edges: AgentEdgeData[];
  svgWidth: number;
  svgHeight: number;
  /** Top-left x for a given column. */
  colX: (col: number) => number;
  /** Top-left y for a given node (centres column within canvas height). */
  nodeY: (node: AgentNodeData, maxRowsInAnyCol: number) => number;
};

/**
 * Derive agent nodes and handoff edges from the trace payload.
 *
 * Edge data source: `TranscriptStep` entries with `kind === "handoff"` carry
 * `attributes["a2a.parent_agent_id"]` and `attributes["a2a.child_agent_id"]`
 * as flat scalar keys (flattened by `_scalar_step_attrs` in portal.py from
 * the `attributes.a2a.*` sub-document the SDK writes).
 *
 * Returns null when fewer than 2 distinct agents are present.
 */
export function buildAgentGraph(trace: TraceFixture): AgentGraph | null {
  // --- Collect all distinct agent IDs ---
  const agentSet = new Set<string>();
  agentSet.add(trace.agentId);
  for (const id of trace.participants ?? []) agentSet.add(id);
  for (const s of trace.steps) if (s.agentId) agentSet.add(s.agentId);

  if (agentSet.size < 2) return null;

  // --- Per-agent span counts and durations ---
  const spanCount = new Map<string, number>();
  const totalMs = new Map<string, number>();
  for (const s of trace.steps) {
    const aid = s.agentId ?? trace.agentId;
    spanCount.set(aid, (spanCount.get(aid) ?? 0) + 1);
    totalMs.set(aid, (totalMs.get(aid) ?? 0) + s.durationMs);
  }

  // --- Build directed edges from handoff spans ---
  const edgeMap = new Map<string, number>(); // "from\x00to" => count
  for (const s of trace.steps) {
    if (s.kind !== "handoff") continue;
    const from = s.attributes?.["a2a.parent_agent_id"] as string | undefined;
    const to = s.attributes?.["a2a.child_agent_id"] as string | undefined;
    if (typeof from !== "string" || typeof to !== "string") continue;
    agentSet.add(from);
    agentSet.add(to);
    const key = `${from}\x00${to}`;
    edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
  }

  const edges: AgentEdgeData[] = [];
  for (const [key, count] of edgeMap) {
    const sep = key.indexOf("\x00");
    edges.push({ from: key.slice(0, sep), to: key.slice(sep + 1), count });
  }

  // --- Topological column assignment (BFS) ---
  const allIds = [...agentSet];

  const inDeg = new Map<string, number>(allIds.map((id) => [id, 0]));
  const outEdges = new Map<string, string[]>(allIds.map((id) => [id, []]));
  for (const e of edges) {
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    outEdges.get(e.from)?.push(e.to);
  }

  const col = new Map<string, number>();
  const queue: string[] = [];
  for (const id of allIds) {
    if ((inDeg.get(id) ?? 0) === 0) {
      col.set(id, 0);
      queue.push(id);
    }
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const c = col.get(cur) ?? 0;
    for (const next of outEdges.get(cur) ?? []) {
      col.set(next, Math.max(col.get(next) ?? 0, c + 1));
      queue.push(next);
    }
  }
  // Nodes unreachable in the BFS (isolated or in cycles) land in col 0.
  for (const id of allIds) if (!col.has(id)) col.set(id, 0);

  // --- Row assignment within each column (stable order: primary agent first) ---
  const colBuckets = new Map<number, string[]>();
  for (const id of allIds) {
    const c = col.get(id) ?? 0;
    const bucket = colBuckets.get(c) ?? [];
    bucket.push(id);
    colBuckets.set(c, bucket);
  }
  // Put trace.agentId first in its column so it anchors the root visually.
  for (const [, bucket] of colBuckets) {
    const rootIdx = bucket.indexOf(trace.agentId);
    if (rootIdx > 0) {
      bucket.splice(rootIdx, 1);
      bucket.unshift(trace.agentId);
    }
  }
  const rowInCol = new Map<string, number>();
  for (const [, bucket] of colBuckets) {
    bucket.forEach((id, i) => rowInCol.set(id, i));
  }

  const maxCol = Math.max(...allIds.map((id) => col.get(id) ?? 0));
  const maxRowsInAnyCol = Math.max(
    ...[...colBuckets.values()].map((b) => b.length),
  );

  const svgWidth = CANVAS_PAD + (maxCol + 1) * COL_GAP + NODE_W + CANVAS_PAD;
  const svgHeight =
    CANVAS_PAD + maxRowsInAnyCol * ROW_GAP + NODE_H + CANVAS_PAD;

  const colX = (c: number) => CANVAS_PAD + c * COL_GAP;
  const nodeY = (node: AgentNodeData, _max: number) => {
    const colSize = colBuckets.get(node.col)?.length ?? 1;
    // Centre this column's rows within the canvas height.
    const totalColH = (colSize - 1) * ROW_GAP + NODE_H;
    const startY = CANVAS_PAD + (svgHeight - 2 * CANVAS_PAD - totalColH) / 2;
    return startY + node.row * ROW_GAP;
  };

  const nodes: AgentNodeData[] = allIds.map((id) => ({
    id,
    label: agentById(id)?.name ?? id,
    spanCount: spanCount.get(id) ?? 0,
    totalMs: totalMs.get(id) ?? 0,
    col: col.get(id) ?? 0,
    row: rowInCol.get(id) ?? 0,
  }));

  return { nodes, edges, svgWidth, svgHeight, colX, nodeY };
}

/**
 * Renders a layered SVG graph of agent nodes and handoff edges.
 *
 * Shown only when the trace has ≥ 2 distinct agents. For single-agent
 * traces the component returns null so callers can hide the tab entirely.
 */
export function AgentsPanel({ trace }: { trace: TraceFixture }) {
  const graph = useMemo(() => buildAgentGraph(trace), [trace]);
  if (!graph) return null;

  const { nodes, edges, svgWidth, svgHeight, colX, nodeY } = graph;
  const MARKER_ID = "agent-graph-arrow";

  const getNode = (id: string) => nodes.find((n) => n.id === id);

  return (
    <div className="flex min-h-0 h-full flex-col gap-0">
      <div className="shrink-0 flex items-center gap-2 border-b border-[var(--line)] px-4 py-2 sm:px-5">
        <p className="type-label text-[var(--text-secondary)]">
          {nodes.length} agents · {edges.length} handoff
          {edges.length !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <svg
          width={svgWidth}
          height={svgHeight}
          aria-label="Agent interaction graph"
          role="img"
        >
          <defs>
            <marker
              id={MARKER_ID}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path
                d="M 0 0 L 8 4 L 0 8 z"
                style={{ fill: "var(--text-muted)" }}
              />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((e) => {
            const src = getNode(e.from);
            const tgt = getNode(e.to);
            if (!src || !tgt) return null;
            const sx = colX(src.col) + NODE_W;
            const sy = nodeY(src, 0) + NODE_H / 2;
            const tx = colX(tgt.col);
            const ty = nodeY(tgt, 0) + NODE_H / 2;
            const cx1 = sx + Math.max(30, (tx - sx) * 0.4);
            const cy1 = sy;
            const cx2 = tx - Math.max(30, (tx - sx) * 0.4);
            const cy2 = ty;
            return (
              <g key={`${e.from}→${e.to}`} data-testid="agent-edge">
                <path
                  d={`M ${sx} ${sy} C ${cx1} ${cy1} ${cx2} ${cy2} ${tx} ${ty}`}
                  fill="none"
                  style={{
                    stroke: "var(--line-strong, var(--text-muted))",
                    strokeWidth: 1.5,
                  }}
                  markerEnd={`url(#${MARKER_ID})`}
                />
                {e.count > 1 && (
                  <text
                    x={(sx + tx) / 2}
                    y={(sy + ty) / 2 - 6}
                    textAnchor="middle"
                    style={{
                      fill: "var(--text-secondary)",
                      fontSize: "0.6875rem",
                    }}
                  >
                    ×{e.count}
                  </text>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const x = colX(node.col);
            const y = nodeY(node, 0);
            const color = agentLaneColor(node.id);
            const shortLabel =
              node.label.length > 18
                ? `${node.label.slice(0, 16)}…`
                : node.label;
            return (
              <g key={node.id} data-testid="agent-node" data-agent-id={node.id}>
                {/* Node box */}
                <rect
                  x={x}
                  y={y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  style={{
                    fill: color ? `${color}1a` : "var(--bg-muted)",
                    stroke: color ?? "var(--line)",
                    strokeWidth: 1.5,
                  }}
                />
                {/* Agent label */}
                <text
                  x={x + NODE_W / 2}
                  y={y + 22}
                  textAnchor="middle"
                  style={{
                    fill: "var(--text)",
                    fontSize: "0.8125rem",
                    fontWeight: 500,
                  }}
                  data-testid={`agent-node-label-${node.id}`}
                >
                  {shortLabel}
                </text>
                {/* Span count + duration */}
                <text
                  x={x + NODE_W / 2}
                  y={y + 40}
                  textAnchor="middle"
                  style={{
                    fill: "var(--text-secondary)",
                    fontSize: "0.6875rem",
                  }}
                >
                  {node.spanCount > 0
                    ? `${node.spanCount} span${node.spanCount !== 1 ? "s" : ""} · ${formatDuration(node.totalMs)}`
                    : "no spans"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
