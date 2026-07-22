"use client";

import { useTranslations } from "next-intl";
import type { TranscriptRow } from "@/lib/observability/types";
import { TranscriptStepRow } from "./transcript-step-row";

type Props = {
  rows: TranscriptRow[];
  selectedSpanId?: string;
  onSelectSpan?: (spanId: string) => void;
};

export function TranscriptCanvas({
  rows,
  selectedSpanId,
  onSelectSpan,
}: Props) {
  const t = useTranslations("traces.transcript");

  if (rows.length === 0) {
    return (
      <p
        className="px-3 py-6 text-sm text-[var(--text-muted)]"
        data-testid="transcript-canvas-empty"
      >
        {t("empty")}
      </p>
    );
  }

  return (
    <div data-testid="transcript-canvas" data-mode="transcript">
      {rows.map((row) => (
        <TranscriptStepRow
          key={row.span_id}
          row={row}
          selected={row.span_id === selectedSpanId}
          onSelect={onSelectSpan}
        />
      ))}
    </div>
  );
}
