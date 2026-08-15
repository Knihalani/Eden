/**
 * Browser-side consumer for the playground run SSE endpoint.
 *
 * POSTs to `/orgs/{org}/playgrounds/{id}/run/stream` through `fetchApi`
 * in raw+stream mode (shared Clerk auth attach, 401 refresh, handshake
 * 429 retry — no 30s timeout) and folds `data:` lines into typed events
 * via the pure parser in run-stream.ts. Callers catch errors and fall
 * back to `playgroundApi.runPersisted` (non-streaming).
 */

import { fetchApi } from "@/lib/api/core";
import {
  createSseParser,
  type PlaygroundStreamEvent,
} from "@/lab/playgrounds/run-stream";

export class RunStreamError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "RunStreamError";
    this.status = status;
  }
}

/**
 * Stream a run, invoking `onEvent` per parsed event. Resolves when the
 * stream ends (whether or not a `done` event arrived — the caller
 * decides if a missing `done` means fallback). Rejects with
 * `RunStreamError` on non-2xx or missing body, and re-throws abort
 * errors so Stop isn't mistaken for failure.
 */
export async function streamPlaygroundRun(opts: {
  orgId: string;
  playgroundId: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  onEvent: (event: PlaygroundStreamEvent) => void;
}): Promise<void> {
  const { orgId, playgroundId, body, signal, onEvent } = opts;
  const res = await fetchApi<Response>(
    `/orgs/${orgId}/playgrounds/${playgroundId}/run/stream`,
    {
      method: "POST",
      headers: {
        "X-Org-Id": orgId,
        // stream:true skips the automatic JSON content type.
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body ?? {}),
      stream: true,
      raw: true,
      noDedup: true,
      signal,
    },
  );
  if (!res.ok) {
    throw new RunStreamError(`stream endpoint returned ${res.status}`, res.status);
  }
  if (!res.body) {
    throw new RunStreamError("stream endpoint returned no body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.feed(decoder.decode(value, { stream: true }))) {
        onEvent(event);
      }
    }
    const tail = decoder.decode();
    for (const event of [...parser.feed(tail), ...parser.flush()]) {
      onEvent(event);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Map a non-streaming `POST /run` payload into the same event stream
 * shape so the fallback path reuses the reducer. Tolerant of both
 * `results: [...]` and `results: { cells: [...] }` layouts.
 */
export function eventsFromPersistedRun(
  run: Record<string, unknown> | null | undefined,
): PlaygroundStreamEvent[] {
  const events: PlaygroundStreamEvent[] = [{ type: "start" }];
  const rec = run ?? {};
  const rawResults = rec.results;
  const cells: unknown[] = Array.isArray(rawResults)
    ? rawResults
    : rawResults && typeof rawResults === "object" &&
        Array.isArray((rawResults as Record<string, unknown>).cells)
      ? ((rawResults as Record<string, unknown>).cells as unknown[])
      : [];
  cells.forEach((cell, i) => {
    if (!cell || typeof cell !== "object") return;
    const c = cell as Record<string, unknown>;
    const error =
      typeof c.error === "string" && c.error.length > 0 ? c.error : null;
    events.push({
      type: "cell",
      task_id: String(c.task_id ?? c.template_name ?? "task_0"),
      row_index:
        typeof c.row_index === "number" && Number.isFinite(c.row_index)
          ? c.row_index
          : i,
      status: error ? "error" : String(c.status ?? "done"),
      output:
        typeof c.output === "string"
          ? c.output
          : typeof c.response === "string"
            ? c.response
            : undefined,
      score: typeof c.score === "number" ? c.score : null,
      latency_ms: typeof c.latency_ms === "number" ? c.latency_ms : null,
      cost_usd: typeof c.cost_usd === "number" ? c.cost_usd : null,
      error,
    });
  });
  events.push({
    type: "done",
    run_id: typeof rec.id === "string" ? rec.id : null,
    totals:
      rec.totals && typeof rec.totals === "object"
        ? (rec.totals as Record<string, unknown>)
        : rec.cost_usd != null
          ? { cost_usd: rec.cost_usd }
          : null,
  });
  return events;
}
