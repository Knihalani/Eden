import type { IslandCaller, StretchProgram, ToolRegistry } from "@eden/ir";
import {
  evidenceLedger,
  firstWarningIndex,
  inDistribution,
  judgeGrounding,
  postWarningSpend,
  redact,
  eq,
  takeSignals,
  usableTrace,
  hashStretch,
  liveTimeSavedMs,
} from "@eden/ir";
import { DeoptError, isDeopt, isReplaySafe, registryFrom, runProgram } from "@eden/runtime";
import { asToolDef, emptyRun, type EdenOpts, type Receipt, type RunRecorder, type ToolDef, type ToolsIn } from "./types";
import { extractInput } from "./steer";
import type { StretchTrace } from "@eden/ir";
import { resetUsage } from "./usage";
import { decideGuard, requiredChecks } from "./guard";

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
  pulls?: number;
  run: RunRecorder;
  pausedIds: Set<string>;
};

type OutboxJob = { path: string; body: unknown; tries: number };

const outboxes = new WeakMap<WrapState, OutboxJob[]>();
const flushers = new WeakMap<WrapState, ReturnType<typeof setTimeout>>();

export function wrapTimeoutMs(explicit?: number): number {
  const env = Number(process.env.EDEN_TIMEOUT_MS);
  const raw = explicit && explicit > 0 ? explicit : Number.isFinite(env) && env > 0 ? env : 60_000;
  return Math.min(300_000, Math.max(1, raw));
}

export function createState(opts: EdenOpts = {}): WrapState {
  return { opts: { failOpen: true, ...opts }, programs: [...(opts.programs ?? [])], traces: [], receipts: [], pulls: 0, run: emptyRun(), pausedIds: new Set() };
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

type Armed = {
  rest: Map<string, number>;
  input: Record<string, unknown>;
  programId: string;
  /** Monotonic (performance.now), so an NTP step cannot make this immortal. */
  armedAt: number;
  armedAtCall: number;
  callBudget: number;
};

/**
 * How long an arming may suppress raw calls.
 *
 * The agent finishes the rest of a stretch within a few turns of starting it,
 * so these are generous. What they rule out is an arming surviving long enough
 * to swallow an unrelated later mutation, which is the failure that actually
 * loses a user's work.
 *
 * The call budget is counted *on top of* the tail the arming is there to
 * absorb. Every wrapped execute increments the counter, including the
 * suppressed ones, so a flat budget was being spent by the very calls it was
 * meant to cover: any program whose tail ran longer than the budget disarmed
 * partway through and executed the remainder for real. A 40-write program
 * performed 40 writes compiled and then 8 more raw.
 */
const ARM_TTL_MS = 60_000;
const ARM_SLACK_CALLS = 32;
const ARM_MAX_ENTRIES = 64;

function armExpired(a: Armed, now: number, calls: number): boolean {
  return now - a.armedAt > ARM_TTL_MS || calls - a.armedAtCall > a.callBudget;
}

/** Total number of raw calls this arming expects to absorb. */
function totalRest(rest: Map<string, number>): number {
  let n = 0;
  for (const c of rest.values()) n += c;
  return n;
}

/**
 * Keep the arming map bounded without throwing away armings that are still
 * doing their job.
 *
 * Eviction was unconditionally oldest-first, so a burst of distinct inputs
 * pushed out entries that had not expired and whose tails had not run yet —
 * and every one of those tails then executed for real against a tool the
 * compiled program had already called. Expired entries are swept first and
 * are almost always enough; oldest-first is the fallback that keeps the hard
 * bound.
 */
function evictArmings(skipRest: Map<string, Armed>, calls: number): void {
  if (skipRest.size <= ARM_MAX_ENTRIES) return;
  const now = performance.now();
  for (const [id, a] of skipRest) {
    if (skipRest.size <= ARM_MAX_ENTRIES) return;
    if (armExpired(a, now, calls)) skipRest.delete(id);
  }
  // Still over after sweeping: give up the armings with the least budget left,
  // which are the ones closest to retiring anyway. Insertion order is a poor
  // proxy for that once programs have tails of different lengths — the oldest
  // entry may be the one with the longest tail still to absorb.
  while (skipRest.size > ARM_MAX_ENTRIES) {
    let victim: string | undefined;
    let least = Infinity;
    for (const [id, a] of skipRest) {
      const left = a.callBudget - (calls - a.armedAtCall);
      if (left < least) {
        least = left;
        victim = id;
      }
    }
    if (victim === undefined) return;
    skipRest.delete(victim);
  }
}

/** Tail of the program's sequence, as tool name -> number of calls made. */
function restCounts(program: StretchProgram): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of (program.sequence ?? []).slice(1)) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
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

async function sendPost(state: WrapState, path: string, body: unknown): Promise<boolean> {
  const base = state.opts.baseUrl;
  const key = wrapAuth(state);
  if (!base || !key) return true;
  const fn = state.opts.fetch ?? fetch;
  try {
    const r = await fn(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
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
    if (q.length >= MAX_OUTBOX) return;
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
    const r = await fn(`${base.replace(/\/$/, "")}/v1/tools`, { headers: { authorization: `Bearer ${key}` } });
    if (!r.ok) return;
    const j = (await r.json()) as { tools?: Array<{ program: StretchProgram; state: string }> };
    const rows = j.tools ?? [];
    const pulled = rows.filter((t) => t.state === "live").map((t) => t.program);
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
  stats: { ms: number; llmCalls: number; cents: number; skipped: string[]; stepsRun?: number; early?: boolean; deoptReason?: string },
  err?: unknown,
): Receipt {
  const deopt = isDeopt(err);
  const early = deopt ? isReplaySafe(err) : Boolean(stats.early);
  const stepsRun = deopt ? err.stepsRun : (stats.stepsRun ?? stats.skipped.length);
  const timeSavedMs = liveTimeSavedMs(program, stats.ms, ok);
  let outcome: Receipt["outcome"] = ok ? "ok" : deopt ? "deopt" : "failed";
  if (!ok && stats.skipped.length) outcome = "skipped";
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
  return receipt;
}

export async function runCompiled(
  state: WrapState,
  program: StretchProgram,
  input: Record<string, unknown>,
  tools: ToolsIn,
  registry?: ToolRegistry,
): Promise<unknown> {
  const t0 = performance.now();
  const island: IslandCaller =
    state.opts.island ??
    (async () => {
      throw new DeoptError("no island caller");
    });
  try {
    // Inside the try so an envelope miss still writes a deopt receipt (51).
    if (!inDistribution(program, input)) throw new DeoptError("input not in witness envelope");
    const result = await runProgram(program, input, {
      registry:
        registry ??
        registryFrom(Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, asToolDef(k, v).execute]))),
      island,
      llmCents: state.opts.llmCents ?? 1,
      checkEnvelope: false,
      timeoutMs: wrapTimeoutMs(state.opts.timeoutMs),
    });
    const receipt = compiledReceipt(program, true, result.stats);
    pushCapped(state.receipts, receipt);
    notifyHost(() => state.opts.onReceipt?.(receipt));
    post(state, "/v1/receipts", receipt);
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
 * Flush the buffered events as a trace.
 *
 * This runs inside the success path of every wrapped call, so it is wrapped
 * whole: anything it throws would otherwise be caught by the caller's error
 * branch, recorded as a second bogus ok:false event for a call that worked,
 * and rethrown at the agent. The buffer is reset either way — a trace we could
 * not build is not a trace worth retrying against the same events forever.
 */
function emitTrace(state: WrapState, run: ReturnType<typeof emptyRun>, input?: Record<string, unknown>): void {
  if (!run.events.length) return;
  try {
    buildAndSendTrace(state, run, input);
  } catch {
    /* observing a call must never fail it */
  } finally {
    run.events = [];
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

function buildAndSendTrace(state: WrapState, run: ReturnType<typeof emptyRun>, input?: Record<string, unknown>): void {
  const lastOk = lastOkResult(run.events);
  const output = lastOk ?? run.output;
  const trace: StretchTrace = {
    // Events were redacted at push time, so what is buffered is already a
    // snapshot: holding the caller's live objects until flush meant a caller
    // that reuses its args record between turns rewrote the history the
    // compiler learns from, and moved the redaction window to the wrong
    // moment.
    id: crypto.randomUUID(),
    events: run.events,
    input: (redact(input ?? run.events[0]?.args ?? {}) as Record<string, unknown>) ?? {},
    output: output === undefined ? undefined : redact(output),
    llmCalls: run.llmCalls,
    duration_ms: performance.now() - run.t0,
    cost_cents: run.cost,
    complete: run.events.at(-1)?.ok,
    ...(run.measured ? { prompt_tokens: run.prompt_tokens, completion_tokens: run.completion_tokens } : {}),
    ...(run.warnings.length ? { warnings: run.warnings.slice() } : {}),
    ...(run.firstWarningAt != null ? { firstWarningAt: run.firstWarningAt } : {}),
    ...(run.evidence ? { evidence: run.evidence } : {}),
    ...(run.events.some((e) => e.skipped) ? { skipped: run.events.filter((e) => e.skipped).map((e) => e.name) } : {}),
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
  pushCapped(state.traces, trace);
  notifyHost(() => state.opts.onTrace?.(trace));
  post(state, "/v1/traces", trace);
}

function noteSignals(state: WrapState, run: ReturnType<typeof emptyRun>): void {
  if (run.warnings.length >= MAX_WARNINGS) return;
  const budget = {
    duration_ms: Math.max(0, performance.now() - run.t0),
    llmCalls: run.llmCalls,
    ...(run.measured ? { prompt_tokens: run.prompt_tokens, completion_tokens: run.completion_tokens } : {}),
  };
  const required = requiredChecks(liveOf(state), run.events);
  const ledger = evidenceLedger(run.events, required);
  const fresh = takeSignals(run.events, budget, run.seenSignals, required, ledger);
  for (const w of fresh) {
    if (run.warnings.length >= MAX_WARNINGS) break;
    run.warnings.push(w);
    notifyHost(() => state.opts.onWarning?.(w));
  }
  run.evidence = ledger;
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
        return await runCompiled(state, p, args, tools, registry);
      } catch (err) {
        if (state.opts.failOpen === false) throw err;
        if (!isDeopt(err)) throw err;
        if (!isEarlyDeopt(err)) return { eden: "deopt", reason: (err as Error).message };
        const first = (p.sequence ?? [])[0];
        if (!first || !(first in tools)) throw err;
        return asToolDef(first, tools[first]!).execute(args);
      }
    },
  };
}

function liveOf(state: WrapState): StretchProgram[] {
  return state.programs.filter((p) => p.manifest && !state.pausedIds.has(p.id));
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
  // `rest` counts how many raw calls of each tool the compiled run has already
  // performed on the caller's behalf, so a sequence that calls one tool twice
  // suppresses both raw repeats rather than only the first.
  //
  // `armedAt`/`armedAtCall` bound how long an arming can act. Nothing used to
  // retire them: an entry stayed live for the life of the process, so a write
  // the agent made much later — a genuinely different mutation that happened to
  // carry the same id — was still silently swallowed, and the map (plus the
  // linear scan over it on every single tool call) grew without limit.
  const skipRest = new Map<string, Armed>();
  const registry = registryFrom(
    Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, asToolDef(k, v).execute])),
  );
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

  const compiledFor = (name: string): ToolDef | undefined => {
    const p = state.programs.find((x) => x.manifest && (x.name === name || x.id === name));
    if (!p) return undefined;
    const cached = compiledCache.get(p.id);
    if (cached && cached.program === p) return cached.def;
    const def = compiledDef(state, p, tools, registry);
    compiledCache.set(p.id, { program: p, def });
    return def;
  };

  for (const [name, def] of Object.entries(tools)) {
    const spec = asToolDef(name, def);
    wrapped[name] = {
      ...spec,
      execute: async (args: Record<string, unknown>) => {
        calls++;
        if (state.opts.baseUrl && calls % PULL_EVERY === 0) void pullLive(state);
        const live = liveOf(state);

        const prefixHits = live
          .filter((p) => (p.sequence ?? [])[0] === name)
          .map((p) => ({ p, input: extractInput(p, args) }))
          .filter(({ p, input }) => inDistribution(p, input));
        if (prefixHits.length > 1) {
          prefixHits.sort((a, b) => (b.p.sequence?.length ?? 0) - (a.p.sequence?.length ?? 0));
        }
        const hit = prefixHits[0];
        const armTail = (program: StretchProgram, input: Record<string, unknown>): { key: string; armed: Armed } => {
          const key = `${program.id}#${++skipSeq}`;
          const rest = restCounts(program);
          const armed: Armed = {
            rest,
            input,
            programId: program.id,
            armedAt: performance.now(),
            armedAtCall: calls,
            callBudget: totalRest(rest) + ARM_SLACK_CALLS,
          };
          skipRest.set(key, armed);
          evictArmings(skipRest, calls);
          return { key, armed };
        };
        if (hit) {
          // Armed *before* the await, not after. Real hosts issue a turn's tool
          // calls in parallel, and while the compiled program was running the
          // map was still empty — so a sibling call naming a later step of the
          // same stretch sailed past the skip check and executed for real,
          // duplicating whatever the compiled leg was in the middle of doing.
          if (run.events.length) emitTrace(state, run, run.events[0]?.args);
          const { key: armKey, armed } = armTail(hit.p, hit.input);
          try {
            const value = await runCompiled(state, hit.p, hit.input, tools, registry);
            // Re-stamp now the run has actually finished. The TTL was started
            // before the await, but wrapTimeoutMs permits a compiled program
            // up to 300s — five times the TTL — so a legitimately slow run
            // returned to an arming that had already expired and every raw
            // tail call went straight through to the real tool. The entry
            // still has to be *inserted* early, for the parallel-sibling race
            // above; only the clock starts late.
            armed.armedAt = performance.now();
            armed.armedAtCall = calls;
            // Flush after the steered tail is absorbed so skipped names land
            // on this stretch instead of leaking into the next ticket.
            if (!armed.rest.size) emitTrace(state, run, hit.input);
            return value;
          } catch (err) {
            // Only this invocation's arming. The previous code deleted every
            // arming for the program, so one failed run for input B disarmed a
            // successful run for input A and let A's raw tail execute a second
            // time.
            skipRest.delete(armKey);
            if (state.opts.failOpen === false) throw err;
            if (!isDeopt(err)) throw err;
            if (!isEarlyDeopt(err)) {
              void pullLive(state);
              return { eden: "deopt", reason: (err as Error).message };
            }
            void pullLive(state);
          }
        }

        const now = performance.now();
        for (const [id, armed] of skipRest) {
          if (armExpired(armed, now, calls)) {
            skipRest.delete(id);
            continue;
          }
          const remaining = armed.rest.get(name);
          if (!remaining) continue;
          const liveP = live.find((p) => p.id === armed.programId);
          const cur = liveP ? extractInput(liveP, args) : args;
          if (!eq(cur, armed.input)) continue;
          // Decrement rather than delete: a sequence may call the same tool
          // more than once, and the compiled program performed each of those.
          // Treating the tail as a Set swallowed only the first raw repeat and
          // let every later one execute again.
          if (remaining > 1) armed.rest.set(name, remaining - 1);
          else armed.rest.delete(name);
          run.events.push({
            name,
            args: {},
            ok: true,
            skipped: true,
            duration_ms: 0,
          });
          noteSignals(state, run);
          if (!armed.rest.size) {
            skipRest.delete(id);
            emitTrace(state, run, armed.input);
          }
          return { eden: "steered", skipped: name };
        }

        const guard = decideGuard({ name, run, live, opts: state.opts, now });
        if (guard) {
          if (guard.action === "steer") {
            const steeredIn = extractInput(guard.program, args);
            const { key: armKey, armed } = armTail(guard.program, steeredIn);
            try {
              const value = await runCompiled(state, guard.program, steeredIn, tools, registry);
              armed.armedAt = performance.now();
              armed.armedAtCall = calls;
              if (!armed.rest.size) emitTrace(state, run, steeredIn);
              return value;
            } catch {
              skipRest.delete(armKey);
              emitTrace(state, run, run.events[0]?.args);
              return { eden: "halted", reason: guard.reason };
            }
          }
          emitTrace(state, run, run.events[0]?.args);
          return { eden: guard.action === "block" ? "blocked" : "halted", reason: guard.reason };
        }

        const t0 = performance.now();
        try {
          const result = await spec.execute(args);
          // Redact here, not at flush. These stay buffered for up to 12 events,
          // and holding live references to the caller's objects meant an agent
          // loop that reuses one args record per turn rewrote already-recorded
          // history — the witnesses programs get compiled from were of calls
          // that never happened. It also kept arbitrary result graphs alive.
          run.events.push({
            name,
            args: redact(args) as Record<string, unknown>,
            result: redact(result),
            ok: true,
            duration_ms: performance.now() - t0,
          });
          noteSignals(state, run);
          const last = live.some((p) => (p.sequence ?? []).at(-1) === name);
          if (last || /^(notify|complete|finalize|done)$/i.test(name) || run.events.length >= 12) {
            emitTrace(state, run, run.events[0]?.args);
          }
          return result;
        } catch (err) {
          run.events.push({ name, args: redact(args) as Record<string, unknown>, ok: false, duration_ms: performance.now() - t0 });
          noteSignals(state, run);
          throw err;
        }
      },
    };
  }

  return new Proxy(wrapped, {
    get(target, prop, recv) {
      if (typeof prop !== "string") return Reflect.get(target, prop, recv);
      if (prop in target) return target[prop];
      return compiledFor(prop);
    },
    has(target, prop) {
      if (typeof prop === "string" && state.programs.some((x) => x.manifest && x.name === prop)) return true;
      return prop in target;
    },
    ownKeys(target) {
      const extra = state.programs.filter((p) => p.manifest).map((p) => p.name);
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
