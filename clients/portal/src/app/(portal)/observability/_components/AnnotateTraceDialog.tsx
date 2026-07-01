"use client";

/**
 * AnnotateTraceDialog — Pattern 5.2 (Langfuse) annotate button.
 *
 * Opens a small dialog with:
 *   • Score slider (0–10, default 7)
 *   • Category dropdown (Quality / Latency / Cost / Correctness)
 *   • Comment textarea (optional)
 *
 * On Save: calls api.annotateTrace(...) (no-op for now, see the
 * matching endpoint in src/lib/api.ts) and toasts success. The
 * dialog can be opened from any row action in the TracesTab table.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useOrg } from "@/hooks/use-org";
import { api } from "@/lib/api";

const CATEGORIES = ["Quality", "Latency", "Cost", "Correctness"] as const;
type Category = (typeof CATEGORIES)[number];

interface AnnotateTraceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  traceId: string;
  /** Pre-fill the dialog from a row's existing annotation (Phase 2). */
  initial?: { score?: number; category?: Category; comment?: string };
}

export function AnnotateTraceDialog({
  open,
  onOpenChange,
  traceId,
  initial,
}: AnnotateTraceDialogProps) {
  const toast = useToast();
  const { currentOrg } = useOrg();
  const [score, setScore] = useState<number>(initial?.score ?? 7);
  const [category, setCategory] = useState<Category>(initial?.category ?? "Quality");
  const [comment, setComment] = useState<string>(initial?.comment ?? "");
  const [saving, setSaving] = useState(false);

  // Reset state whenever the dialog is reopened (so back-to-back
  // annotations on different traces don't leak fields).
  useEffect(() => {
    if (open) {
      setScore(initial?.score ?? 7);
      setCategory(initial?.category ?? "Quality");
      setComment(initial?.comment ?? "");
    }
  }, [open, initial]);

  const handleSave = async () => {
    if (!currentOrg) {
      toast.error("No active organisation");
      return;
    }
    setSaving(true);
    try {
      await api.annotateTrace(currentOrg.id, traceId, {
        score,
        category,
        comment: comment.trim() || undefined,
      });
      toast.success("Annotation saved");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save annotation");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Annotate trace</DialogTitle>
          <DialogDescription>
            Score and tag this trace for later review. Annotations are
            private to your org and persisted against trace ID{" "}
            <span className="font-mono text-[var(--text-secondary)]">
              {traceId.slice(0, 12)}…
            </span>
            .
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Score slider */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="annotate-score"
                className="text-xs font-medium text-[var(--text-secondary)]"
              >
                Score
              </label>
              <span className="text-sm font-mono font-semibold text-[var(--text-primary)] tabular-nums">
                {score} / 10
              </span>
            </div>
            <input
              id="annotate-score"
              type="range"
              min={0}
              max={10}
              step={1}
              value={score}
              onChange={(e) => setScore(Number(e.target.value))}
              className="w-full accent-[var(--accent)]"
            />
          </div>

          {/* Category dropdown */}
          <div className="space-y-1.5">
            <label
              htmlFor="annotate-category"
              className="text-xs font-medium text-[var(--text-secondary)]"
            >
              Category
            </label>
            <select
              id="annotate-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)]"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {/* Comment textarea */}
          <div className="space-y-1.5">
            <label
              htmlFor="annotate-comment"
              className="text-xs font-medium text-[var(--text-secondary)]"
            >
              Comment (optional)
            </label>
            <textarea
              id="annotate-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="What did you notice about this trace?"
              rows={3}
              className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 focus:border-[var(--accent)] resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save annotation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
