import type { IslandCaller, StretchProgram, ToolRegistry, TokenClass } from "@eden/ir";
import {
  addTokenClass,
  emptyTokenClasses,
  evidenceLedger,
  firstWarningIndex,
    isMutating,
  isReadName,
  judgeGrounding,
  mayServe,
  postWarningSpend,
  redact,
  eq,
  takeSignals,
  usableTrace,
  hashStretch,
  liveTimeSavedMs,
  protocolHeaders,
} from "@eden/ir";
import { DeoptError, isDeopt, isReplaySafe, registryFrom, runProgram, type RunStats } from "@eden/runtime";
import { MAX_RUN_STEPS } from "@eden/ir";
import { asToolDef, emptyRun, type EdenOpts, type Receipt, type RunRecorder, type ToolDef, type ToolsIn } from "./types";
import { filterCanary } from "./canary";
import { extractInput } from "./steer";
import type { StretchTrace, TraceEvent } from "@eden/ir";
import { cacheHitSpread, resetUsage } from "./usage";
import { decideGuard, enforcementEnabled, requiredChecks } from "./guard";
import {
  ARM_SLACK_CALLS,
  armExpired,
  createArmingStore,
  hintIdOf,
  restCounts,
  totalRest,
  wrapSessionId,
  type Armed,
  type ArmingStore,
  type FleetHit,
} from "./arming";
import { isProgramReadOnly, sharedAcrossLine, wrapAgentId, wrapFleetId, wrapRegion } from "./fleet";
import { createJitGuard, noteJitUsed, type JitGuard } from "./intent";
import {
  bindSpeculateRunner,
  discardSpeculation,
  markStretchServed,
  takeSpeculation,
  turnBoundary,
} from "./speculate";
import { bindWarmRunner, claimWarm, watchWarm, withWarmLookup } from "./warm";

const MAX_TRACES = 2000;
const PULL_EVERY = 24;
const MAX_OUTBOX = 64;
const MAX_POST_TRIES = 5;
const MAX_WARNINGS = 32;

/**
 * Executed-call ceiling for one wrap run (see ir MAX_RUN_STEPS rationale).
 * Counted on real executions only — steered skips do not spend, so they do
 * not consume the budget.
 */
export function maxRunSteps(): number {
  const env = Number(process.env.EDEN_MAX_STEPS);
  if (Number.isFinite(env) && env > 0) return Math.min(10_000, Math.max(10, Math.floor(env)));
  return MAX_RUN_STEPS;
}

/** Halt/block payload. `detail` only when decideGuard set it (budget copy, not fail_streak/warning/loop). */
function guardRefuse(guard: { action: string; reason: string; detail?: string }): {
  eden: "halted" | "blocked";
  reason: string;
  detail?: string;
} {
  return {
    eden: guard.action === "block" ? "blocked" : "halted",
    reason: guard.reason,
    ...(guard.detail ? { detail: guard.detail } : {}),
  };
}

export type WrapState = {
  opts: EdenOpts;
  programs: StretchProgram[];
  traces: StretchTrace[];
  receipts: Receipt[];
  pulls?: number;
  run: RunRecorder;
  pausedIds: Set<string>;
  /**
   * Receipts/traces the control-plane outbox had to throw away because it was
   * full (or a job exhausted its retries). Telemetry loss is not silent:
   * every trace emitted afterwards carries `dropped_posts`.
   */
  droppedPosts: number;
  /** Session-partitioned suppression store. Shared when `opts.arming` is set. */
  arming: ArmingStore;
  /** Hosted-dispatch session key. Empty string is the single-tenant bucket. */
  sessionId: string;
  /** Fleet key for read-only cross-agent claims. Empty = no sharing. */
  fleetId: string;
  /** Stable agent identity stamped on traces/receipts/events. */
  agentId: string;
  parentRunId?: string;
  spanId?: string;
  region?: string;
  /** Count of stretches that failed open because the session/global cap was full. */
  capacityMisses: number;
  /**
   * Entity ids written this session. Compiled/cache hits for a dirty id miss
   * and force execute so a sibling read cannot see a pre-write value.
   */
  dirtyEntities: Set<string>;
  /** When each dirty entity was last written (performance.now). */
  dirtyAt: Map<string, number>;
  /** JIT injection-rate bookkeeping for this wrap (one episode). */
  jit: JitGuard;
};

type OutboxJob = { path: string; body: unknown; tries: number };

const outboxes = new WeakMap<WrapState, OutboxJob[]>();
const flushers = new WeakMap<WrapState, ReturnType<typeof setTimeout>>();
/** Leader compiled receipt, so a follower can stamp `shared across N agents`. */
const armedReceipts = new WeakMap<Armed, Receipt>();

function stampIdentity(state: WrapState, receipt: Receipt): Receipt {
  if (state.agentId) receipt.agentId = state.agentId;
  if (state.parentRunId) receipt.parentRunId = state.parentRunId;
  if (state.fleetId) receipt.fleetId = state.fleetId;
  if (state.region) receipt.region = state.region;
  return receipt;
}

function markShared(armed: Armed, agentId: string): number {
  armed.agentIds ??= new Set();
  if (agentId) armed.agentIds.add(agentId);
  const n = armed.agentIds.size;
  if (n >= 2) {
    const line = sharedAcrossLine(n);
    const rec = armedReceipts.get(armed);
    if (rec) {
      rec.sharedAcross = n;
      if (!rec.reason?.includes(line)) rec.reason = rec.reason ? `${rec.reason} · ${line}` : line;
    }
  }
  return n;
}

function inputAgrees(armed: Armed, cur: Record<string, unknown>): boolean {
  if (eq(cur, armed.input)) return true;
  const rec = armed.input as Record<string, unknown> | null;
  if (!rec || typeof rec !== "object") return false;
  const keys = Object.keys(cur);
  return keys.length > 0 && keys.every((k) => k in rec && eq(cur[k], rec[k]));
}

function waitSettled(armed: Armed, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    armed.settled,
    new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs)),
  ]);
}

/**
 * Default compiled-run ceiling. Justified by `benchmarks/campaign/TIMEOUT.md`
 * (Wave 4.4): must exceed p99 of a healthy compiled stretch; 60s sits under
 * the 300s cap and matches ARM_TTL so settled armings and the run share a clock.
 */
export const DEFAULT_WRAP_TIMEOUT_MS = 60_000;

export function wrapTimeoutMs(explicit?: number): number {
  const env = Number(process.env.EDEN_TIMEOUT_MS);
  const raw = explicit && explicit > 0 ? explicit : Number.isFinite(env) && env > 0 ? env : DEFAULT_WRAP_TIMEOUT_MS;
  return Math.min(300_000, Math.max(1, raw));
}

export function createState(opts: EdenOpts = {}): WrapState {
  const sessionId = wrapSessionId(opts.sessionId);
  const fleetId = wrapFleetId(opts.fleetId);
  const agentId = wrapAgentId(opts.agentId, sessionId);
  const region = wrapRegion(opts.region);
  return {
    opts: { failOpen: true, ...opts },
    programs: [...(opts.programs ?? [])],
    traces: [],
    receipts: [],
    pulls: 0,
    run: emptyRun(),
    pausedIds: new Set(),
    droppedPosts: 0,
    arming: opts.arming ?? createArmingStore({ perSessionMax: opts.armMax, globalMax: opts.armGlobal }),
    sessionId,
    fleetId,
    agentId,
    ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
    ...(opts.spanId ? { spanId: opts.spanId } : {}),
    ...(region ? { region } : {}),
    capacityMisses: 0,
    dirtyEntities: new Set(),
    dirtyAt: new Map(),
    jit: createJitGuard(),
  };
}

function wrapAuth(state: WrapState): string | undefined {
  return state.opts.apiKey || process.env.EDEN_API_KEY || (process.env.EDEN_DEV === "1" ? "eden_dev" : undefined);
}

/**
 * May the caller re-run the raw sequence after this failure?
 *
 * Only when the compiled attempt provably issued no tool calls. This used to
 * match on the reason string, and "island X needs an island caller" was on the
 * safe list — but an island sits wherever it sat in the observed trace, which
 * is routinely after a write. With no island caller configured (the default
 * whenever OPENAI_API_KEY is unset) a program of
 * `[tool writeRecord, island draft, tool notify]` wrote the record, bailed at
 * the island, was declared "early", and the raw writeRecord then ran again.
 *
 * runProgram now reports what it actually did, so the guess is gone.
 */
function isEarlyDeopt(err: unknown): boolean {
  return isReplaySafe(err);
}

function outboxOf(state: WrapState): OutboxJob[] {
  let q = outboxes.get(state);
  if (!q) {
    q = [];
    outboxes.set(state, q);
  }
  return q;
}

export function pendingPosts(state: WrapState): number {
  return outboxOf(state).length;
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Bounded control-plane calls: a hung plane must cost telemetry, not requests. */
function controlTimeoutMs(): number {
  const env = Number(process.env.EDEN_CONTROL_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? Math.min(120_000, env) : 10_000;
}

async function sendPost(state: WrapState, path: string, body: unknown): Promise<boolean> {
  const base = state.opts.baseUrl;
  const key = wrapAuth(state);
  if (!base || !key) return true;
  const fn = state.opts.fetch ?? fetch;
  try {
    const r = await fn(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...protocolHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(controlTimeoutMs()),
    });
    return r.ok || !shouldRetryStatus(r.status);
  } catch {
    return false;
  }
}

function scheduleFlush(state: WrapState, delayMs: number): void {
  if (flushers.has(state)) return;
  const t = setTimeout(() => {
    flushers.delete(state);
    void flushOutbox(state);
  }, delayMs);
  t.unref?.();
  flushers.set(state, t);
}

export async function flushOutbox(state: WrapState): Promise<void> {
  const q = outboxOf(state);
  const job = q.shift();
  if (!job) return;
  const ok = await sendPost(state, job.path, job.body);
  if (!ok) {
    job.tries++;
    if (job.tries < MAX_POST_TRIES && q.length < MAX_OUTBOX) q.push(job);
    else state.droppedPosts++; // retries exhausted, or no room to wait — counted, not silent
    scheduleFlush(state, Math.min(30_000, 200 * 2 ** Math.min(job.tries, 8)));
  } else if (q.length) {
    scheduleFlush(state, 0);
  }
}

function post(state: WrapState, path: string, body: unknown): void {
  const base = state.opts.baseUrl;
  const key = wrapAuth(state);
  if (!base || !key) return;
  void sendPost(state, path, body).then((ok) => {
    if (ok) return;
    const q = outboxOf(state);
    if (q.length >= MAX_OUTBOX) {
      // The outbox is full and this receipt/trace is gone. Count it: the
      // dropped_posts field on the next emitted trace is the only record
      // that telemetry was lost here.
      state.droppedPosts++;
      return;
    }
    q.push({ path, body, tries: 0 });
    scheduleFlush(state, 50);
  });
}

export async function pullLive(state: WrapState): Promise<void> {
  const base = state.opts.baseUrl;
  const key = wrapAuth(state);
  if (!base || !key) return;
  const fn = state.opts.fetch ?? fetch;
  try {
    const r = await fn(`${base.replace(/\/$/, "")}/v1/tools`, {
      headers: { authorization: `Bearer ${key}`, ...protocolHeaders() },
      signal: AbortSignal.timeout(controlTimeoutMs()),
    });
    if (!r.ok) return;
    const j = (await r.json()) as {
      tools?: Array<{ program: StretchProgram; state: string; rollout?: "canary" | "live" }>;
    };
    const rows = j.tools ?? [];
    const pulled = rows
      .filter((t) => t.state === "live")
      .map((t) => {
        const rollout = t.rollout === "canary" || t.rollout === "live" ? t.rollout : undefined;
        return rollout ? { ...t.program, rollout } : t.program;
      });
    const known = new Set(rows.map((t) => t.program?.id).filter((id): id is string => typeof id === "string" && !!id));
    const localOnly = state.programs.filter((p) => p.manifest && !known.has(p.id));
    state.programs = [...pulled, ...localOnly];
    for (const t of rows) {
      const id = t.program?.id;
      if (typeof id !== "string" || !id) continue;
      if (t.state === "live") state.pausedIds.delete(id);
      else state.pausedIds.add(id);
    }
  } catch {
    /* fail-open */
  }
}

function compiledReceipt(
  program: StretchProgram,
  ok: boolean,
  stats: {
    ms: number;
    llmCalls: number;
    cents: number;
    skipped: string[];
    stepsRun?: number;
    early?: boolean;
    deoptReason?: string;
    islandPromptTokens?: number;
    islandCompletionTokens?: number;
    islandCachedTokens?: number;
    islandCacheWriteTokens?: number;
    islandCacheInputTokens?: number;
    islandMemoized?: boolean;
    islandUsageMeasured?: boolean;
  },
  err?: unknown,
): Receipt {
  const deopt = isDeopt(err);
  const early = deopt ? isReplaySafe(err) : Boolean(stats.early);
  const stepsRun = deopt ? err.stepsRun : (stats.stepsRun ?? stats.skipped.length);
  const timeSavedMs = liveTimeSavedMs(program, stats.ms, ok);
  let outcome: Receipt["outcome"] = ok ? "ok" : deopt ? "deopt" : "failed";
  if (!ok && stats.skipped.length) outcome = "skipped";
  const islandP = stats.islandPromptTokens ?? 0;
  const islandC = stats.islandCompletionTokens ?? 0;
  const islandTok = islandP + islandC;
  const memoized = stats.islandMemoized === true && islandTok === 0;
  const scraped = stats.islandUsageMeasured === true || stats.llmCalls === 0;
  const tokenClass: TokenClass = memoized ? "memoized" : "compiled";
  const receipt: Receipt = {
    toolId: program.id,
    version: program.version,
    ms: stats.ms,
    llmCalls: stats.llmCalls,
    cents: stats.cents,
    ok,
    early,
    stepsRun,
    skipped: stats.skipped,
    outcome,
    fingerprint: hashStretch(program),
  };
  if (deopt) receipt.deoptReason = err.reason;
  if (timeSavedMs != null) receipt.timeSavedMs = timeSavedMs;
  if (ok) {
    receipt.tokenClass = tokenClass;
    if (scraped) {
      const classes = emptyTokenClasses();
      addTokenClass(classes, tokenClass, islandTok);
      if ((stats.islandCachedTokens ?? 0) > 0) classes.providerCache = stats.islandCachedTokens;
      receipt.tokenClasses = classes;
      receipt.prompt_tokens = islandP;
      receipt.completion_tokens = islandC;
      Object.assign(
        receipt,
        cacheHitSpread(
          stats.islandCachedTokens ?? 0,
          stats.islandCacheWriteTokens ?? 0,
          stats.islandCacheInputTokens ?? 0,
        ),
      );
      receipt.certified = true;
    }
  }
  return receipt;
}

function remainderSkipReason(program: string, tool: string): string {
  return `Already served by ${program}. Do not re-run ${tool} — facts are in the last tool output or attached as context.`;
}

/** Stamp the successful compiled receipt so canvas reads remainder copy from the live path. */
function stampRemainderSkip(state: WrapState, armed: Armed, toolName: string): void {
  const last = [...state.receipts].reverse().find((r) => r.toolId === armed.programId && r.ok);
  if (!last) return;
  const prog = state.programs.find((p) => p.id === armed.programId);
  const programName = prog?.name?.trim() || "this routine";
  last.skipped = [...new Set([...(last.skipped ?? []), toolName])];
  last.reason = remainderSkipReason(programName, toolName);
  const n = armed.agentIds?.size ?? 0;
  if (n >= 2) {
    const line = sharedAcrossLine(n);
    last.sharedAcross = n;
    if (!last.reason.includes(line)) last.reason = `${last.reason} · ${line}`;
  }
  notifyHost(() => state.opts.onReceipt?.(last));
  post(state, "/v1/receipts", last);
}

function creditIslandRun(run: RunRecorder, stats: RunStats): void {
  if (stats.islandUsageMeasured) {
    const first = !run.island_measured;
    run.island_prompt_tokens += stats.islandPromptTokens;
    run.island_completion_tokens += stats.islandCompletionTokens;
    run.island_cached_tokens += stats.islandCachedTokens;
    run.island_cache_write_tokens += stats.islandCacheWriteTokens ?? 0;
    run.island_cache_input_tokens += stats.islandCacheInputTokens ?? 0;
    run.island_measured = true;
    run.island_memoized = first ? stats.islandMemoized : run.island_memoized && stats.islandMemoized;
  } else if (stats.llmCalls === 0) {
    run.island_measured = true;
  }
}

export async function runCompiled(
  state: WrapState,
  program: StretchProgram,
  input: Record<string, unknown>,
  tools: ToolsIn,
  registry?: ToolRegistry,
): Promise<unknown> {
  const t0 = performance.now();
  // Watch-time: overlap the next program's first-wave reads with this stretch.
  // Fail-open — a warm miss must never fail the current run. Distinct from
  // turnBoundary (whole next stretch during think).
  safely(() => watchWarm(state, program, { input }), null);
  safely(() => claimWarm(state, program, input), null);
  const island: IslandCaller =
    state.opts.island ??
    (async () => {
      throw new DeoptError("no island caller");
    });
  try {
    // Inside the try so an envelope miss still writes a deopt receipt (51).
    if (!mayServe(program, input)) throw new DeoptError("input not in witness envelope");
    const baseReg =
      registry ??
      registryFrom(Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, asToolDef(k, v).execute])));
    const result = await runProgram(program, input, {
      registry: withWarmLookup(state, program, input, baseReg),
      island,
      llmCents: state.opts.llmCents ?? 1,
      checkEnvelope: false,
      timeoutMs: wrapTimeoutMs(state.opts.timeoutMs),
    });
    const receipt = compiledReceipt(program, true, result.stats);
    stampIdentity(state, receipt);
    creditIslandRun(state.run, result.stats);
    pushCapped(state.receipts, receipt);
    notifyHost(() => state.opts.onReceipt?.(receipt));
    post(state, "/v1/receipts", receipt);
    markDirty(state, input, program.sequence);
    return result.value;
  } catch (err) {
    const elapsed = performance.now() - t0;
    const receipt = compiledReceipt(
      program,
      false,
      {
        ms: isDeopt(err) && err.ms > 0 ? err.ms : elapsed,
        llmCalls: isDeopt(err) ? err.llmCalls : 0,
        cents: isDeopt(err) ? err.cents : 0,
        skipped: [],
        stepsRun: isDeopt(err) ? err.stepsRun : 0,
        early: isDeopt(err) && isReplaySafe(err),
        deoptReason: isDeopt(err) ? err.reason : undefined,
      },
      err,
    );
    stampIdentity(state, receipt);
    // Capped on this path too. The success branch trimmed to MAX_TRACES and
    // this one did not, so a program that deopts on every call grew the array
    // without limit for the life of the process.
    pushCapped(state.receipts, receipt);
    notifyHost(() => state.opts.onReceipt?.(receipt));
    post(state, "/v1/receipts", receipt);
    throw err;
  }
}

/**
 * Append, keeping the buffer bounded.
 *
 * Trimming one element per push once the cap is reached moves the whole array
 * every time; dropping a batch amortises that to O(1) per push.
 */
function pushCapped<T>(buf: T[], item: T): void {
  buf.push(item);
  if (buf.length > MAX_TRACES + 256) buf.splice(0, buf.length - MAX_TRACES);
}

/**
 * Run a host callback without letting it fail the caller's tool call.
 *
 * onTrace, onWarning, and onReceipt are arbitrary code supplied by whoever
 * wrapped the tools. A throw in any of them used to propagate out of a tool
 * call that had already succeeded — and for onReceipt inside runCompiled, out
 * of one whose compiled program had already performed its writes, where
 * isDeopt says "not a deopt" and the error is rethrown. Host telemetry is not
 * allowed to decide whether the agent's tool worked.
 */
function notifyHost(fn: () => void): void {
  try {
    fn();
  } catch {
    /* the host's observer is the host's problem */
  }
}

/**
 * Which invocation pushed which event.
 *
 * `state.run` is one shared RunRecorder for every wrapped tool call in the
 * process. When a raw call and a compiled call overlap in time, a flush that
 * drained the whole buffer attributed the other call's events — sometimes its
 * results, sometimes its failures — to the wrong trace. Each pushed event now
 * carries the id of the invocation that produced it under this module-level
 * symbol, and emitTrace partitions on it.
 */
const INVOCATION = Symbol("eden.invocation");
type TaggedEvent = TraceEvent & { [INVOCATION]?: number };

/** Lifetime of one wrapped execute(). */
type Invocation = {
  startedAt: number;
  done: boolean;
  finishedAt: number;
};

/**
 * Flush the buffered events as a trace.
 *
 * With an `owner` (the invocation doing the flushing) the buffer is
 * partitioned: the trace takes the owner's own events plus events from
 * invocations that had already *finished before the owner began* — the
 * ordinary sequential case, where earlier calls are simply waiting to be
 * flushed. Events from invocations that overlap the owner stay buffered and
 * ride out with their own flush.
 *
 * Residual risk, accepted on purpose: warnings/seenSignals/usage/t0 remain
 * per-state rather than per-invocation, so two overlapping calls can still
 * share a warning budget or a duration window; and an event whose invocation
 * record has been evicted (see the bound below) is treated as long-finished
 * and claimed by the next flush. Partitioning events is the part that could
 * corrupt or lose attribution of results; the rest only skews telemetry.
 */
function emitTrace(
  state: WrapState,
  run: ReturnType<typeof emptyRun>,
  input?: Record<string, unknown>,
  owner?: { id: number; startedAt: number; invocations: Map<number, Invocation> },
): void {
  if (!run.events.length) return;
  let events = run.events;
  // Whether this pass actually consumed events. A partitioned pass that claims
  // nothing of its own must not touch the shared warning state: another
  // invocation is mid-flight and resetting its budget/window under it would
  // corrupt the trace it is still building.
  let consumed = true;
  try {
    if (owner) {
      const mine: TraceEvent[] = [];
      const rest: TraceEvent[] = [];
      for (const ev of run.events as TaggedEvent[]) {
        const id = ev[INVOCATION];
        if (id === owner.id) {
          mine.push(ev);
          continue;
        }
        const rec = id != null ? owner.invocations.get(id) : undefined;
        // Unknown id: either an untagged legacy path or an evicted ancient
        // invocation — both long finished, safe to attribute here.
        if (!rec || (rec.done && rec.finishedAt <= owner.startedAt)) mine.push(ev);
        else rest.push(ev);
      }
      if (!mine.length) {
        consumed = false;
        return;
      }
      run.events = rest;
      events = mine;
    }
    buildAndSendTrace(state, run, events, input);
   } catch {
    /* observing a call must never fail it */
  } finally {
    // A window with NO loop-family warning means the agent did varied,
    // non-repeating work — that is what earns a fresh ceiling. Windows that
    // carry repeat warnings keep accumulating toward the executed-call cap
    // across flushes, or a 12-event flush cadence would reset the ceiling
    // mid-thrash forever.
    const hadLoopWarning =
      run.warnings.some((w) => w.kind === "repeat_ngram" || w.kind === "repeat_visits") || false;
    if (!owner) run.events = [];
    if (consumed) {
      if (!hadLoopWarning) run.rawExecuted = 0;
      run.warnings = [];
      run.seenSignals.clear();
      run.firstWarningAt = undefined;
      run.warnBudget = undefined;
      run.evidence = undefined;
      run.tripped = false;
      resetUsage(run);
      run.t0 = performance.now();
    }
  }
}

function buildAndSendTrace(state: WrapState, run: ReturnType<typeof emptyRun>, events: TraceEvent[], input?: Record<string, unknown>): void {
  const lastOk = lastOkResult(events);
  const output = lastOk ?? run.output;
  const classes = emptyTokenClasses();
  const agentP = run.measured ? run.prompt_tokens : 0;
  const agentC = run.measured ? run.completion_tokens : 0;
  addTokenClass(classes, "frontier", agentP + agentC);
  const islandP = run.island_measured ? run.island_prompt_tokens : 0;
  const islandC = run.island_measured ? run.island_completion_tokens : 0;
  const islandTok = islandP + islandC;
  if (run.island_measured) {
    const cls = run.island_memoized && islandTok === 0 ? "memoized" : "compiled";
    addTokenClass(classes, cls, islandTok);
  }
  const cached = run.cached_tokens + (run.island_measured ? run.island_cached_tokens : 0);
  const cacheWrite = run.cache_write_tokens + (run.island_measured ? run.island_cache_write_tokens : 0);
  const cacheInput = run.cache_input_tokens + (run.island_measured ? run.island_cache_input_tokens : 0);
  if (cached > 0) classes.providerCache = cached;
  const measured = run.measured || run.island_measured;
  const prompt = agentP + islandP;
  const completion = agentC + islandC;
  const trace: StretchTrace = {
    // Events were redacted at push time, so what is buffered is already a
    // snapshot: holding the caller's live objects until flush meant a caller
    // that reuses its args record between turns rewrote the history the
    // compiler learns from, and moved the redaction window to the wrong
    // moment.
    id: crypto.randomUUID(),
    events,
    input: (redact(input ?? events[0]?.args ?? {}) as Record<string, unknown>) ?? {},
    output: output === undefined ? undefined : redact(output),
    llmCalls: run.llmCalls,
    duration_ms: performance.now() - run.t0,
    cost_cents: run.cost,
    complete: events.at(-1)?.ok,
    ...(measured ? { prompt_tokens: prompt, completion_tokens: completion, tokenClasses: classes } : {}),
    ...cacheHitSpread(cached, cacheWrite, cacheInput),
    ...(run.warnings.length ? { warnings: run.warnings.slice() } : {}),
    ...(run.firstWarningAt != null ? { firstWarningAt: run.firstWarningAt } : {}),
    ...(run.evidence ? { evidence: run.evidence } : {}),
    ...(events.some((e) => e.skipped) ? { skipped: events.filter((e) => e.skipped).map((e) => e.name) } : {}),
  };
  const nowBudget = {
    duration_ms: trace.duration_ms,
    llmCalls: trace.llmCalls,
    ...(run.measured ? { prompt_tokens: run.prompt_tokens, completion_tokens: run.completion_tokens } : {}),
  };
  const spent = postWarningSpend(nowBudget, run.warnBudget);
  if (spent) trace.postWarning = spent;
  trace.usable = usableTrace(trace);
  trace.grounded = judgeGrounding(trace).grounded;
  if (state.droppedPosts > 0) {
    // Outbox overflow silently destroyed receipts/traces. Surface the count on
    // every later trace so the loss is at least visible to the desk.
    (trace as StretchTrace & { dropped_posts?: number }).dropped_posts = state.droppedPosts;
  }
  if (state.agentId) trace.agentId = state.agentId;
  if (state.parentRunId) trace.parentRunId = state.parentRunId;
  if (state.spanId) {
    trace.spanId = state.spanId;
    trace.spanName = state.parentRunId ? "invoke_agent" : "invoke_workflow";
  }
  if (state.fleetId) trace.fleetId = state.fleetId;
  if (state.region) trace.region = state.region;
  pushCapped(state.traces, trace);
  notifyHost(() => state.opts.onTrace?.(trace));
  post(state, "/v1/traces", trace);
}

function noteSignals(state: WrapState, run: ReturnType<typeof emptyRun>): void {
  if (run.warnings.length >= MAX_WARNINGS) return;
  // Idle / first-call: no live programs and fewer than two events cannot
  // produce a signal (fail streak and n-grams need 2). Still stamp
  // firstWarningAt so a failed first call is visible to killAfterWarning.
  if (run.events.length < 2 && state.programs.length === 0) {
    if (run.firstWarningAt == null) {
      const at = firstWarningIndex(run.events, run.warnings);
      if (at != null) {
        run.firstWarningAt = at;
        run.warnBudget = {
          duration_ms: Math.max(0, performance.now() - run.t0),
          llmCalls: run.llmCalls,
          ...(run.measured ? { prompt_tokens: run.prompt_tokens, completion_tokens: run.completion_tokens } : {}),
        };
      }
    }
    return;
  }
  const budget = {
    duration_ms: Math.max(0, performance.now() - run.t0),
    llmCalls: run.llmCalls,
    ...(run.measured ? { prompt_tokens: run.prompt_tokens, completion_tokens: run.completion_tokens } : {}),
  };
  const required = state.programs.length === 0 ? [] : requiredChecks(liveOf(state), run.events);
  const ledger = required.length === 0 ? undefined : evidenceLedger(run.events, required);
  const fresh = takeSignals(run.events, budget, run.seenSignals, required, ledger);
  for (const w of fresh) {
    if (run.warnings.length >= MAX_WARNINGS) break;
    run.warnings.push(w);
    notifyHost(() => state.opts.onWarning?.(w));
  }
  run.evidence = ledger ?? EMPTY_LEDGER;
  if (run.firstWarningAt == null) {
    const at = firstWarningIndex(run.events, run.warnings);
    if (at != null) {
      run.firstWarningAt = at;
      run.warnBudget = budget;
    }
  }
  if (fresh.some((w) => w.kind === "fail_streak")) {
    run.tripped = true;
    const last = run.events.at(-1)?.name;
    if (last) pauseLiveFor(state, last);
  }
}

function pauseLiveFor(state: WrapState, toolName: string): void {
  // Enforcement-only action. Pausing mutates which programs run and POSTs
  // control-plane state — in observe mode the guards are witnesses, not
  // actors: they record the fail_streak and surface it, they don't reach
  // into the agent's toolset.
  if (!enforcementEnabled(state.opts)) return;
  for (const p of state.programs) {
    if (!p.manifest || state.pausedIds.has(p.id)) continue;
    if (!(p.sequence ?? []).includes(toolName)) continue;
    state.pausedIds.add(p.id);
    post(state, `/v1/tools/${encodeURIComponent(p.id)}/pause`, {});
  }
}

function lastOkResult(events: WrapState["run"]["events"]): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.ok && !ev.skipped) return ev.result;
  }
  return undefined;
}

function compiledDef(state: WrapState, p: StretchProgram, tools: ToolsIn, registry: ToolRegistry): ToolDef {
  return {
    description: p.description,
    parameters: p.inputSchema,
    inputSchema: p.inputSchema,
    execute: async (args) => {
      try {
        safely(() => noteJitUsed(state.jit, [p.name, ...(p.sequence ?? []).slice(0, 1)]), undefined);
        const input = safely(() => extractInput(p, args), args);
        const taken = await safelyAsync(() => takeSpeculation(state, p, input), { hit: false as const });
        const value = taken.hit ? taken.value : await runCompiled(state, p, args, tools, registry);
        if (!taken.hit) markStretchServed(state, p, input);
        return value;
      } catch (err) {
        if (state.opts.failOpen === false) throw err;
        // Same fallback policy as the prefix-steer path — one engine, one
        // promise. A plain Error has UNKNOWN touched-ness (it may have thrown
        // after earlier steps ran), so only an all-reads stretch replays raw.
        // Everything else returns the structured deopt the agent can read and
        // recover from; a validation bug or registry gap never becomes the
        // call's result.
        const first = (p.sequence ?? [])[0];
        const canReplay = replayableProgram(p) && !!first && first in tools;
        if (!isDeopt(err)) {
          return canReplay
            ? asToolDef(first!, tools[first!]!).execute(args)
            : { eden: "deopt", reason: err instanceof Error ? err.message : String(err) };
        }
        if (!isEarlyDeopt(err) && !replayableProgram(p)) {
          return { eden: "deopt", reason: (err as Error).message };
        }
        if (canReplay) return asToolDef(first!, tools[first!]!).execute(args);
        // No raw counterpart exists for this compiled name. Nothing proved
        // touched (or it is all reads), but there is nothing to fall back to:
        // hand back a structured result rather than a thrown error.
        return { eden: "deopt", reason: (err as Error).message };
      } finally {
        afterTurn(state, args, p.name);
      }
    },
  };
}

function liveOf(state: WrapState): StretchProgram[] {
  return filterCanary(
    state.programs.filter((p) => p.manifest && !state.pausedIds.has(p.id)),
    state.sessionId,
  );
}

export { filterCanary } from "./canary";

function entityKey(rec: Record<string, unknown> | undefined): string | undefined {
  try {
    if (!rec) return undefined;
    const id = hintIdOf(rec);
    if (id == null || id === "") return undefined;
    return String(id);
  } catch {
    return undefined;
  }
}

function markDirty(state: WrapState, rec: Record<string, unknown> | undefined, names?: string[]): void {
  try {
    const mutating = names ? names.some((n) => isMutating(n)) : true;
    if (!mutating) return;
    const k = entityKey(rec);
    if (k) {
      state.dirtyEntities.add(k);
      state.dirtyAt.set(k, performance.now());
    }
  } catch {
    /* fail open: a dirty-set fault must not fail the write */
  }
}

function staleRead(
  state: WrapState,
  rec: Record<string, unknown> | undefined,
  armed?: Armed,
): boolean {
  try {
    const k = entityKey(rec);
    if (!k || !state.dirtyEntities.has(k)) return false;
    const writtenAt = state.dirtyAt.get(k);
    if (writtenAt == null) return true;
    // Same-stretch arming is restamped after the compiled run; its reads
    // already saw the write. Only pre-write armings are stale.
    if (armed && armed.armedAt >= writtenAt) return false;
    return true;
  } catch {
    return false;
  }
}

const NO_LIVE: StretchProgram[] = [];
const NO_PREFIX: { p: StretchProgram; input: Record<string, unknown> }[] = [];
const FLUSH_NAME = /^(notify|complete|finalize|done)$/i;
const EMPTY_LEDGER = Object.freeze({
  required: Object.freeze([] as string[]),
  present: Object.freeze([] as string[]),
  absent: Object.freeze([] as string[]),
  failed: Object.freeze([] as string[]),
});

function tagInvocation(ev: TraceEvent, selfId: number, agentId?: string): TraceEvent {
  if (agentId) ev.agentId = agentId;
  (ev as TaggedEvent)[INVOCATION] = selfId;
  return ev;
}

/**
 * Run an Eden-side computation, degrading to `fallback` if it throws.
 *
 * This is the mechanical form of the prime directive: nothing Eden computes
 * about a call — matching, envelopes, arming, guards, telemetry — is allowed
 * to make the call itself fail. A corrupt program, a bad envelope shape, a bug
 * in our own bookkeeping: the agent's tool call still executes exactly as if
 * Eden were absent.
 */
function safely<T>(fn: () => T, fallback: T, onErr?: (err: unknown) => void): T {
  try {
    return fn();
  } catch (err) {
    onErr?.(err);
    return fallback;
  }
}

async function safelyAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/** End of turn: start the next read-only stretch during the model's think. */
function afterTurn(state: WrapState, args: Record<string, unknown>, name?: string): void {
  safely(() => turnBoundary(state, { lastTool: name, lastArgs: args, input: args }), null);
}

/** Can this stretch be re-run raw after a partial compiled attempt without duplicating side effects? */
function replayableProgram(p: StretchProgram): boolean {
  return (p.sequence ?? []).every((n) => isReadName(n));
}

/**
 * Returns `{ [K in keyof T]: ToolDef }`, not `T` — every entry has been through
 * asToolDef(), so a bare function in becomes a ToolDef out. Saying `T` claimed
 * the inputs came back untouched, which handed callers the *input* signature:
 * an inline `{ ping: { execute: () => 1 } }` made `tools.ping.execute({})` a
 * type error even though the proxy passes args through. Intersecting with the
 * index signature keeps dynamic lookups of compiled tools working.
 */
export function wrapTools<T extends ToolsIn>(
  tools: T,
  state: WrapState,
): { [K in keyof T]: ToolDef } & Record<string, ToolDef> {
  const run = state.run;
  // Per-invocation records for trace attribution (see emitTrace). Keyed by a
  // monotonically increasing id stamped onto each pushed event.
  const invocations = new Map<number, Invocation>();
  let nextInvocationId = 0;
  // Bounded like every other per-call structure: once finished entries are
  // evicted, their buffered events are treated as long-finished and claimed by
  // the next flush rather than leaking forever.
  const evictInvocations = (): void => {
    if (invocations.size <= 256) return;
    for (const [id, rec] of invocations) {
      if (invocations.size <= 128) break;
      if (rec.done) invocations.delete(id);
    }
  };
  // `rest` counts how many raw calls of each tool the compiled run has already
  // performed on the caller's behalf, so a sequence that calls one tool twice
  // suppresses both raw repeats rather than only the first.
  //
  // Session-partitioned store (Wave 4.2): hosted dispatch shares one store
  // keyed by session. Per-session cap fail-opens (A3). In-flight heads do not
  // TTL-expire. Scan is newest-first and skips extractInput when identity
  // cannot match (4.3).
  const store = state.arming;
  const session = state.sessionId;
  const fleetId = state.fleetId;
  const tag = (ev: TraceEvent, selfId: number): TraceEvent => tagInvocation(ev, selfId, state.agentId || undefined);
  const registry = registryFrom(
    Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, asToolDef(k, v).execute])),
  );
  bindSpeculateRunner(state, {
    live: () => (state.programs.length === 0 ? NO_LIVE : liveOf(state)),
    run: (program, input) => runCompiled(state, program, input, tools, registry),
  });
  bindWarmRunner(state, {
    live: () => (state.programs.length === 0 ? NO_LIVE : liveOf(state)),
    execute: (tool, args) => registry.execute(tool, args),
  });
  const wrapped: Record<string, ToolDef> = {};
  // Keyed by program id, but holding the program the entry was built from.
  // `compiledDef` closes over that program, so caching by id alone pinned the
  // first version ever seen: after pullLive swapped in a fixed — or rolled
  // back — build of the same id, this process kept executing the old steps for
  // the life of the process, which is exactly the case a server-side rollback
  // exists to stop. Comparing identity re-derives on any swap, and needs no
  // version field to be present or trustworthy.
  const compiledCache = new Map<string, { program: StretchProgram; def: ToolDef }>();
  let calls = 0;
  let skipSeq = 0;

  const note = (): void => safely(() => noteSignals(state, run), undefined);
  const emit = (
    input: Record<string, unknown> | undefined,
    owner?: { id: number; startedAt: number; invocations: Map<number, Invocation> },
  ): void => safely(() => emitTrace(state, run, input, owner), undefined);

  const armTail = (program: StretchProgram, input: Record<string, unknown>): { key: string; armed: Armed } | null => {
    const key = `${program.id}#${++skipSeq}`;
    const rest = restCounts(program);
    let resolveSettled!: (ok: boolean) => void;
    const settled = new Promise<boolean>((r) => (resolveSettled = r));
    const armed: Armed = {
      rest,
      input,
      programId: program.id,
      armedAt: performance.now(),
      armedAtCall: calls,
      budgetCalls: totalRest(rest) + ARM_SLACK_CALLS,
      matchedCalls: 0,
      settled,
      resolveSettled,
      closed: false,
      hintId: hintIdOf(input),
      head: (program.sequence ?? [])[0],
      served: new Set(program.sequence ?? []),
    };
    const readOnly = isProgramReadOnly(program);
    if (readOnly) {
      armed.readOnly = true;
      if (fleetId) armed.fleetId = fleetId;
    }
    if (state.agentId) armed.agentIds = new Set([state.agentId]);
    if (!store.insert(session, key, armed)) {
      state.capacityMisses++;
      const detail = `capacity: session full (${store.sessionSize(session)}/${store.perSessionMax}), this stretch ran raw`;
      const w = {
        kind: "budget" as const,
        at: run.events.length,
        detail,
        duration_ms: 0,
        llmCalls: run.llmCalls,
      };
      if (run.warnings.length < MAX_WARNINGS) run.warnings.push(w);
      notifyHost(() => state.opts.onWarning?.(w));
      // Canvas classifies receipts, not wrap warnings. A fail-open stretch
      // still ran — ok, degraded — so the desk can say so without inventing
      // a failure.
      const receipt: Receipt = {
        toolId: program.id,
        version: program.version,
        ms: 0,
        llmCalls: 0,
        cents: 0,
        ok: true,
        outcome: "degraded",
        reason: detail,
        fingerprint: hashStretch(program),
      };
      stampIdentity(state, receipt);
      pushCapped(state.receipts, receipt);
      notifyHost(() => state.opts.onReceipt?.(receipt));
      post(state, "/v1/receipts", receipt);
      return null;
    }
    return { key, armed };
  };

  const skipAsShared = (armed: Armed, toolName: string, selfId: number): void => {
    const n = markShared(armed, state.agentId);
    const line = n >= 2 ? sharedAcrossLine(n) : undefined;
    run.events.push(
      tag(
        {
          name: toolName,
          args: {},
          ok: true,
          skipped: true,
          duration_ms: 0,
          tokenClass: "steered-skip",
          ...(n >= 2 ? { sharedAcross: n } : {}),
        },
        selfId,
      ),
    );
    note();
    if (line) {
      const prog = state.programs.find((p) => p.id === armed.programId);
      const rec = stampIdentity(state, {
        toolId: armed.programId,
        version: prog?.version ?? "0",
        ms: 0,
        llmCalls: 0,
        cents: 0,
        ok: true,
        outcome: "skipped",
        skipped: [toolName],
        tokenClass: "steered-skip",
        reason: line,
        sharedAcross: n,
        ...(prog ? { fingerprint: hashStretch(prog) } : {}),
      });
      pushCapped(state.receipts, rec);
      notifyHost(() => state.opts.onReceipt?.(rec));
      post(state, "/v1/receipts", rec);
    }
    stampRemainderSkip(state, armed, toolName);
  };

  const compiledFor = (name: string): ToolDef | undefined => {
    if (!state.programs.length) return undefined;
    const p = liveOf(state).find((x) => x.name === name || x.id === name);
    if (!p) return undefined;
    const cached = compiledCache.get(p.id);
    if (cached && cached.program === p) return cached.def;
    const def = compiledDef(state, p, tools, registry);
    compiledCache.set(p.id, { program: p, def });
    return def;
  };

  for (const [name, def] of Object.entries(tools)) {
    const spec = asToolDef(name, def);
    const runOne = async (args: Record<string, unknown>, selfId: number, startedAt: number): Promise<unknown> => {
        if (state.opts.baseUrl && calls % PULL_EVERY === 0) void pullLive(state);
        safely(() => noteJitUsed(state.jit, [name]), undefined);
        const live = state.programs.length === 0 ? NO_LIVE : liveOf(state);
        const owner = { id: selfId, startedAt, invocations };

        // Everything between here and the raw execute is Eden's own
        // bookkeeping, each piece wrapped so its failure degrades to
        // "no opinion" rather than a failed call (see safely()).
        const prefixHits = live.length
          ? safely(
              () =>
                live
                  .filter((p) => (p.sequence ?? [])[0] === name)
                  .map((p) => ({ p, input: extractInput(p, args) }))
                  .filter(({ p, input }) => mayServe(p, input))
                  .filter(({ input }) => !(isReadName(name) && staleRead(state, input))),
              NO_PREFIX,
            )
          : NO_PREFIX;
        if (prefixHits.length > 1) {
          prefixHits.sort((a, b) => (b.p.sequence?.length ?? 0) - (a.p.sequence?.length ?? 0));
        }
        const hit = prefixHits[0];
        if (hit) {
          // Spent halt must win before compile-steer. Wrap's real first-tool
          // path is this sequence head — the later decideGuard never sees it.
          // Observe/default skip this consult (prime directive). Steer falls
          // through to prefix-serve; guard-steer already exists on the raw path.
          if (enforcementEnabled(state.opts)) {
            const guard = safely(
              () => decideGuard({ name, run, live, opts: state.opts, now: performance.now() }),
              null,
            );
            if (guard && (guard.action === "halt" || guard.action === "block")) {
              emit(run.events[0]?.args, owner);
              return guardRefuse(guard);
            }
          }
          // If this entity is already armed, do NOT start a second compiled run.
          // A sequence that repeats the head tool name — or an oblivious agent
          // that re-issues the head call — used to re-steer here and duplicate
          // every mutation the in-flight (or just-finished) run already
          // performed. Fall through to the sibling claim path instead (ADR 002
          // partial-input identity; ADR 003 keep failed armings readable).
          const sessionArmed = safely(() => {
            const t = performance.now();
            for (const [, armed] of store.all(session, t)) {
              if (armed.programId !== hit.p.id) continue;
              if (inputAgrees(armed, hit.input as Record<string, unknown>)) return true;
            }
            return false;
          }, false);
          const fleetHit = safely((): FleetHit | undefined => {
            if (!fleetId || !isProgramReadOnly(hit.p)) return undefined;
            const t = performance.now();
            for (const found of store.allFleet(fleetId, t)) {
              if (found.armed.programId !== hit.p.id) continue;
              if (inputAgrees(found.armed, hit.input as Record<string, unknown>)) return found;
            }
            return undefined;
          }, undefined);
          if (fleetHit) {
            // Head is not in rest. Wait for the leader, then skip the raw GET
            // or the first fetch still duplicates across agents.
            const ok = await waitSettled(fleetHit.armed, wrapTimeoutMs(state.opts.timeoutMs));
            if (ok) {
              if (isReadName(name) && staleRead(state, args, fleetHit.armed)) {
                /* pre-write cache; fall through to execute */
              } else {
              skipAsShared(fleetHit.armed, name, selfId);
              return { eden: "steered", skipped: name };
              }
            }
          } else if (!sessionArmed) {
          // Armed *before* the await, not after. Real hosts issue a turn's tool
          // calls in parallel, and while the compiled program was running the
          // map was still empty — so a sibling call naming a later step of the
          // same stretch sailed past the skip check and executed for real,
          // duplicating whatever the compiled leg was in the middle of doing.
          if (run.events.length) emit(run.events[0]?.args, owner);
          const pair = safely(() => armTail(hit.p, hit.input), null);
          if (!pair) {
            // Corrupt program defeated arming; treat as no opinion and let the
            // raw call run below.
          } else {
          const { key: armKey, armed } = pair;
          try {
            if (!isProgramReadOnly(hit.p)) discardSpeculation(state);
            const taken = await safelyAsync(
              () => takeSpeculation(state, hit.p, hit.input),
              { hit: false as const },
            );
            const value = taken.hit
              ? taken.value
              : await runCompiled(state, hit.p, hit.input, tools, registry);
            if (!taken.hit) markStretchServed(state, hit.p, hit.input);
            // Re-stamp now the run has actually finished. The TTL was started
            // before the await, but wrapTimeoutMs permits a compiled program
            // up to 300s — five times the TTL — so a legitimately slow run
            // returned to an arming that had already expired and every raw
            // tail call went straight through to the real tool. The entry
            // still has to be *inserted* early, for the parallel-sibling race
            // above; only the clock starts late.
            armed.armedAt = performance.now();
            armed.armedAtCall = calls;
            const compiled = [...state.receipts].reverse().find((r) => r.toolId === hit.p.id && r.ok);
            if (compiled) armedReceipts.set(armed, compiled);
            // Wake any parallel siblings that were waiting on this outcome.
            try {
              armed.closed = true;
              armed.resolveSettled(true);
            } catch { /* deferred already gone */ }
            // Flush after the steered tail is absorbed so skipped names land
            // on this stretch instead of leaking into the next ticket.
            if (!armed.rest.size) emit(hit.input, owner);
            return value;
          } catch (err) {
            // Only this invocation's arming. The previous code deleted every
            // arming for the program, so one failed run for input B disarmed a
            // successful run for input A and let A's raw tail execute a second
            // time.
            armed.headErr = err;
            try {
              armed.closed = true;
              armed.resolveSettled(false);
            } catch { /* deferred already gone */ }
            // KEEP this arming. Deleting it here used to strand the very
            // information siblings need: a deopt after a mutating step means
            // that step is DONE, and the only record of which steps ran is
            // this entry's headErr.toolCalls. With the entry gone, an
            // oblivious agent's next raw call found nothing to claim and
            // executed a second time — a duplicated write on every failed
            // stretch. Failed armings expire through the normal paths (TTL,
            // call budget, bounded-map eviction); input matching keeps them
            // from claiming anything but their own stretch.
            if (state.opts.failOpen === false) throw err;
            void pullLive(state);
            // Fall back to raw whenever replay provably duplicates nothing:
            // a deopt that issued no tool calls, or an all-reads stretch. A
            // plain Error has UNKNOWN touched-ness — it may have thrown after
            // earlier steps ran — so only all-reads stretches replay it.
            // Everything else returns the structured deopt: re-running raw
            // could repeat a write, and a structured result is one the agent
            // can read and recover from. Eden chose to run this stretch, so
            // an Eden-side failure may never become the call's result.
            const touched = isDeopt(err) && !isEarlyDeopt(err);
            const unknownState = !isDeopt(err);
            if ((touched || unknownState) && !replayableProgram(hit.p)) {
              return { eden: "deopt", reason: err instanceof Error ? err.message : String(err) };
            }
          }
          }
          }
        }

        const now = performance.now();
        // Per-entry isolation: one corrupt arming degrades to "no opinion" for
        // itself without taking down the scan or the call. Newest first; identity
        // reject before extractInput (Wave 4.3).
        let steeredSkip = false;
        let skipArmed: Armed | undefined;
        let structuredDeopt: string | null = null;
        const seenArmed = new Set<Armed>();
        const candidates: Array<{ session: string; key: string; armed: Armed }> = [];
        if (store.sessionSize(session)) {
          for (const [key, armed] of store.scan(session, name, args, now)) {
            seenArmed.add(armed);
            candidates.push({ session, key, armed });
          }
        }
        if (fleetId) {
          for (const hit of store.scanFleet(fleetId, name, args, now)) {
            if (seenArmed.has(hit.armed)) continue;
            candidates.push(hit);
          }
        }
        for (const { session: armSession, key: id, armed } of candidates) {
          if (safely(() => armExpired(armed, now), false)) {
            store.delete(armSession, id);
            continue;
          }
          const inputMatches = safely(() => {
            const liveP = live.find((p) => p.id === armed.programId);
            const cur = liveP ? extractInput(liveP, args) : args;
            return inputAgrees(armed, cur as Record<string, unknown>);
          }, false);
          if (!inputMatches) continue;
          // A matching call burns budget whether or not a unit is left: this
          // is how an agent that has moved well past the stretch eventually
          // disarms it, while other stretches' interleaved calls do not.
          safely(() => {
            armed.matchedCalls++;
          }, undefined);
          const remaining = safely(() => armed.rest.get(name), 0);
          const fleetServed =
            armed.readOnly === true &&
            !!fleetId &&
            armed.fleetId === fleetId &&
            (armed.served?.has(name) === true || armed.head === name);
          if (!remaining && !fleetServed) continue;
          // The head's compiled run is doing this call's work. Wait for its
          // outcome before claiming anything — claiming first and learning
          // later is how a suppressed sibling's work was lost forever when the
          // head failed mid-flight. Bounded by the wrap timeout so a hung head
          // degrades to raw execution, never an eternal wait.
          const ok = await waitSettled(armed, wrapTimeoutMs(state.opts.timeoutMs));
          if (ok) {
            // Head succeeded; the compiled run performed this step. A dirty
            // entity after a mutating write must not be served from a pre-write
            // skip/cache — force execute the read instead.
            if (isReadName(name) && staleRead(state, args, armed)) continue;
            // Re-verify the entry still holds work to claim (a concurrent sibling may
            // have taken the last unit while we waited). Fleet head is not in
            // rest — skip it without decrementing.
            if (fleetServed && !remaining) {
              skipAsShared(armed, name, selfId);
              steeredSkip = true;
              skipArmed = armed;
              break;
            }
            const stillThere = safely(() => store.get(armSession, id) === armed && !!armed.rest.get(name), false);
            if (!stillThere) {
              if (!fleetServed) continue;
              skipAsShared(armed, name, selfId);
              steeredSkip = true;
              skipArmed = armed;
              break;
            }
            safely(() => {
              // Decrement rather than delete: a sequence may call the same tool
              // more than once, and the compiled program performed each of those.
              // Treating the tail as a Set swallowed only the first raw repeat and
              // let every later one execute again.
              const left = armed.rest.get(name)!;
              if (left > 1) armed.rest.set(name, left - 1);
              else armed.rest.delete(name);
              store.noteRest(armSession, id);
            }, undefined);
            skipAsShared(armed, name, selfId);
            if (!armed.rest.size && !(armed.readOnly && armed.fleetId)) {
              store.delete(armSession, id);
              emit(armed.input, owner);
            } else if (!armed.rest.size) {
              emit(armed.input, owner);
            }
            steeredSkip = true;
            skipArmed = armed;
            break;
          }
          // Head failed. Was THIS step already performed before the failure?
          // DeoptError carries the completed-tool list; a plain error tells us
          // nothing about state.
          const doneByCompiled = safely(() => {
            const e = armed.headErr;
            return isDeopt(e) && Array.isArray((e as { toolCalls?: string[] }).toolCalls)
              ? (e as { toolCalls: string[] }).toolCalls.includes(name)
              : null;
          }, null);
          if (doneByCompiled === true) {
            // The compiled run completed this step before failing later on.
            // Claim it exactly like a success.
            safely(() => {
              const left = armed.rest.get(name)!;
              if (left > 1) armed.rest.set(name, left - 1);
              else armed.rest.delete(name);
              store.noteRest(armSession, id);
              if (!armed.rest.size) store.delete(armSession, id);
            }, undefined);
            steeredSkip = true;
            break;
          }
          // Reads are always safe to re-run. A mutating step under unknown
          // state gets the honest structured result — never a silent re-run
          // that could duplicate a write, never a false "steered" that claims
          // work happened when nobody knows.
          if (!isReadName(name)) {
            const reason = safely(
              () => (armed.headErr instanceof Error ? armed.headErr.message : String(armed.headErr)),
              "compiled run failed",
            );
            structuredDeopt = reason;
            break;
          }
          continue;
        }
        if (steeredSkip) {
          if (skipArmed) stampRemainderSkip(state, skipArmed, name);
          return { eden: "steered", skipped: name };
        }
        if (structuredDeopt != null) return { eden: "deopt", reason: structuredDeopt };

        // Guards only act — halt, block, refuse — when enforcement is on. In
        // the default fail-safe mode they stay observers: warnings accumulate
        // (noteSignals), show up on the dashboard, and never stop a call.
        if (enforcementEnabled(state.opts)) {
          const guard = safely(() => decideGuard({ name, run, live, opts: state.opts, now }), null);
          if (guard && guard.action !== "steer") {
            emit(run.events[0]?.args, owner);
            return guardRefuse(guard);
          }
          if (guard && guard.action === "steer") {
            const steeredIn = safely(() => extractInput(guard.program, args), null);
            const pair = steeredIn ? safely(() => armTail(guard.program, steeredIn), null) : null;
            if (pair && steeredIn) {
              const { key: armKey, armed } = pair;
              try {
                const value = await runCompiled(state, guard.program, steeredIn, tools, registry);
                armed.armedAt = performance.now();
                armed.armedAtCall = calls;
                try {
                  armed.closed = true;
                  armed.resolveSettled(true);
                } catch { /* deferred already gone */ }
                if (!armed.rest.size) emit(steeredIn, owner);
                return value;
              } catch (err) {
                armed.headErr = err;
                try {
                  armed.closed = true;
                  armed.resolveSettled(false);
                } catch { /* deferred already gone */ }
                // Keep the arming (see prefix-steering catch): a sibling whose
                // step the failed run already performed must claim it, not
                // re-run it, even though THIS call is refused.
                emit(run.events[0]?.args, owner);
                // DIFFERENT from prefix steering, deliberately: the guard
                // chose this program because the raw call was unacceptable
                // (unverifiable finalize, over-budget). Falling back to that
                // raw call would defeat the refusal, so a failed guard-steer
                // ends the call — unless the stretch is reads, where a raw
                // retry duplicates nothing and refuses nothing.
                const touched = isDeopt(err) && !isEarlyDeopt(err);
                if (!(replayableProgram(guard.program) && !touched)) {
                  return { eden: "halted", reason: guard.reason };
                }
                // all-reads + provably-untouched: safe to fall through to raw
              }
            }
            // pair === null: arming failed on a corrupt program — fall through
            // to raw rather than ending the call.
          }
        }

        const t0 = performance.now();
        // Unconditional run-length ceiling — enforcement mode only (see
        // enforcementEnabled). Progress detection is heuristic; one drifting
        // field (a timestamp on results, a nonce in args) can defeat every
        // detector while spend accumulates per call. This cap counts
        // executions, not similarity, so it cannot be gamed.
        //
        // The halt MUST push a marker event before flushing: emitTrace
        // early-returns on an empty buffer and its finally-block is the only
        // place rawExecuted resets when the window carries loop warnings.
        // Without the marker the first halt wedged the state permanently —
        // every later call halted with an empty event buffer, unreachable by
        // the reset. After the marker, the window flushes clean-ish and work
        // resumes; sustained thrash simply re-arms the ceiling (bounded spend,
        // never a bricked state).
        if (enforcementEnabled(state.opts) && run.rawExecuted >= maxRunSteps()) {
          // Explicit reset: with the marker flushed, the next cycle starts
          // fresh — sustained thrash re-arms the ceiling instead of wedging.
          run.rawExecuted = 0;
          note();
          const marker: TraceEvent = { name, args: {}, ok: true, skipped: true, duration_ms: 0 };
          run.events.push(marker);
          emit(run.events[0]?.args, owner);
          return { eden: "halted", reason: "max_steps" };
        }
        try {
          const result = await spec.execute(args);
          run.rawExecuted++;
          if (isMutating(name)) markDirty(state, args, [name]);
          noteJitUsed(state.jit, [name]);
          // Redact here, not at flush. These stay buffered for up to 12 events,
          // and holding live references to the caller's objects meant an agent
          // loop that reuses one args record per turn rewrote already-recorded
          // history — the witnesses programs get compiled from were of calls
          // that never happened. It also kept arbitrary result graphs alive.
          run.events.push(
            tag({
              name,
              args: redact(args) as Record<string, unknown>,
              result: redact(result),
              ok: true,
              duration_ms: performance.now() - t0,
              tokenClass: "frontier",
            }, selfId),
          );
          note();
          const last = live.length !== 0 && live.some((p) => (p.sequence ?? []).at(-1) === name);
          if (last || FLUSH_NAME.test(name) || run.events.length >= 12) {
            emit(run.events[0]?.args, owner);
          }
          return result;
        } catch (err) {
          run.rawExecuted++;
          run.events.push(tag({ name, args: redact(args) as Record<string, unknown>, ok: false, duration_ms: performance.now() - t0, tokenClass: "frontier" }, selfId));
          if (run.firstWarningAt == null) run.firstWarningAt = run.events.length - 1;
          note();
          throw err;
        }
    };
    wrapped[name] = {
      ...spec,
      execute: async (args: Record<string, unknown>) => {
        calls++;
        // One invocation record per execute. The `finally` stamps completion
        // even when the call throws, so a failed raw call's event is still
        // claimable by a later sequential flush.
        const selfId = ++nextInvocationId;
        const rec: Invocation = { startedAt: performance.now(), done: false, finishedAt: 0 };
        invocations.set(selfId, rec);
        evictInvocations();
        try {
          const value = await runOne(args, selfId, rec.startedAt);
          afterTurn(state, args, name);
          return value;
        } finally {
          rec.done = true;
          rec.finishedAt = performance.now();
        }
      },
    };
  }

  // Name collisions between a host's own tool and an approved compiled tool
  // must resolve the SAME WAY everywhere: injectTools (the HTTP proxy) already
  // drops the client's duplicate, so the compiled tool wins there. The local
  // Proxy used to do the opposite — raw wins — so the same agent executed
  // different logic depending on how it was connected. Compiled wins now,
  // with a one-time warning; the compiled artifact passed human approval and
  // shadow validation, its ad-hoc namesake did not.
  const warnedCollisions = new Set<string>();
  return new Proxy(wrapped, {
    get(target, prop, recv) {
      if (typeof prop !== "string") return Reflect.get(target, prop, recv);
      if (!state.programs.length) {
        if (prop in target) return target[prop];
        return undefined;
      }
      const compiled = compiledFor(prop);
      if (compiled) {
        if (prop in target && !warnedCollisions.has(prop)) {
          warnedCollisions.add(prop);
          console.error(
            `[eden] tool "${prop}" exists both in your tools and as an approved compiled tool; ` +
              "the compiled version takes precedence (matching the HTTP proxy). Rename one to disambiguate.",
          );
        }
        return compiled;
      }
      if (prop in target) return target[prop];
      return undefined;
    },
    has(target, prop) {
      if (typeof prop === "string" && liveOf(state).some((x) => x.name === prop)) return true;
      return prop in target;
    },
    ownKeys(target) {
      const extra = liveOf(state).map((p) => p.name);
      return [...new Set([...Object.keys(target), ...extra])];
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop !== "string") return Object.getOwnPropertyDescriptor(target, prop);
      const value = prop in target ? target[prop] : compiledFor(prop);
      if (value === undefined) return undefined;
      return { configurable: true, enumerable: true, writable: true, value };
    },
  }) as { [K in keyof T]: ToolDef } & Record<string, ToolDef>;
}

export function recordTools(state: WrapState): StretchTrace[] {
  return state.traces;
}
