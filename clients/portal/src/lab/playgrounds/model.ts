/**
 * Client-side view of the playground `config` JSONB (F49 data model).
 *
 * The backend stores config as free-form JSON; the portal owns this
 * schema. Parsing is tolerant so records written by other producers
 * (`POST /playgrounds/from-span` stores `messages` / `model` at the
 * top level) still open as a usable Base task.
 */

export type PlaygroundMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type PlaygroundTask = {
  id: string;
  label: string;
  model: string;
  temperature: number;
  maxTokens: number;
  messages: PlaygroundMessage[];
};

export type PlaygroundRowInput = {
  input: string;
  expected?: string;
};

export type PlaygroundRunSummary = {
  runId: string | null;
  at: string;
  costUsd: number | null;
  cells: number;
  errors: number;
};

export type PlaygroundConfigView = {
  tasks: PlaygroundTask[];
  rows: PlaygroundRowInput[];
  datasetId: string | null;
  runs: PlaygroundRunSummary[];
};

export const DEFAULT_MODEL = "gpt-4o-mini";

let taskSeq = 0;
export function newTaskId(): string {
  taskSeq += 1;
  return `task_${Date.now().toString(36)}_${taskSeq}`;
}

export function defaultTask(label = "Base"): PlaygroundTask {
  return {
    id: newTaskId(),
    label,
    model: DEFAULT_MODEL,
    temperature: 0,
    maxTokens: 1024,
    messages: [
      { role: "system", content: "" },
      { role: "user", content: "{{input}}" },
    ],
  };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parseMessages(v: unknown): PlaygroundMessage[] {
  if (!Array.isArray(v)) return [];
  const out: PlaygroundMessage[] = [];
  for (const m of v) {
    if (!m || typeof m !== "object") continue;
    const rec = m as Record<string, unknown>;
    const role = rec.role;
    out.push({
      role: role === "system" || role === "assistant" ? role : "user",
      content:
        typeof rec.content === "string"
          ? rec.content
          : rec.content != null
            ? JSON.stringify(rec.content)
            : "",
    });
  }
  return out;
}

function parseTask(v: unknown, index: number): PlaygroundTask | null {
  if (!v || typeof v !== "object") return null;
  const rec = v as Record<string, unknown>;
  const messages = parseMessages(rec.messages);
  return {
    id: str(rec.id, `task_${index}`),
    label: str(rec.label, index === 0 ? "Base" : `Task ${index + 1}`),
    model: str(rec.model, DEFAULT_MODEL),
    temperature: num(rec.temperature, 0),
    maxTokens: num(rec.max_tokens ?? rec.maxTokens, 1024),
    messages: messages.length > 0 ? messages : defaultTask().messages,
  };
}

/** Tolerant parse of a persisted playground `config`. */
export function parsePlaygroundConfig(
  config: Record<string, unknown> | null | undefined,
): PlaygroundConfigView {
  const cfg = config ?? {};
  let tasks = Array.isArray(cfg.tasks)
    ? cfg.tasks
        .map((t, i) => parseTask(t, i))
        .filter((t): t is PlaygroundTask => t !== null)
    : [];
  if (tasks.length === 0) {
    // from-span records store span payload at the top level.
    const spanMessages = parseMessages(cfg.messages);
    const base = defaultTask();
    if (spanMessages.length > 0) base.messages = spanMessages;
    else if (typeof cfg.prompt === "string" && cfg.prompt) {
      base.messages = [
        { role: "system", content: "" },
        { role: "user", content: cfg.prompt },
      ];
    }
    if (typeof cfg.model === "string" && cfg.model) base.model = cfg.model;
    tasks = [base];
  }

  const rows: PlaygroundRowInput[] = Array.isArray(cfg.rows)
    ? cfg.rows
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
        .map((r) => ({
          input:
            typeof r.input === "string"
              ? r.input
              : r.input != null
                ? JSON.stringify(r.input)
                : "",
          expected: typeof r.expected === "string" ? r.expected : undefined,
        }))
    : [];

  const runs: PlaygroundRunSummary[] = Array.isArray(cfg.runs)
    ? cfg.runs
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object")
        .map((r) => ({
          runId: typeof r.run_id === "string" ? r.run_id : null,
          at: str(r.at),
          costUsd: typeof r.cost_usd === "number" ? r.cost_usd : null,
          cells: num(r.cells, 0),
          errors: num(r.errors, 0),
        }))
    : [];

  return {
    tasks,
    rows: rows.length > 0 ? rows : [{ input: "", expected: undefined }],
    datasetId: typeof cfg.dataset_id === "string" ? cfg.dataset_id : null,
    runs,
  };
}

/**
 * Serialize the editor state back into `config`, preserving unknown
 * top-level keys the portal does not own (scorers, span provenance…).
 */
export function serializePlaygroundConfig(
  view: PlaygroundConfigView,
  existing?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    tasks: view.tasks.map((t) => ({
      id: t.id,
      label: t.label,
      model: t.model,
      temperature: t.temperature,
      max_tokens: t.maxTokens,
      messages: t.messages,
    })),
    rows: view.rows.map((r) => ({ input: r.input, expected: r.expected })),
    dataset_id: view.datasetId ?? undefined,
    runs: view.runs.map((r) => ({
      run_id: r.runId,
      at: r.at,
      cost_usd: r.costUsd,
      cells: r.cells,
      errors: r.errors,
    })),
  };
}

/** Model summary for list rows — unique models across tasks. */
export function modelSummary(config: Record<string, unknown> | null | undefined): string {
  const { tasks } = parsePlaygroundConfig(config);
  const models = [...new Set(tasks.map((t) => t.model).filter(Boolean))];
  return models.join(" · ") || DEFAULT_MODEL;
}

/** Cost of the most recent run, if the record carries one. */
export function lastRunCost(
  config: Record<string, unknown> | null | undefined,
): number | null {
  const { runs } = parsePlaygroundConfig(config);
  return runs.length > 0 ? runs[runs.length - 1].costUsd : null;
}
