"use client";

/**
 * FEAT-115 — inline annotate dialog for the trace detail action bar.
 * Calls ``api.annotateTrace`` (find-or-seed trace-score item + annotate).
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/api/resources";
import { useLabToast } from "@/lab/lab-toast";

const CATEGORIES = [
  "quality",
  "correctness",
  "safety",
  "latency",
  "cost",
  "other",
] as const;

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function AnnotateTraceDialog({
  open,
  onClose,
  orgId,
  traceId,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string;
  traceId: string;
}) {
  const { pushToast } = useLabToast();
  const [score, setScore] = useState(7);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("quality");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLFormElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const startedAtRef = useRef(Date.now());

  if (open && !wasOpenRef.current) {
    previouslyFocused.current =
      (document.activeElement as HTMLElement | null) ?? null;
    startedAtRef.current = Date.now();
  }
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open) return;
    setScore(7);
    setCategory("quality");
    setComment("");
    setError(null);
    setSubmitting(false);
    startedAtRef.current = Date.now();
  }, [open, traceId]);

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

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!category.trim()) {
      setError("Pick a category.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.annotateTrace(orgId, traceId, {
        score,
        category,
        comment: comment.trim() || undefined,
        time_spent_ms: Math.max(0, Date.now() - startedAtRef.current),
      });
      pushToast({
        title: "Annotation saved",
        body: `Score ${score}/10 · ${category}`,
        tone: "ok",
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save annotation.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-stretch justify-center bg-[var(--scrim)] p-3 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="annotate-trace-title"
      onClick={onClose}
    >
      <form
        ref={dialogRef}
        onSubmit={(e) => void submit(e)}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[var(--bg)] shadow-[0_0_0_1px_var(--line)] sm:h-auto sm:max-h-[min(32rem,92dvh)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--line)] px-6 py-5">
          <div className="min-w-0">
            <h2
              id="annotate-trace-title"
              className="type-title text-[var(--text)] !text-[1.25rem]"
            >
              Annotate
            </h2>
            <p className="type-meta mt-1 text-[var(--text-faint)]">
              Score this run for the labeling queue
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

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <label className="block space-y-1.5">
            <span className="type-label">Score (0–10)</span>
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={score}
              onChange={(e) => setScore(Number(e.target.value))}
              className="w-full accent-[var(--accent)]"
              aria-valuetext={`${score} of 10`}
            />
            <span className="type-ui text-[var(--text)]">{score}</span>
          </label>

          <label className="block space-y-1.5">
            <span className="type-label">Category</span>
            <select
              className="ds-input w-full"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as (typeof CATEGORIES)[number])
              }
              autoFocus
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1.5">
            <span className="type-label">Comment (optional)</span>
            <textarea
              className="ds-input min-h-[5rem] w-full resize-y !h-auto px-3 py-2"
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setError(null);
              }}
              placeholder="What stood out?"
            />
          </label>

          {error ? (
            <p className="type-meta text-[var(--error)]" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--line)] px-6 py-4">
          <button
            type="button"
            className="ds-btn ds-btn-ghost ds-btn-sm"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="ds-btn ds-btn-primary ds-btn-sm"
            disabled={submitting}
          >
            {submitting ? "Saving…" : "Save annotation"}
          </button>
        </footer>
      </form>
    </div>
  );
}
