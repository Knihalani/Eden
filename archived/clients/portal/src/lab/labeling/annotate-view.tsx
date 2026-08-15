"use client";

import { useEffect } from "react";
import Link from "next/link";
import { StatusChip } from "@/components/ds/primitives";
import { LabelSchemaForm } from "@/lab/labeling/label-schema-form";
import { extractLabelOptions } from "@/lab/labeling/label-schema";
import type { LabelingItem } from "@/lib/api/labeling";

/**
 * Shift+1..5 → confidence tiers (0.2–1.0 in equal steps).
 * Keyed by ``KeyboardEvent.code`` (DigitN) so US layouts where
 * Shift+1 yields ``key === "!"`` still work.
 */
const CONFIDENCE_BY_CODE: Record<string, number> = {
  Digit1: 0.2,
  Digit2: 0.4,
  Digit3: 0.6,
  Digit4: 0.8,
  Digit5: 1.0,
};

function formatSessionAvgSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatAnnotateSessionStats(
  labeled: number,
  avgSeconds: number,
): string {
  if (labeled === 0) return "0 labeled this session";
  return `${labeled} labeled this session · avg ${formatSessionAvgSeconds(avgSeconds)}s/item`;
}

/**
 * Keyboard-driven annotator work surface (FEAT-83). Shortcuts:
 *
 *   1-9      select label option N (only meaningful for option-shaped
 *            schemas — see `extractLabelOptions`)
 *   Shift+1-5 set confidence tier (0.2, 0.4, … 1.0)
 *   s        skip the current item
 *   Enter    submit the current annotation
 *   u / Backspace  undo the last submission (re-UPSERT previous label)
 *
 * Shortcuts are suppressed while focus is inside the notes textarea
 * so annotators can type freely (including literal digits and
 * newlines via Enter) without accidentally submitting or skipping.
 */
export function formatItemDisagreementHint(
  annotationsCount: number,
  agreement: number | null | undefined,
): string | null {
  if (annotationsCount < 1) return null;
  const countLabel = `${annotationsCount} annotation${annotationsCount === 1 ? "" : "s"}`;
  if (agreement != null) {
    return `${countLabel} · agreement ${agreement.toFixed(2)} so far`;
  }
  return `${countLabel} so far`;
}

export function AnnotateView({
  item,
  queueLabel,
  label,
  onLabelChange,
  confidence,
  onConfidenceChange,
  notes,
  onNotesChange,
  onSubmit,
  onSkip,
  onUndo,
  submitting,
  skipping,
  undoing = false,
  canUndo = false,
  remaining,
  sessionLabeled,
  sessionAvgSeconds,
  annotationsCount = 0,
  agreementSoFar,
}: {
  item: LabelingItem;
  queueLabel?: string | null;
  label: unknown;
  onLabelChange: (value: unknown) => void;
  confidence: number;
  onConfidenceChange: (value: number) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  onUndo?: () => void;
  submitting: boolean;
  skipping: boolean;
  undoing?: boolean;
  canUndo?: boolean;
  remaining: number;
  sessionLabeled?: number;
  sessionAvgSeconds?: number;
  annotationsCount?: number;
  agreementSoFar?: number | null;
}) {
  useEffect(() => {
    const options = extractLabelOptions(item.label_schema);

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inNotes = target?.tagName === "TEXTAREA" && target?.dataset.labelingNotes === "1";
      if (inNotes) return; // let the annotator type freely, incl. digits/Enter for newlines

      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit();
        return;
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        onSkip();
        return;
      }
      if ((e.key === "u" || e.key === "U" || e.key === "Backspace") && canUndo && onUndo) {
        e.preventDefault();
        onUndo();
        return;
      }
      if (e.shiftKey && e.code in CONFIDENCE_BY_CODE) {
        e.preventDefault();
        onConfidenceChange(CONFIDENCE_BY_CODE[e.code]!);
        return;
      }
      if (/^[1-9]$/.test(e.key) && !e.shiftKey && options) {
        const idx = Number(e.key) - 1;
        const opt = options[idx];
        if (opt) {
          e.preventDefault();
          onLabelChange(opt.value);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    item.label_schema,
    onSubmit,
    onSkip,
    onUndo,
    onLabelChange,
    onConfidenceChange,
    canUndo,
  ]);

  const disagreementHint = formatItemDisagreementHint(annotationsCount, agreementSoFar);
  const disagreementTone =
    agreementSoFar != null && agreementSoFar < 0.5 ? "fail" : "neutral";

  const traceHref = item.source_trace_id
    ? `/traces?id=${encodeURIComponent(item.source_trace_id)}${
        item.source_span_id ? `&span=${encodeURIComponent(item.source_span_id)}` : ""
      }`
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {queueLabel ? <StatusChip tone="neutral">{queueLabel}</StatusChip> : null}
          {item.tags.map((t) => (
            <StatusChip key={t} tone="neutral">
              {t}
            </StatusChip>
          ))}
          {traceHref ? (
            <Link href={traceHref} className="type-meta underline underline-offset-2">
              View source trace →
            </Link>
          ) : null}
          {disagreementHint ? (
            <StatusChip tone={disagreementTone}>{disagreementHint}</StatusChip>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-0.5">
          {sessionLabeled !== undefined ? (
            <span className="type-meta">
              {formatAnnotateSessionStats(sessionLabeled, sessionAvgSeconds ?? 0)}
            </span>
          ) : null}
          <span className="type-meta">{remaining} remaining in this lease</span>
        </div>
      </div>

      <section className="ds-panel-muted mt-4 p-4">
        <h3 className="type-ui text-[var(--text-secondary)]">Prompt</h3>
        {item.prompt ? (
          <p className="type-body mt-2 whitespace-pre-wrap break-words">{item.prompt}</p>
        ) : (
          <pre className="type-body mt-2 overflow-x-auto whitespace-pre-wrap break-words">
            {JSON.stringify(item.payload, null, 2)}
          </pre>
        )}
      </section>

      <section className="mt-5 space-y-2">
        <h3 className="type-ui text-[var(--text-secondary)]">
          Label <span className="type-meta">(press 1-9)</span>
        </h3>
        <LabelSchemaForm schema={item.label_schema} value={label} onChange={onLabelChange} />
      </section>

      <section className="mt-5 space-y-2">
        <h3 className="type-ui text-[var(--text-secondary)]">
          Confidence <span className="type-meta">(Shift+1–5)</span>
        </h3>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={confidence}
            onChange={(e) => onConfidenceChange(Number(e.target.value))}
            aria-label="Confidence"
            className="h-2 flex-1 cursor-pointer accent-[var(--accent)]"
          />
          <span className="type-ui w-12 text-right tabular-nums text-[var(--text)]">
            {Math.round(confidence * 100)}%
          </span>
        </div>
      </section>

      <section className="mt-5 space-y-2">
        <h3 className="type-ui text-[var(--text-secondary)]">Notes</h3>
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="Optional notes…"
          rows={3}
          data-labeling-notes="1"
          className="ds-input w-full resize-y"
        />
      </section>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          className="ds-btn ds-btn-primary"
          disabled={submitting}
          onClick={onSubmit}
        >
          Submit <span className="type-meta ml-1.5 opacity-70">Enter</span>
        </button>
        <button
          type="button"
          className="ds-btn ds-btn-secondary"
          disabled={skipping}
          onClick={onSkip}
        >
          Skip <span className="type-meta ml-1.5 opacity-70">S</span>
        </button>
        {canUndo && onUndo ? (
          <button
            type="button"
            className="ds-btn ds-btn-outline"
            disabled={undoing}
            onClick={onUndo}
          >
            Undo <span className="type-meta ml-1.5 opacity-70">U</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
