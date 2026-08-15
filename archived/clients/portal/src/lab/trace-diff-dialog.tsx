"use client";

/**
 * Wave 9 — compare the selected run against any other run in the org.
 *
 * Calls ``portalApi.traceDiff`` (``POST /orgs/{org}/observability/traces/diff``),
 * which aligns the two event streams by span id in O(n+m) and returns
 * per-step kinds (same / changed / added / removed) plus aggregate deltas
 * (cost, duration, span count, failures, tokens). Pure read — no writes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, GitCompareArrows, X } from "lucide-react";
import { portalApi, type TraceDiffResult } from "@/lib/api/portal";
import { useLabToastSafe } from "@/lab/lab-toast";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type KindFilter = "all" | "same" | "changed" | "only_a" | "only_b";

const KIND_LABEL: Record<KindFilter, string> = {
  all: "All",
  same: "Same",
  changed: "Changed",
  only_a: "Removed",
  only_b: "Added",
};

function fmtUsd(v: number | null | undefined): string {
  if (!v) return "$0.00";
  const abs = Math.abs(v);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return `$${v.toFixed(digits)}`;
}

function fmtMs(v: number | null | undefined): string {
  if (!v) return "0ms";
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${v.toFixed(v < 10 ? 1 : 0)}ms`;
}

/** Signed delta chip; negative = improvement (accent), positive = muted. */
function Delta({ value, unit }: { value: number; unit: "usd" | "ms" | "num" | "tok" }) {
  if (value === 0) {
    return <span className="type-meta tabular-nums">±0</span>;
  }
  // Delta owns the sign: fmtUsd/fmtMs format the absolute magnitude so a
  // negative delta renders "−$0.004" not "−$−0.004".
  const sign = value > 0 ? "+" : "−";
  const body =
    unit === "usd"
      ? fmtUsd(Math.abs(value))
      : unit === "ms"
        ? fmtMs(Math.abs(value))
        : `${Math.abs(value).toLocaleString()}`;
  return (
    <span
      className={cn(
        "type-ui tabular-nums",
        value < 0 ? "text-[var(--accent)]" : "text-[var(--text-muted)]",
      )}
    >
      {sign}
      {body}
    </span>
  );
}

const KIND_CHIP: Record<
  string,
  { cls: string; label: string }
> = {
  same: {
    cls: "bg-[var(--bg-inset)] text-[var(--text-muted)]",
    label: "Same",
  },
  changed: {
    cls: "bg-[var(--accent-muted)] text-[var(--accent)]",
    label: "Changed",
  },
  only_a: {
    cls: "bg-[var(--error-muted)] text-[var(--error)]",
    label: "Removed",
  },
  only_b: {
    cls: "bg-[var(--accent-muted)] text-[var(--text)]",
    label: "Added",
  },
};

export function TraceDiffDialog({
  open,
  onClose,
  orgId,
  traceId,
  traceName,
  candidates,
  prefillTraceId,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string;
  traceId: string;
  traceName?: string;
  candidates?: { id: string; name: string }[];
  /** Wave 10 — pre-select the "other run" (e.g. compare-to-previous). */
  prefillTraceId?: string | null;
}) {
  const { pushToast } = useLabToastSafe();

  const others = useMemo(
    () => (candidates ?? []).filter((c) => c.id !== traceId),
    [candidates, traceId],
  );

  const [otherId, setOtherId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TraceDiffResult | null>(null);
  const [filter, setFilter] = useState<KindFilter>("all");
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const lastTraceIdRef = useRef<string | null>(null);

  if (open && !wasOpenRef.current) {
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
  }
  wasOpenRef.current = open;

  // Reset ONLY on the open transition or a traceId change. `wasOpenRef`
  // tracks open *across renders* so a close→open of the same trace resets,
  // but a parent re-render while open does not. `others` is deliberately
  // NOT a reset trigger: the parent re-creates `candidates` on every
  // render, so depending on it would wipe `result` (and the rendered diff)
  // on every parent re-render while the dialog is open. It stays in the
  // dependency list so the closure reads a fresh candidate list when the
  // open-transition reset fires.
  useEffect(() => {
    if (!open) {
      lastTraceIdRef.current = null;
      return;
    }
    // wasOpenRef.current is already `true` here (set during render above),
    // so `firstOpen` would always read false; the real signal that this is
    // a fresh open is lastTraceIdRef being nulled on the close branch.
    const traceChanged = lastTraceIdRef.current !== traceId;
    lastTraceIdRef.current = traceId;
    if (!traceChanged) return;
    setOtherId((prev) => {
      // One-click compare-to-previous: the caller's explicit pick wins.
      if (prefillTraceId && prefillTraceId !== traceId) return prefillTraceId;
      const stillExists = others.some((c) => c.id === prev);
      return stillExists ? prev : (others[0]?.id ?? "");
    });
    setLoading(false);
    setError(null);
    setResult(null);
    setFilter("all");
  }, [open, traceId, others, prefillTraceId]);

  useEffect(() => {
    if (!open) return;
    return () => {
      previouslyFocused.current?.focus?.({ preventScroll: true });
      previouslyFocused.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const nodes = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialogRef.current.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const steps = useMemo(() => {
    if (!result) return [];
    if (filter === "all") return result.steps;
    return result.steps.filter((s) => s.kind === filter);
  }, [result, filter]);

  if (!open) return null;

  async function compare() {
    if (!otherId.trim() || otherId.trim() === traceId) {
      setError("Pick a different run to compare against.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await portalApi.traceDiff(orgId, traceId, otherId.trim());
      setResult(res);
      setFilter("all");
      pushToast?.({
        title: "Diff ready",
        body: `${res.counts.changed} changed · ${res.counts.added} added · ${res.counts.removed} removed`,
        tone: "ok",
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not compare traces.";
      setError(msg);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  const counts = result?.counts ?? {
    same: 0,
    changed: 0,
    added: 0,
    removed: 0,
  };

  const KIND_TO_COUNT: Record<Exclude<KindFilter, "all">, keyof typeof counts> = {
    same: "same",
    changed: "changed",
    only_a: "removed",
    only_b: "added",
  };

  const countFor = (kind: KindFilter): number =>
    kind === "all"
      ? result?.steps.length ?? 0
      : counts[KIND_TO_COUNT[kind]] ?? 0;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center bg-[var(--scrim)] p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trace-diff-title"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)] sm:h-auto sm:max-h-[min(44rem,92dvh)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-6 py-5">
          <div className="min-w-0">
            <h2
              id="trace-diff-title"
              className="type-title text-[var(--text)] !text-[1.25rem]"
            >
              Compare runs
            </h2>
            <p className="type-meta mt-1 truncate text-[var(--text-faint)]">
              {traceName ? `${traceName} · ` : ""}
              <span className="type-mono">{traceId}</span>
            </p>
          </div>
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-icon shrink-0"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {/* Pick the other run */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 basis-64 space-y-1.5">
              <span className="type-label">Other run</span>
              <input
                className="ds-input w-full"
                list="trace-diff-candidates"
                value={otherId}
                onChange={(e) => {
                  setOtherId(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void compare();
                }}
                placeholder="Paste a trace id or pick from the feed…"
                autoFocus
                aria-label="Other run id"
              />
              <datalist id="trace-diff-candidates">
                {others.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </datalist>
            </label>
            <button
              type="button"
              className="ds-btn ds-btn-primary ds-btn-sm"
              disabled={loading || !otherId.trim() || otherId.trim() === traceId}
              onClick={() => void compare()}
            >
              {loading ? "Diffing…" : "Compare"}
              {!loading ? (
                <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />
              ) : null}
            </button>
          </div>

          {error ? (
            <p className="type-meta mt-3 text-[var(--error)]" role="alert">
              {error}
            </p>
          ) : null}

          {result ? (
            <div className="mt-5 space-y-4">
              {/* Aggregate delta cards */}
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  {
                    label: "Cost",
                    a: fmtUsd(result.trace_a.cost_usd),
                    b: fmtUsd(result.trace_b.cost_usd),
                    delta: (
                      <Delta value={result.totals.cost_delta_usd} unit="usd" />
                    ),
                  },
                  {
                    label: "Duration",
                    a: fmtMs(result.trace_a.duration_ms),
                    b: fmtMs(result.trace_b.duration_ms),
                    delta: (
                      <Delta
                        value={result.totals.duration_delta_ms}
                        unit="ms"
                      />
                    ),
                  },
                  {
                    label: "Spans",
                    a: String(result.trace_a.span_count),
                    b: String(result.trace_b.span_count),
                    delta: (
                      <Delta value={result.totals.span_count_delta} unit="num" />
                    ),
                  },
                  {
                    label: "Failures",
                    a: String(result.trace_a.failures),
                    b: String(result.trace_b.failures),
                    delta: (
                      <Delta value={result.totals.failures_b - result.totals.failures_a} unit="num" />
                    ),
                  },
                  {
                    label: "Tokens",
                    a: result.trace_a.input_tokens +
                      result.trace_a.output_tokens,
                    b: result.trace_b.input_tokens +
                      result.trace_b.output_tokens,
                    delta: (
                      <Delta value={result.totals.token_delta} unit="tok" />
                    ),
                  },
                  {
                    label: "Matched spans",
                    a: String(result.trace_a.span_count),
                    b: String(result.shared.matched_spans),
                    delta: <span className="type-meta tabular-nums">aligned</span>,
                  },
                ].map((card) => (
                  <div
                    key={card.label}
                    className="flex items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--bg-inset)] px-3 py-2"
                  >
                    <span className="type-label">{card.label}</span>
                    <span className="flex items-center gap-2 type-ui tabular-nums text-[var(--text-muted)]">
                      <span>{card.a}</span>
                      <ArrowRight className="h-3 w-3 opacity-50" aria-hidden />
                      <span className="text-[var(--text)]">{card.b}</span>
                      <span className="ml-1">{card.delta}</span>
                    </span>
                  </div>
                ))}
              </div>

              {/* Kind filter chips */}
              <div
                className="flex flex-wrap items-center gap-1"
                role="group"
                aria-label="Filter diff steps"
              >
                {(["all", "same", "changed", "only_b", "only_a"] as const).map(
                  (kind) => (
                    <button
                      key={kind}
                      type="button"
                      className={cn(
                        "ds-btn ds-btn-sm",
                        filter === kind
                          ? "ds-btn-primary"
                          : "ds-btn-ghost",
                      )}
                      onClick={() => setFilter(kind)}
                      aria-pressed={filter === kind}
                    >
                      {KIND_LABEL[kind]} · {countFor(kind)}
                    </button>
                  ),
                )}
              </div>

              {/* Step list */}
              {steps.length === 0 ? (
                <p className="type-meta text-[var(--text-faint)]">
                  No steps match this filter.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--line)] overflow-hidden rounded-[var(--radius)] border border-[var(--line)]">
                  {steps.map((step) => {
                    const chip = KIND_CHIP[step.kind];
                    const name = step.name_b ?? step.name_a ?? step.span_id;
                    const outcomeA = step.outcome_a;
                    const outcomeB = step.outcome_b;
                    const outcomeDiffers =
                      step.kind === "changed" &&
                      outcomeA !== outcomeB;
                    return (
                      <li
                        key={step.index}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                      >
                        <span
                          className={cn(
                            "type-ui shrink-0 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[0.68rem] uppercase tracking-wide",
                            chip.cls,
                          )}
                        >
                          {chip.label}
                        </span>
                        <span className="type-ui min-w-0 flex-1 truncate text-[var(--text)]">
                          {name}
                          <span className="type-mono ml-2 text-[var(--text-faint)]">
                            {step.span_id}
                          </span>
                        </span>
                        {step.kind === "changed" ? (
                          <span className="flex items-center gap-1 type-meta">
                            <span className="text-[var(--text-muted)]">
                              {outcomeA ?? "—"}
                            </span>
                            <ArrowRight className="h-3 w-3 opacity-50" aria-hidden />
                            <span
                              className={cn(
                                outcomeDiffers &&
                                  (outcomeB === "error" ||
                                    outcomeB === "failure")
                                  ? "text-[var(--error)]"
                                  : "text-[var(--text)]",
                              )}
                            >
                              {outcomeB ?? "—"}
                            </span>
                          </span>
                        ) : null}
                        <span className="type-meta tabular-nums text-[var(--text-faint)]">
                          {fmtMs(step.duration_ms_a)} → {fmtMs(step.duration_ms_b)}
                        </span>
                        <span className="type-meta tabular-nums text-[var(--text-faint)]">
                          {fmtUsd(step.cost_usd_a)} → {fmtUsd(step.cost_usd_b)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              <p className="type-meta text-right text-[var(--text-faint)]">
                aligned {result.steps.length} steps in {result.took_ms}ms ·
                pure read
              </p>
            </div>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-6 py-4">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
