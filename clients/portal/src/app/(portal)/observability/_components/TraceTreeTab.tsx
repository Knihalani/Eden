"use client";

/**
 * TraceTreeTab — extracted from observability/page.tsx (June 2026).
 * Renders a recursive span tree for a single trace.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, TreePine, ArrowRight, Activity } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import type { TraceTreeData } from "../_lib/types";

export function TraceTreeTab({
  traceTree,
  selectedTraceId,
  onBack,
}: {
  traceTree: TraceTreeData | null;
  selectedTraceId: string;
  onBack: () => void;
}) {
  if (!traceTree) {
    return (
      <div className="text-center py-16 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl">
        <TreePine className="w-12 h-12 mx-auto mb-3 text-[var(--text-muted)] opacity-40" />
        <p className="text-sm text-[var(--text-muted)]">Select a trace to view its tree</p>
        <button
          onClick={onBack}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] transition-colors"
        >
          <ArrowRight className="w-4 h-4" />
          Go to Traces
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <TreePine className="w-4 h-4 text-[var(--accent)]" />
            Trace Tree
          </h3>
          <p className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{selectedTraceId}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-xs text-[var(--text-muted)]">{traceTree.span_count} spans</p>
            <p className="text-xs text-[var(--text-muted)]">
              {traceTree.total_duration_ms.toFixed(0)}ms total
            </p>
          </div>
          <button
            onClick={onBack}
            className="px-3 py-1.5 bg-[var(--bg-tertiary)] text-[var(--text-primary)] rounded-lg text-xs font-medium hover:bg-[var(--border-default)] transition-colors"
          >
            Back
          </button>
        </div>
      </div>

      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-4 overflow-x-auto">
        <div className="space-y-1 min-w-[400px]">
          {traceTree.root_spans.map((span, idx) => (
            <SpanNode key={idx} span={span} depth={0} />
          ))}
          {traceTree.root_spans.length === 0 && (
            <EmptyState
              icon={Activity}
              title="No spans in trace tree"
              description="This trace has no recorded spans — the agent may not have started yet."
              size="sm"
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SpanNode({ span, depth }: { span: Record<string, unknown>; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const children = (span.children as Array<Record<string, unknown>>) || [];
  const hasChildren = children.length > 0;
  const name = (span.name as string) || (span.event_type as string) || "unknown";
  const duration = (span.duration_ms as number) || 0;
  const outcome = span.outcome as string | null;

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
        style={{ paddingLeft: `${depth * 24 + 8}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        ) : (
          <div className="w-4" />
        )}
        <span
          className={cn(
            "w-2 h-2 rounded-full flex-shrink-0",
            outcome === "success" && "bg-[var(--terminal)]",
            outcome === "failure" && "bg-[var(--error)]",
            outcome === "partial" && "bg-[var(--warning)]",
            outcome !== "success" &&
              outcome !== "failure" &&
              outcome !== "partial" &&
              "bg-[var(--text-muted)]"
          )}
        />
        <span className="text-sm text-[var(--text-primary)] font-medium truncate">{name}</span>
        <span className="text-xs text-[var(--text-muted)] ml-auto flex-shrink-0">
          {duration.toFixed(1)}ms
        </span>
      </div>
      <AnimatePresence>
        {expanded && hasChildren && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
          >
            {children.map((child, idx) => (
              <SpanNode key={idx} span={child} depth={depth + 1} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
