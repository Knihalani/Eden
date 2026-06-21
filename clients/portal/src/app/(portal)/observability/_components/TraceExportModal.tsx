"use client";

/**
 * TraceExportModal — extracted from the old observability/page.tsx
 * monolith (June 2026). Shows a JSON / JSONL / CSV preview and a
 * download button. Used by /traces and (still) /observability.
 */

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Download, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

type ExportFormat = "json" | "jsonl" | "csv";

const FORMATS: ExportFormat[] = ["jsonl", "json", "csv"];

interface TraceExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  traceId: string;
}

export function TraceExportModal({ open, onOpenChange, orgId, traceId }: TraceExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>("jsonl");
  const [data, setData] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    if (!open || !orgId || !traceId) return;
    setLoading(true);
    setError("");
    api
      .exportTrace(orgId, traceId, format)
      .then((res) => setData(res.data))
      .catch((err) => setError(err instanceof Error ? err.message : "Export failed"))
      .finally(() => setLoading(false));
  }, [open, orgId, traceId, format]);

  // Escape closes the modal; lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpenChange]);

  function handleDownload() {
    const mime =
      format === "csv"
        ? "text/csv"
        : format === "json"
        ? "application/json"
        : "application/jsonlines+json";
    const blob = new Blob([data], { type: mime });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trace_export_${traceId || "export"}.${format === "jsonl" ? "jsonl" : format}`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-[var(--overlay)] z-50 flex items-center justify-center p-4"
          onClick={() => onOpenChange(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Export trace"
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-xl max-w-2xl w-full max-h-[80vh] overflow-hidden shadow-xl flex flex-col"
          >
            <div className="flex items-center justify-between p-4 border-b border-[var(--border-default)]">
              <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
                <Download className="w-4 h-4 text-[var(--accent)]" />
                Export Trace
              </h3>
              <button
                onClick={() => onOpenChange(false)}
                className="p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--accent)] rounded"
                aria-label="Close export dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4 overflow-auto flex-1">
              <div className="flex items-center gap-2">
                {FORMATS.map((fmt) => (
                  <button
                    key={fmt}
                    onClick={() => setFormat(fmt)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-medium transition-colors",
                      format === fmt
                        ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                        : "bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    )}
                  >
                    {fmt.toUpperCase()}
                  </button>
                ))}
                <button
                  onClick={handleDownload}
                  disabled={loading || !!error || !data}
                  className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-lg text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </button>
              </div>
              {error ? (
                <div className="text-sm text-[var(--error)] bg-[var(--error-bg)] p-3 rounded-lg">
                  {error}
                </div>
              ) : (
                <pre className="text-xs bg-[var(--bg-secondary)] rounded-lg p-3 overflow-x-auto max-h-[50vh]">
                  {loading ? "Loading…" : data.slice(0, 5000)}
                  {!loading && data.length > 5000 && "\n\n... (truncated)"}
                </pre>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
