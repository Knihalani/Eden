import type { IslandCaller, StretchProgram, StretchTrace, TokenClass, ToolRegistry, TraceEvent } from "@eden/ir";
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
  protocolHeaders, MAX_RUN_STEPS,
} from "@eden/ir";
import { DeoptError, isDeopt, isReplaySafe, registryFrom, runProgram } from "@eden/runtime";
import { emptyRun, type EdenOpts, type Receipt, type RunRecorder, type ToolDef, type ToolsIn } from "./types";
import { filterCanary } from "./canary";
import { extractInput } from "./steer";
import { cacheHitSpread, resetUsage } from "./usage";
import { decideGuard, enforcementEnabled, requiredChecks } from "./guard";
import {
  ARM_SLACK_CALLS,
  armExpired,
  createArmingStore,
  hintIdOf,
  restCounts,
  totalRest,
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
import { bindWarmRunner, claimWarm, watchWarm, takeWarm } from "./warm";

const MAX_TRACES = 2000;
const PULL_EVERY = 24;
const MAX_OUTBOX = 64;
const MAX_POST_TRIES = 5;
const MAX_WARNINGS = 32;

export type WrapState = {
  opts: EdenOpts;
  programs: StretchProgram[];
  traces: StretchTrace[];
  receipts: Receipt[];
  run: RunRecorder;
  pausedIds: Set<string>;
  droppedPosts: number;
  arming: ArmingStore;
  sessionId: string;
  fleetId: string;
  agentId: string;
  parentRunId?: string;
  spanId?: string;
  region?: string;
  capacityMisses: number;
  dirtyEntities: Set<string>;
  dirtyAt: Map<string, number>;
  jit: JitGuard;
};

type OutboxJob = { path: string; body: unknown; tries: number };

const outboxes = new WeakMap<WrapState, OutboxJob[]>();
const flushers = new WeakMap<WrapState, ReturnType<typeof setTimeout>>();
const armedReceipts = new WeakMap<Armed, Receipt>();

export function wrapTimeoutMs(explicit?: number): number {
  const env = Number(process.env.EDEN_TIMEOUT_MS);
  return Math.min(300_000, Math.max(1, explicit && explicit > 0 ? explicit : Number.isFinite(env) && env > 0 ? env : 60_000));
}

export function createState(opts: EdenOpts = {}): WrapState {
  const sessionId = typeof opts.sessionId === "string" && opts.sessionId.length > 0 ? opts.sessionId : typeof process.env.EDEN_SESSION === "string" && process.env.EDEN_SESSION.length > 0 ? process.env.EDEN_SESSION : "";
  const fleetId = wrapFleetId(opts.fleetId);
  const agentId = wrapAgentId(opts.agentId, sessionId);
  const region = wrapRegion(opts.region);
  return {
    opts: { failOpen: true, ...opts },
    programs: [...(opts.programs ?? [])],
    traces: [],
    receipts: [],
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

async function sendPost(state: WrapState, path: string, body: unknown): Promise<boolean> {
  const base = state.opts.baseUrl;
  const key = state.opts.apiKey || process.env.EDEN_API_KEY || (process.env.EDEN_DEV === "1" ? "eden_dev" : undefined);
  if (!base || !key) return true;
  const fn = state.opts.fetch ?? fetch;
  try {
    const r = await fn(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...protocolHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(((e) => Number.isFinite(e) && e > 0 ? Math.min(120_000, e) : 10_000)(Number(process.env.EDEN_CONTROL_TIMEOUT_MS))),
    });
    return r.ok || !(r.status === 429 || r.status >= 500);
  } catch {
    return false;
  }
}

export async function flushOutbox(state: WrapState): Promise<void> {
  const q = ((s, q = outboxes.get(s) ?? []) => (outboxes.set(s, q), q))(state);
  const job = q.shift();
  if (!job) return;
  const ok = await sendPost(state, job.path, job.body);
  if (!ok) {
    job.tries++;
    if (job.tries < MAX_POST_TRIES && q.length < MAX_OUTBOX) q.push(job);
    else state.droppedPosts++; // retries exhausted, or no room to wait — counted, not silent
    ((state, delayMs) => { if (flushers.has(state)) return; const t = setTimeout(() => { flushers.delete(state); void flushOutbox(state); }, delayMs); t.unref?.(); flushers.set(state, t); })(state, Math.min(30_000, 200 * 2 ** Math.min(job.tries, 8)));
  } else if (q.length) {
    ((state, delayMs) => { if (flushers.has(state)) return; const t = setTimeout(() => { flushers.delete(state); void flushOutbox(state); }, delayMs); t.unref?.(); flushers.set(state, t); })(state, 0);
  }
}

function post(state: WrapState, path: string, body: unknown): void {
  const base = state.opts.baseUrl;
  const key = state.opts.apiKey || process.env.EDEN_API_KEY || (process.env.EDEN_DEV === "1" ? "eden_dev" : undefined);
  if (!base || !key) return;
  void sendPost(state, path, body).then((ok) => {
    if (ok) return;
    const q = ((s, q = outboxes.get(s) ?? []) => (outboxes.set(s, q), q))(state);
    if (q.length >= MAX_OUTBOX) {
      state.droppedPosts++;
      return;
    }
    q.push({ path, body, tries: 0 });
    ((state, delayMs) => { if (flushers.has(state)) return; const t = setTimeout(() => { flushers.delete(state); void flushOutbox(state); }, delayMs); t.unref?.(); flushers.set(state, t); })(state, 50);
  });
}

export async function pullLive(state: WrapState): Promise<void> {
  const base = state.opts.baseUrl;
  const key = state.opts.apiKey || process.env.EDEN_API_KEY || (process.env.EDEN_DEV === "1" ? "eden_dev" : undefined);
  if (!base || !key) return;
  const fn = state.opts.fetch ?? fetch;
  try {
    const r = await fn(`${base.replace(/\/$/, "")}/v1/tools`, {
      headers: { authorization: `Bearer ${key}`, ...protocolHeaders() },
      signal: AbortSignal.timeout(((e) => Number.isFinite(e) && e > 0 ? Math.min(120_000, e) : 10_000)(Number(process.env.EDEN_CONTROL_TIMEOUT_MS))),
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

function stampRemainderSkip(state: WrapState, armed: Armed, toolName: string): void {
  const last = [...state.receipts].reverse().find((r) => r.toolId === armed.programId && r.ok);
  if (!last) return;
  const prog = state.programs.find((p) => p.id === armed.programId);
  const programName = prog?.name?.trim() || "this routine";
  last.skipped = [...new Set([...(last.skipped ?? []), toolName])];
  last.reason = `Already served by ${programName}. Do not re-run ${toolName} — facts are in the last tool output or attached as context.`;
  const n = armed.agentIds?.size ?? 0;
  if (n >= 2) {
    const line = sharedAcrossLine(n);
    last.sharedAcross = n;
    if (!last.reason.includes(line)) last.reason = `${last.reason} · ${line}`;
  }
  try { state.opts.onReceipt?.(last); } catch {}
  post(state, "/v1/receipts", last);
}

export async function runCompiled(
  state: WrapState,
  program: StretchProgram,
  input: Record<string, unknown>,
  tools: ToolsIn,
  registry?: ToolRegistry,
): Promise<unknown> {
  const t0 = performance.now();
  safely(() => watchWarm(state, program, { input }), null);
  safely(() => claimWarm(state, program, input), null);
  const island: IslandCaller =
    state.opts.island ??
    (async () => {
      throw new DeoptError("no island caller");
    });
  try {
    if (!mayServe(program, input)) throw new DeoptError("input not in witness envelope");
    const baseReg =
      registry ??
      registryFrom(Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, (typeof v === "function" ? { description: k, execute: v } : v).execute])));
    const result = await runProgram(program, input, {
      registry: {
        ...(baseReg.has ? { has: (name: string) => baseReg.has!(name) } : {}),
        execute: async (name, args, ctx) => {
          try {
            const taken = await takeWarm(state, program, name, args);
            if (taken.hit) return taken.value;
          } catch {}
          return baseReg.execute(name, args, ctx);
        },
      },
      island,
      llmCents: state.opts.llmCents ?? 1,
      checkEnvelope: false,
      timeoutMs: wrapTimeoutMs(state.opts.timeoutMs),
    });
    const receipt = compiledReceipt(program, true, result.stats);
    ((s, r) => { if (s.agentId) r.agentId = s.agentId; if (s.parentRunId) r.parentRunId = s.parentRunId; if (s.fleetId) r.fleetId = s.fleetId; if (s.region) r.region = s.region; return r; })(state, receipt);
    const stats = result.stats;
    const run = state.run;
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
    state.receipts.push(receipt); if (state.receipts.length > MAX_TRACES + 256) state.receipts.splice(0, state.receipts.length - MAX_TRACES);
    try { state.opts.onReceipt?.(receipt); } catch {}
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
      },
      err,
    );
    ((s, r) => { if (s.agentId) r.agentId = s.agentId; if (s.parentRunId) r.parentRunId = s.parentRunId; if (s.fleetId) r.fleetId = s.fleetId; if (s.region) r.region = s.region; return r; })(state, receipt);
    state.receipts.push(receipt); if (state.receipts.length > MAX_TRACES + 256) state.receipts.splice(0, state.receipts.length - MAX_TRACES);
    try { state.opts.onReceipt?.(receipt); } catch {}
    post(state, "/v1/receipts", receipt);
    throw err;
  }
}

const INVOCATION = Symbol("eden.invocation");
type TaggedEvent = TraceEvent & { [INVOCATION]?: number };

type Invocation = {
  startedAt: number;
  done: boolean;
  finishedAt: number;
};

export { filterCanary } from "./canary";

function markDirty(state: WrapState, rec: Record<string, unknown> | undefined, names?: string[]): void {
  try {
    const mutating = names ? names.some((n) => isMutating(n)) : true;
    if (!mutating) return;
    const k = ((rec) => { try { if (!rec) return undefined; const id = hintIdOf(rec); if (id == null || id === "") return undefined; return String(id); } catch { return undefined; } })(rec);
    if (k) {
      state.dirtyEntities.add(k);
      state.dirtyAt.set(k, performance.now());
    }
  } catch {
  }
}

function staleRead(
  state: WrapState,
  rec: Record<string, unknown> | undefined,
  armed?: Armed,
): boolean {
  try {
    const k = ((rec) => { try { if (!rec) return undefined; const id = hintIdOf(rec); if (id == null || id === "") return undefined; return String(id); } catch { return undefined; } })(rec);
    if (!k || !state.dirtyEntities.has(k)) return false;
    const writtenAt = state.dirtyAt.get(k);
    if (writtenAt == null) return true;
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

export function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function wrapTools<T extends ToolsIn>(
  tools: T,
  state: WrapState,
): { [K in keyof T]: ToolDef } & Record<string, ToolDef> {
  const run = state.run;
  const invocations = new Map<number, Invocation>();
  let nextInvocationId = 0;
  const store = state.arming;
  const session = state.sessionId;
  const fleetId = state.fleetId;
  const tag = (ev: TraceEvent, selfId: number): TraceEvent => {
    const agentId = state.agentId || undefined;
    if (agentId) ev.agentId = agentId;
    (ev as TaggedEvent)[INVOCATION] = selfId;
    return ev;
  };
  const registry = registryFrom(
    Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, (typeof v === "function" ? { description: k, execute: v } : v).execute])),
  );
  bindSpeculateRunner(state, {
    live: () => (state.programs.length === 0 ? NO_LIVE : filterCanary(state.programs.filter((p) => p.manifest && !state.pausedIds.has(p.id)), state.sessionId)),
    run: (program, input) => runCompiled(state, program, input, tools, registry),
  });
  bindWarmRunner(state, {
    live: () => (state.programs.length === 0 ? NO_LIVE : filterCanary(state.programs.filter((p) => p.manifest && !state.pausedIds.has(p.id)), state.sessionId)),
    execute: (tool, args) => registry.execute(tool, args),
  });
  const wrapped: Record<string, ToolDef> = {};
  const compiledCache = new Map<string, { program: StretchProgram; def: ToolDef }>();
  let calls = 0;
  let skipSeq = 0;

  const note = (): void => safely(() => {
    if (run.warnings.length >= MAX_WARNINGS) return;
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
    const required = state.programs.length === 0 ? [] : requiredChecks(filterCanary(state.programs.filter((p) => p.manifest && !state.pausedIds.has(p.id)), state.sessionId), run.events);
    const ledger = required.length === 0 ? undefined : evidenceLedger(run.events, required);
    const fresh = takeSignals(run.events, budget, run.seenSignals, required, ledger);
    for (const w of fresh) {
      if (run.warnings.length >= MAX_WARNINGS) break;
      run.warnings.push(w);
      try { state.opts.onWarning?.(w); } catch {}
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
      if (last && enforcementEnabled(state.opts)) {
        for (const p of state.programs) {
          if (!p.manifest || state.pausedIds.has(p.id)) continue;
          if (!(p.sequence ?? []).includes(last)) continue;
          state.pausedIds.add(p.id);
          post(state, `/v1/tools/${encodeURIComponent(p.id)}/pause`, {});
        }
      }
    }
  }, undefined);
  const emit = (
    input: Record<string, unknown> | undefined,
    owner?: { id: number; startedAt: number; invocations: Map<number, Invocation> },
  ): void => safely(() => {
    if (!run.events.length) return;
    let events = run.events;
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
      let lastOk: unknown;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i]!;
        if (ev.ok && !ev.skipped) {
          lastOk = ev.result;
          break;
        }
      }
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
      state.traces.push(trace); if (state.traces.length > MAX_TRACES + 256) state.traces.splice(0, state.traces.length - MAX_TRACES);
      try { state.opts.onTrace?.(trace); } catch {}
      post(state, "/v1/traces", trace);
     } catch {
    } finally {
      const hadLoopWarning = run.warnings.some((w) => w.kind === "repeat_ngram" || w.kind === "repeat_visits");
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
  }, undefined);

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
      try { state.opts.onWarning?.(w); } catch {}
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
      ((s, r) => { if (s.agentId) r.agentId = s.agentId; if (s.parentRunId) r.parentRunId = s.parentRunId; if (s.fleetId) r.fleetId = s.fleetId; if (s.region) r.region = s.region; return r; })(state, receipt);
      state.receipts.push(receipt); if (state.receipts.length > MAX_TRACES + 256) state.receipts.splice(0, state.receipts.length - MAX_TRACES);
      try { state.opts.onReceipt?.(receipt); } catch {}
      post(state, "/v1/receipts", receipt);
      return null;
    }
    return { key, armed };
  };

  const skipAsShared = (armed: Armed, toolName: string, selfId: number): void => {
    armed.agentIds ??= new Set();
    if (state.agentId) armed.agentIds.add(state.agentId);
    const n = armed.agentIds.size;
    const line = n >= 2 ? sharedAcrossLine(n) : undefined;
    if (line) {
      const rec = armedReceipts.get(armed);
      if (rec) {
        rec.sharedAcross = n;
        if (!rec.reason?.includes(line)) rec.reason = rec.reason ? `${rec.reason} · ${line}` : line;
      }
    }
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
      const rec = ((s, r) => { if (s.agentId) r.agentId = s.agentId; if (s.parentRunId) r.parentRunId = s.parentRunId; if (s.fleetId) r.fleetId = s.fleetId; if (s.region) r.region = s.region; return r; })(state, {
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
      state.receipts.push(rec); if (state.receipts.length > MAX_TRACES + 256) state.receipts.splice(0, state.receipts.length - MAX_TRACES);
      try { state.opts.onReceipt?.(rec); } catch {}
      post(state, "/v1/receipts", rec);
    }
    stampRemainderSkip(state, armed, toolName);
  };

  const compiledFor = (name: string): ToolDef | undefined => {
    if (!state.programs.length) return undefined;
    const p = filterCanary(state.programs.filter((p) => p.manifest && !state.pausedIds.has(p.id)), state.sessionId).find((x) => x.name === name || x.id === name);
    if (!p) return undefined;
    const cached = compiledCache.get(p.id);
    if (cached && cached.program === p) return cached.def;
    const def: ToolDef = {
      description: p.description,
      parameters: p.inputSchema,
      inputSchema: p.inputSchema,
      execute: async (args) => {
        try {
          safely(() => noteJitUsed(state.jit, [p.name, ...(p.sequence ?? []).slice(0, 1)]), undefined);
          const input = safely(() => extractInput(p, args), args);
          const taken = await takeSpeculation(state, p, input).catch(() => ({ hit: false as const }));
          const value = taken.hit ? taken.value : await runCompiled(state, p, args, tools, registry);
          if (!taken.hit) markStretchServed(state, p, input);
          return value;
        } catch (err) {
          if (state.opts.failOpen === false) throw err;
          const first = (p.sequence ?? [])[0];
          const canReplay = (p.sequence ?? []).every((n) => isReadName(n)) && !!first && first in tools;
          if (!isDeopt(err)) {
            return canReplay
              ? (typeof tools[first!] === "function" ? { description: first!, execute: tools[first!] } : tools[first!]!).execute(args)
              : { eden: "deopt", reason: err instanceof Error ? err.message : String(err) };
          }
          if (!isReplaySafe(err) && !(p.sequence ?? []).every((n) => isReadName(n))) {
            return { eden: "deopt", reason: (err as Error).message };
          }
          if (canReplay) return (typeof tools[first!] === "function" ? { description: first!, execute: tools[first!] } : tools[first!]!).execute(args);
          return { eden: "deopt", reason: (err as Error).message };
        } finally {
          safely(() => turnBoundary(state, { lastTool: p.name, lastArgs: args, input: args }), null);
        }
      },
    };
    compiledCache.set(p.id, { program: p, def });
    return def;
  };

  for (const [name, def] of Object.entries(tools)) {
    const spec = typeof def === "function" ? { description: name, execute: def } : def;
    const runOne = async (args: Record<string, unknown>, selfId: number, startedAt: number): Promise<unknown> => {
        if (state.opts.baseUrl && calls % PULL_EVERY === 0) void pullLive(state);
        safely(() => noteJitUsed(state.jit, [name]), undefined);
        const live = state.programs.length === 0 ? NO_LIVE : filterCanary(state.programs.filter((p) => p.manifest && !state.pausedIds.has(p.id)), state.sessionId);
        const owner = { id: selfId, startedAt, invocations };

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
        prefixHits.sort((a, b) => (b.p.sequence?.length ?? 0) - (a.p.sequence?.length ?? 0));
        const hit = prefixHits[0];
        if (hit) {
          if (enforcementEnabled(state.opts)) {
            const guard = safely(
              () => decideGuard({ name, run, live, opts: state.opts, now: performance.now() }),
              null,
            );
            if (guard && (guard.action === "halt" || guard.action === "block")) {
              emit(run.events[0]?.args, owner);
              return { eden: guard.action === "block" ? "blocked" : "halted", reason: guard.reason, ...(guard.detail ? { detail: guard.detail } : {}) };
            }
          }
          const sessionArmed = safely(() => {
            const t = performance.now();
            for (const [, armed] of store.all(session, t)) {
              if (armed.programId !== hit.p.id) continue;
              if (((armed, cur) => { if (eq(cur, armed.input)) return true; const rec = armed.input as Record<string, unknown> | null; if (!rec || typeof rec !== "object") return false; const keys = Object.keys(cur); return keys.length > 0 && keys.every((k) => k in rec && eq(cur[k], rec[k])); })(armed, hit.input as Record<string, unknown>)) return true;
            }
            return false;
          }, false);
          const fleetHit = safely((): FleetHit | undefined => {
            if (!fleetId || !isProgramReadOnly(hit.p)) return undefined;
            const t = performance.now();
            for (const found of store.allFleet(fleetId, t)) {
              if (found.armed.programId !== hit.p.id) continue;
              if (((armed, cur) => { if (eq(cur, armed.input)) return true; const rec = armed.input as Record<string, unknown> | null; if (!rec || typeof rec !== "object") return false; const keys = Object.keys(cur); return keys.length > 0 && keys.every((k) => k in rec && eq(cur[k], rec[k])); })(found.armed, hit.input as Record<string, unknown>)) return found;
            }
            return undefined;
          }, undefined);
          if (fleetHit) {
            const ok = await Promise.race([
              fleetHit.armed.settled,
              new Promise<boolean>((r) => setTimeout(() => r(false), wrapTimeoutMs(state.opts.timeoutMs))),
            ]);
            if (ok) {
              if (!(isReadName(name) && staleRead(state, args, fleetHit.armed))) {
              skipAsShared(fleetHit.armed, name, selfId);
              return { eden: "steered", skipped: name };
              }
            }
          } else if (!sessionArmed) {
          if (run.events.length) emit(run.events[0]?.args, owner);
          const pair = safely(() => armTail(hit.p, hit.input), null);
          if (pair) {
          const { armed } = pair;
          try {
            if (!isProgramReadOnly(hit.p)) discardSpeculation(state);
            const taken = await takeSpeculation(state, hit.p, hit.input).catch(() => ({ hit: false as const }));
            const value = taken.hit
              ? taken.value
              : await runCompiled(state, hit.p, hit.input, tools, registry);
            if (!taken.hit) markStretchServed(state, hit.p, hit.input);
            armed.armedAt = performance.now();
            armed.armedAtCall = calls;
            const compiled = [...state.receipts].reverse().find((r) => r.toolId === hit.p.id && r.ok);
            if (compiled) armedReceipts.set(armed, compiled);
            try {
              armed.closed = true;
              armed.resolveSettled(true);
            } catch {}
            if (!armed.rest.size) emit(hit.input, owner);
            return value;
          } catch (err) {
            armed.headErr = err;
            try {
              armed.closed = true;
              armed.resolveSettled(false);
            } catch {}
            if (state.opts.failOpen === false) throw err;
            void pullLive(state);
            const touched = isDeopt(err) && !isReplaySafe(err);
            const unknownState = !isDeopt(err);
            if ((touched || unknownState) && !(hit.p.sequence ?? []).every((n) => isReadName(n))) {
              return { eden: "deopt", reason: err instanceof Error ? err.message : String(err) };
            }
          }
          }
          }
        }

        const now = performance.now();
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
            return ((armed, cur) => { if (eq(cur, armed.input)) return true; const rec = armed.input as Record<string, unknown> | null; if (!rec || typeof rec !== "object") return false; const keys = Object.keys(cur); return keys.length > 0 && keys.every((k) => k in rec && eq(cur[k], rec[k])); })(armed, cur as Record<string, unknown>);
          }, false);
          if (!inputMatches) continue;
          safely(() => {
            armed.matchedCalls++;
          }, undefined);
          const remaining = safely(() => armed.rest.get(name), 0);
          const fleetServed =
            armed.readOnly === true &&
            !!fleetId &&
            armed.fleetId === fleetId &&
            (armed.served?.has(name) === true);
          if (!remaining && !fleetServed) continue;
          const ok = await Promise.race([
            armed.settled,
            new Promise<boolean>((r) => setTimeout(() => r(false), wrapTimeoutMs(state.opts.timeoutMs))),
          ]);
          if (ok) {
            if (isReadName(name) && staleRead(state, args, armed)) continue;
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
              const left = armed.rest.get(name)!;
              if (left > 1) armed.rest.set(name, left - 1);
              else armed.rest.delete(name);
            }, undefined);
            skipAsShared(armed, name, selfId);
            if (!armed.rest.size) {
              if (!(armed.readOnly && armed.fleetId)) store.delete(armSession, id);
              emit(armed.input, owner);
            }
            steeredSkip = true;
            skipArmed = armed;
            break;
          }
          const doneByCompiled = safely(() => {
            const e = armed.headErr;
            return isDeopt(e) && Array.isArray((e as { toolCalls?: string[] }).toolCalls)
              ? (e as { toolCalls: string[] }).toolCalls.includes(name)
              : null;
          }, null);
          if (doneByCompiled === true) {
            safely(() => {
              const left = armed.rest.get(name)!;
              if (left > 1) armed.rest.set(name, left - 1);
              else armed.rest.delete(name);
              if (!armed.rest.size) store.delete(armSession, id);
            }, undefined);
            steeredSkip = true;
            break;
          }
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

        if (enforcementEnabled(state.opts)) {
          const guard = safely(() => decideGuard({ name, run, live, opts: state.opts, now }), null);
          if (guard && guard.action !== "steer") {
            emit(run.events[0]?.args, owner);
            return { eden: guard.action === "block" ? "blocked" : "halted", reason: guard.reason, ...(guard.detail ? { detail: guard.detail } : {}) };
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
                } catch {}
                if (!armed.rest.size) emit(steeredIn, owner);
                return value;
              } catch (err) {
                armed.headErr = err;
                try {
                  armed.closed = true;
                  armed.resolveSettled(false);
                } catch {}
                emit(run.events[0]?.args, owner);
                const touched = isDeopt(err) && !isReplaySafe(err);
                if (!((guard.program.sequence ?? []).every((n) => isReadName(n)) && !touched)) {
                  return { eden: "halted", reason: guard.reason };
                }
              }
            }
          }
        }

        const t0 = performance.now();
        const envSteps = Number(process.env.EDEN_MAX_STEPS);
        if (enforcementEnabled(state.opts) && run.rawExecuted >= (Number.isFinite(envSteps) && envSteps > 0 ? Math.min(10_000, Math.max(10, Math.floor(envSteps))) : MAX_RUN_STEPS)) {
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
        const selfId = ++nextInvocationId;
        const rec: Invocation = { startedAt: performance.now(), done: false, finishedAt: 0 };
        invocations.set(selfId, rec);
        if (invocations.size > 256) {
          for (const [id, rec] of invocations) {
            if (invocations.size <= 128) break;
            if (rec.done) invocations.delete(id);
          }
        }
        try {
          const value = await runOne(args, selfId, rec.startedAt);
          safely(() => turnBoundary(state, { lastTool: name, lastArgs: args, input: args }), null);
          return value;
        } finally {
          rec.done = true;
          rec.finishedAt = performance.now();
        }
      },
    };
  }

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
      if (typeof prop === "string" && filterCanary(state.programs.filter((p) => p.manifest && !state.pausedIds.has(p.id)), state.sessionId).some((x) => x.name === prop)) return true;
      return prop in target;
    },
    ownKeys(target) {
      const extra = filterCanary(state.programs.filter((p) => p.manifest && !state.pausedIds.has(p.id)), state.sessionId).map((p) => p.name);
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
