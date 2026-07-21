/** Shared session-turn I/O preview helpers (hub expand + session page). */

const PREVIEW_MAX = 120;

export type SessionTracePreviewRow = {
  trace_id: string;
  duration_ms?: number | null;
  cost_cents?: number | null;
  outcome?: string | null;
  realm?: string | null;
  input_text?: string | null;
  output_text?: string | null;
  input?: string | null;
  output?: string | null;
  preview?: string | null;
  name?: string | null;
  error?: string | null;
};

export function truncateTurnPreview(
  text: string | null | undefined,
  max = PREVIEW_MAX,
): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

/** Prefer list I/O fields; fall back to preview/name/realm. */
export function turnInputPreview(t: SessionTracePreviewRow): string | undefined {
  return (
    truncateTurnPreview(t.input_text) ??
    truncateTurnPreview(t.input) ??
    truncateTurnPreview(t.preview) ??
    truncateTurnPreview(t.name) ??
    (t.realm ? `${t.realm} run` : undefined) ??
    undefined
  );
}

/** Prefer list output; fall back to error string. */
export function turnOutputPreview(t: SessionTracePreviewRow): string | undefined {
  return (
    truncateTurnPreview(t.output_text) ??
    truncateTurnPreview(t.output) ??
    truncateTurnPreview(t.error) ??
    undefined
  );
}

export function buildSessionTurns(
  traceIds: string[],
  rows: SessionTracePreviewRow[],
) {
  const byId = new Map(rows.map((t) => [t.trace_id, t]));
  return traceIds.map((tid, i) => {
    const t = byId.get(tid);
    const input = t ? turnInputPreview(t) : undefined;
    const output = t ? turnOutputPreview(t) : undefined;
    return {
      trace_id: tid,
      summary: input ?? (t?.realm ? `${t.realm} run` : undefined),
      input_preview: input,
      output_preview: output,
      duration_ms: t?.duration_ms ?? undefined,
      cost_cents: t?.cost_cents ?? null,
      outcome: t?.outcome ?? null,
      had_stumble: t?.outcome === "failure" || t?.outcome === "crash",
      sort_index: i,
    };
  });
}
