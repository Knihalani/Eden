/**
 * Pure helpers for the playground run SSE stream (U03/F49).
 *
 * The backend emits per-cell events over `POST /playgrounds/{id}/run/stream`:
 *
 *   {type:"start"}
 *   {type:"cell", task_id, row_index, status, output?, score?, latency_ms?, cost_usd?, error?}
 *   {type:"done", run_id, totals}
 *
 * Everything here is dependency-free and side-effect-free so it can be
 * unit-tested without a DOM or network: an incremental `data:` line
 * parser plus a reducer that folds events into a cell matrix keyed by
 * `${task_id}:${row_index}`.
 */

export type PlaygroundCellEvent = {
  type: "cell";
  task_id: string;
  row_index: number;
  status: string;
  output?: string | null;
  score?: number | null;
  latency_ms?: number | null;
  cost_usd?: number | null;
  error?: string | null;
};

export type PlaygroundStreamEvent =
  | { type: "start" }
  | PlaygroundCellEvent
  | {
      type: "done";
      run_id?: string | null;
      totals?: Record<string, unknown> | null;
    };

/**
 * Incremental SSE parser. Feed raw text chunks (already utf-8 decoded);
 * get back fully-parsed JSON events. Handles events split across
 * chunks, multi-line `data:` fields, CRLF, comment lines (`:`), and
 * ignores non-JSON / sentinel payloads like `[DONE]`.
 */
export function createSseParser() {
  let buffer = "";

  const parseEventBlock = (block: string): PlaygroundStreamEvent | null => {
    const dataLines: string[] = [];
    for (const rawLine of block.split("\n")) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        // Spec: a single optional space after the colon is stripped.
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
      // Other fields (event:, id:, retry:) are irrelevant here — the
      // backend types events inside the JSON payload.
    }
    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n").trim();
    if (!payload || payload === "[DONE]") return null;
    try {
      const parsed = JSON.parse(payload) as { type?: unknown };
      if (!parsed || typeof parsed !== "object") return null;
      if (
        parsed.type === "start" ||
        parsed.type === "cell" ||
        parsed.type === "done"
      ) {
        return parsed as PlaygroundStreamEvent;
      }
      return null;
    } catch {
      return null;
    }
  };

  return {
    /** Parse a chunk; returns any events completed by this chunk. */
    feed(chunk: string): PlaygroundStreamEvent[] {
      buffer += chunk;
      const events: PlaygroundStreamEvent[] = [];
      // Event boundary = blank line (\n\n, tolerate \r\n\r\n).
      let boundary: number;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const sep = buffer.slice(boundary).match(/^\r?\n\r?\n/)![0];
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + sep.length);
        const event = parseEventBlock(block);
        if (event) events.push(event);
      }
      return events;
    },
    /** Flush any trailing block that never got a closing blank line. */
    flush(): PlaygroundStreamEvent[] {
      const rest = buffer;
      buffer = "";
      if (!rest.trim()) return [];
      const event = parseEventBlock(rest);
      return event ? [event] : [];
    },
  };
}

export type PlaygroundCellState = {
  status: "pending" | "running" | "done" | "error";
  output: string;
  score: number | null;
  latencyMs: number | null;
  costUsd: number | null;
  error: string | null;
};

export type PlaygroundRunState = {
  phase: "idle" | "streaming" | "done" | "error";
  runId: string | null;
  totals: Record<string, unknown> | null;
  /** Keyed by `cellKey(taskId, rowIndex)`. */
  cells: Record<string, PlaygroundCellState>;
};

export function cellKey(taskId: string, rowIndex: number): string {
  return `${taskId}:${rowIndex}`;
}

export function initialRunState(): PlaygroundRunState {
  return { phase: "idle", runId: null, totals: null, cells: {} };
}

const EMPTY_CELL: PlaygroundCellState = {
  status: "pending",
  output: "",
  score: null,
  latencyMs: null,
  costUsd: null,
  error: null,
};

function normalizeStatus(status: string): PlaygroundCellState["status"] {
  if (status === "done" || status === "completed" || status === "success") {
    return "done";
  }
  if (status === "error" || status === "failed") return "error";
  if (status === "running" || status === "streaming") return "running";
  return "pending";
}

/**
 * Fold one stream event into run state. Pure — returns a new object,
 * never mutates. Cell events with `status:"running"` append/replace
 * output progressively; terminal statuses finalize score/latency/cost.
 */
export function reduceRunEvent(
  state: PlaygroundRunState,
  event: PlaygroundStreamEvent,
): PlaygroundRunState {
  switch (event.type) {
    case "start":
      return { ...state, phase: "streaming" };
    case "cell": {
      const key = cellKey(event.task_id, event.row_index);
      const prev = state.cells[key] ?? EMPTY_CELL;
      const status = normalizeStatus(event.status);
      const next: PlaygroundCellState = {
        status,
        // Progressive fill: a running event may carry partial output;
        // absent output keeps what we have.
        output: typeof event.output === "string" ? event.output : prev.output,
        score: event.score ?? prev.score,
        latencyMs: event.latency_ms ?? prev.latencyMs,
        costUsd: event.cost_usd ?? prev.costUsd,
        error: event.error ?? (status === "error" ? prev.error : null),
      };
      return { ...state, cells: { ...state.cells, [key]: next } };
    }
    case "done":
      return {
        ...state,
        phase: "done",
        runId: event.run_id ?? state.runId,
        totals: event.totals ?? state.totals,
      };
    default:
      return state;
  }
}
