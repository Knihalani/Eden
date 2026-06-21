"use client";

/**
 * CompareTab — extracted from observability/page.tsx (June 2026).
 * Side-by-side comparison of two traces (env vs prod).
 */

import { GitCompare, ChevronRight, Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { SeverityBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import type { ComparativeData } from "../_lib/types";

export function CompareTab({
  envTraceId,
  prodTraceId,
  onEnvChange,
  onProdChange,
  onCompare,
  result,
  loading,
}: {
  envTraceId: string;
  prodTraceId: string;
  onEnvChange: (v: string) => void;
  onProdChange: (v: string) => void;
  onCompare: () => void;
  result: ComparativeData | null;
  loading: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4 flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-[var(--accent)]" />
          Compare Traces
        </h3>
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">
              Environment Trace ID
            </label>
            <input
              type="text"
              value={envTraceId}
              onChange={(e) => onEnvChange(e.target.value)}
              placeholder="Enter environment trace ID..."
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-[var(--text-muted)] mb-1.5 block">
              Production Trace ID
            </label>
            <input
              type="text"
              value={prodTraceId}
              onChange={(e) => onProdChange(e.target.value)}
              placeholder="Enter production trace ID..."
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        </div>
        <button
          onClick={onCompare}
          disabled={loading || !envTraceId || !prodTraceId}
          className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-sm font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitCompare className="w-4 h-4" />}
          Compare
        </button>
      </div>

      {result && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                Overall Similarity Score
              </h3>
              <span
                className={cn(
                  "text-2xl font-bold",
                  result.overall_score > 0.7
                    ? "text-[var(--terminal)]"
                    : result.overall_score > 0.4
                    ? "text-[var(--warning)]"
                    : "text-[var(--error)]"
                )}
              >
                {(result.overall_score * 100).toFixed(1)}%
              </span>
            </div>
            <div className="h-3 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  result.overall_score > 0.7
                    ? "bg-[var(--terminal)]"
                    : result.overall_score > 0.4
                    ? "bg-[var(--warning)]"
                    : "bg-[var(--error)]"
                )}
                style={{ width: `${result.overall_score * 100}%` }}
              />
            </div>
          </div>

          <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">
              Dimension Comparison
            </h3>
            <div className="space-y-3">
              {result.dimensions.map((dim) => (
                <div key={dim.name} className="p-3 rounded-lg bg-[var(--bg-secondary)]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium text-[var(--text-primary)] capitalize">
                      {dim.name.replace(/_/g, " ")}
                    </span>
                    <SeverityBadge severity={dim.severity} />
                  </div>
                  <div className="grid grid-cols-2 gap-4 mb-2">
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">
                        Environment
                      </p>
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {typeof dim.env_value === "number"
                          ? dim.env_value.toFixed(2)
                          : String(dim.env_value)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">
                        Production
                      </p>
                      <p className="text-sm font-medium text-[var(--text-primary)]">
                        {typeof dim.prod_value === "number"
                          ? dim.prod_value.toFixed(2)
                          : String(dim.prod_value)}
                      </p>
                    </div>
                  </div>
                  <div className="h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        dim.gap > 0.5
                          ? "bg-[var(--error)]"
                          : dim.gap > 0.2
                          ? "bg-[var(--warning)]"
                          : "bg-[var(--terminal)]"
                      )}
                      style={{ width: `${dim.gap * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-[var(--text-muted)] mt-1">{dim.explanation}</p>
                </div>
              ))}
            </div>
          </div>

          {result.recommendations.length > 0 && (
            <div className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl p-5">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">
                Recommendations
              </h3>
              <ul className="space-y-2">
                {result.recommendations.map((rec, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-sm text-[var(--text-primary)]"
                  >
                    <ChevronRight className="w-3.5 h-3.5 text-[var(--accent)] mt-0.5 flex-shrink-0" />
                    {rec}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}
