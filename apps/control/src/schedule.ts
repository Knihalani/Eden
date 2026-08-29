/**
 * Operator-scheduled compiled runs (Wave 15.2).
 *
 * GitHub Actions analogue: a human writes the cron; nothing schedules itself;
 * disabled ≡ paused never fires. Wrap also runs a minute clock (`EDEN_SCHEDULE_CLOCK=0`
 * restores POST /v1/schedule/tick only). Receipts are wrap-run receipts.
 */
import { hashStretch, liveTimeSavedMs, type IslandCaller, type ToolRegistry } from "@eden/ir";
import { isDeopt, isReplaySafe, runProgram, type RunStats } from "@eden/runtime";
import { cacheHitSpread } from "@eden/wrap";
import type { LiveTool, Store, StoredSchedule } from "./store";

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type CronField = { all: boolean; values: Set<number> };

export type CronExpr = {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
};

export type LiveRunResult =
  | { status: "ok"; value: unknown; stats: RunStats }
  | { status: "deopt"; reason: string; early: boolean; stepsRun: number; program: string }
  | { status: "error"; error: string };

function parseToken(raw: string, min: number, max: number, names?: string[]): number | null {
  const s = raw.trim().toLowerCase();
  if (names) {
    const i = names.indexOf(s);
    if (i >= 0) {
      const n = names === MONTH_NAMES ? i + 1 : i;
      if (n < min || n > max) return null;
      return n;
    }
  }
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function parseField(raw: string, min: number, max: number, names?: string[]): CronField | null {
  const text = raw.trim();
  if (!text) return null;
  const values = new Set<number>();
  let all = text === "*" || text.startsWith("*/");
  for (const part of text.split(",")) {
    if (!part) return null;
    let body = part;
    let step = 1;
    const slash = part.indexOf("/");
    if (slash >= 0) {
      body = part.slice(0, slash);
      const stepRaw = part.slice(slash + 1);
      if (!/^\d+$/.test(stepRaw)) return null;
      step = Number(stepRaw);
      if (!Number.isInteger(step) || step <= 0) return null;
    }
    if (body === "*") {
      all = all && slash < 0;
      for (let n = min; n <= max; n += step) values.add(n);
      continue;
    }
    const dash = body.indexOf("-");
    if (dash >= 0) {
      const a = parseToken(body.slice(0, dash), min, max, names);
      const b = parseToken(body.slice(dash + 1), min, max, names);
      if (a == null || b == null || a > b) return null;
      for (let n = a; n <= b; n += step) {
        if (n >= min && n <= max) values.add(n);
      }
      continue;
    }
    const n = parseToken(body, min, max, names);
    if (n == null) return null;
    if (slash >= 0) {
      for (let v = n; v <= max; v += step) values.add(v);
    } else {
      values.add(n);
    }
  }
  if (!values.size) return null;
  return { all, values };
}

/** POSIX 5-field cron. Null = refuse (no row, no fire). */
export function parseCron(expr: string): CronExpr | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseField(fields[0]!, 0, 59);
  const hour = parseField(fields[1]!, 0, 23);
  const dom = parseField(fields[2]!, 1, 31);
  const month = parseField(fields[3]!, 1, 12, MONTH_NAMES);
  const dow = parseField(fields[4]!, 0, 7, DOW_NAMES);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow };
}

function dowMatches(field: CronField, dow: number): boolean {
  return field.values.has(dow) || (dow === 0 && field.values.has(7));
}

/** UTC match. Vixie: both DOM and DOW restricted → either may match. */
export function cronMatches(expr: string, now: Date): boolean {
  const parsed = parseCron(expr);
  if (!parsed) return false;
  if (!parsed.minute.values.has(now.getUTCMinutes())) return false;
  if (!parsed.hour.values.has(now.getUTCHours())) return false;
  if (!parsed.month.values.has(now.getUTCMonth() + 1)) return false;
  const dom = now.getUTCDate();
  const dow = now.getUTCDay();
  if (parsed.dom.all && parsed.dow.all) return true;
  if (parsed.dom.all) return dowMatches(parsed.dow, dow);
  if (parsed.dow.all) return parsed.dom.values.has(dom);
  return parsed.dom.values.has(dom) || dowMatches(parsed.dow, dow);
}

/** One UTC minute. Same window → at most one fire. */
export function tickWindow(now: Date): string {
  return String(Math.floor(now.getTime() / 60_000));
}

export function parseNow(raw: unknown): Date | null {
  if (raw == null) return new Date();
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    if (/^\d+(\.\d+)?$/.test(t)) {
      const d = new Date(Number(t));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(t);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function toolMayFire(
  tool: LiveTool | undefined,
): { ok: true; tool: LiveTool } | { ok: false; reason: "paused" | "not live" | "not found" } {
  if (!tool) return { ok: false, reason: "not found" };
  if (tool.state === "paused") return { ok: false, reason: "paused" };
  if (tool.state !== "live") return { ok: false, reason: "not live" };
  return { ok: true, tool };
}

export function dueSchedules(rows: StoredSchedule[], now: Date): StoredSchedule[] {
  return rows.filter((row) => cronMatches(row.cron, now));
}

function wrapRunUsagePayload(stats: RunStats): Record<string, unknown> {
  const extra = stats as RunStats & {
    cached_tokens?: number;
    cache_write_tokens?: number;
    cache_input_tokens?: number;
  };
  const cached = extra.cached_tokens ?? extra.islandCachedTokens ?? 0;
  const write = extra.cache_write_tokens ?? extra.islandCacheWriteTokens ?? 0;
  const denom = extra.cache_input_tokens ?? extra.islandCacheInputTokens ?? 0;
  const cache = cacheHitSpread(cached, write, denom);
  if (!Object.keys(cache).length) return {};
  return {
    ...(Number.isFinite(extra.islandPromptTokens) ? { prompt_tokens: extra.islandPromptTokens } : {}),
    ...(Number.isFinite(extra.islandCompletionTokens) ? { completion_tokens: extra.islandCompletionTokens } : {}),
    ...cache,
  };
}

/**
 * Same putReceipt columns as POST /v1/wrap-run. Optional `source` lives only
 * in payload JSON so Home still classes on ms / llm_calls / cents / ok.
 */
export async function executeLiveRun(opts: {
  store: Store;
  tool: LiveTool;
  input?: Record<string, unknown>;
  registry: ToolRegistry;
  island?: IslandCaller;
  timeoutMs: number;
  source?: "schedule";
}): Promise<LiveRunResult> {
  const live = opts.tool;
  try {
    const run = await runProgram(live.program, opts.input ?? {}, {
      registry: opts.registry,
      island: opts.island,
      timeoutMs: opts.timeoutMs,
    });
    opts.store.putReceipt({
      tool_id: live.id,
      version: live.version,
      ms: run.stats.ms,
      llm_calls: run.stats.llmCalls,
      cents: run.stats.cents,
      ok: 1,
      payload: JSON.stringify({
        outcome: "ok",
        stepsRun: run.stats.stepsRun,
        early: false,
        skipped: run.stats.skipped,
        fingerprint: hashStretch(live.program),
        timeSavedMs: liveTimeSavedMs(live.program, run.stats.ms, true),
        ...(opts.input ? { input: opts.input } : {}),
        ...wrapRunUsagePayload(run.stats),
        ...(opts.source ? { source: opts.source } : {}),
      }),
    });
    return { status: "ok", value: run.value, stats: run.stats };
  } catch (err) {
    if (isDeopt(err)) {
      opts.store.putReceipt({
        tool_id: live.id,
        version: live.version,
        ms: err.ms,
        llm_calls: err.llmCalls,
        cents: err.cents,
        ok: 0,
        payload: JSON.stringify({
          outcome: "deopt",
          deoptReason: err.reason,
          early: isReplaySafe(err),
          stepsRun: err.stepsRun,
          fingerprint: hashStretch(live.program),
          ...(opts.source ? { source: opts.source } : {}),
        }),
      });
      return {
        status: "deopt",
        reason: err.reason,
        early: isReplaySafe(err),
        stepsRun: err.stepsRun,
        program: live.name,
      };
    }
    return { status: "error", error: String(err) };
  }
}

/** Fire due rows. Caller owns enqueue / org gate. Paused never executes. */
export async function tickDueSchedules(
  ctx: {
    store: Store;
    registry: ToolRegistry;
    island?: IslandCaller;
    timeoutMs: number;
    now: Date;
    toolId?: string;
    onOk?: (toolId: string) => void;
    onDeopt?: (toolId: string) => void;
  },
): Promise<{ fired: number; paused: number; skipped: number }> {
  const window = tickWindow(ctx.now);
  const rows = ctx.toolId
    ? [ctx.store.scheduleFor(ctx.toolId)].filter((r): r is NonNullable<typeof r> => Boolean(r))
    : ctx.store.schedules();
  const due = dueSchedules(rows, ctx.now);
  let fired = 0;
  let paused = 0;
  let skipped = 0;
  for (const row of due) {
    const gate = toolMayFire(ctx.store.tool(row.tool_id));
    if (!gate.ok) {
      if (gate.reason === "paused") paused++;
      else skipped++;
      continue;
    }
    if (!ctx.store.claimScheduleTick(row.tool_id, window)) {
      skipped++;
      continue;
    }
    const ran = await executeLiveRun({
      store: ctx.store,
      tool: gate.tool,
      input: parseScheduleInput(row.input),
      registry: ctx.registry,
      island: ctx.island,
      timeoutMs: ctx.timeoutMs,
      source: "schedule",
    });
    if (ran.status === "ok") {
      ctx.onOk?.(gate.tool.id);
      fired++;
    } else if (ran.status === "deopt") {
      ctx.onDeopt?.(gate.tool.id);
      fired++;
    } else {
      skipped++;
    }
  }
  return { fired, paused, skipped };
}

export function parseScheduleInput(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (raw == null || raw === "") return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* stored input is operator JSON; garbage does not fire a second language */
  }
  return undefined;
}
