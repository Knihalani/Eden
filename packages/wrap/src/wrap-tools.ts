import type { IslandCaller, StretchProgram, ToolRegistry } from "@eden/ir";
import { inDistribution, redact, eq } from "@eden/ir";
import { DeoptError, isDeopt, isReplaySafe, registryFrom, runProgram } from "@eden/runtime";
import { asToolDef, emptyRun, type EdenOpts, type Receipt, type ToolDef, type ToolsIn } from "./types";
import { extractInput } from "./steer";
import type { StretchTrace } from "@eden/ir";

const MAX_TRACES = 2000;
const PULL_EVERY = 24;
const MAX_OUTBOX = 64;
const MAX_POST_TRIES = 5;

export type WrapState = {
  opts: EdenOpts;
  programs: StretchProgram[];
  traces: StretchTrace[];
  receipts: Receipt[];
  pulls?: number;
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
  return { opts: { failOpen: true, ...opts }, programs: [...(opts.programs ?? [])], traces: [], receipts: [], pulls: 0 };
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
  } catch {
    /* fail-open */
  }
}

export async function runCompiled(
  state: WrapState,
  program: StretchProgram,
  input: Record<string, unknown>,
  tools: ToolsIn,
  registry?: ToolRegistry,
): Promise<unknown> {
  if (!inDistribution(program, input)) throw new DeoptError("input not in witness envelope");
  const island: IslandCaller =
    state.opts.island ??
    (async () => {
      throw new DeoptError("no island caller");
    });
  try {
    const result = await runProgram(program, input, {
      registry:
        registry ??
        registryFrom(Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, asToolDef(k, v).execute]))),
      island,
      llmCents: state.opts.llmCents ?? 1,
      checkEnvelope: false,
      timeoutMs: wrapTimeoutMs(state.opts.timeoutMs),
    });
    const receipt: Receipt = {
      toolId: program.id,
      version: program.version,
      ms: result.stats.ms,
      llmCalls: result.stats.llmCalls,
      cents: result.stats.cents,
      ok: true,
    };
    state.receipts.push(receipt);
    if (state.receipts.length > MAX_TRACES) state.receipts.splice(0, state.receipts.length - MAX_TRACES);
    state.opts.onReceipt?.(receipt);
    post(state, "/v1/receipts", receipt);
    return result.value;
  } catch (err) {
    const receipt: Receipt = {
      toolId: program.id,
      version: program.version,
      ms: 0,
      llmCalls: 0,
      cents: 0,
      ok: false,
    };
    state.receipts.push(receipt);
    state.opts.onReceipt?.(receipt);
    post(state, "/v1/receipts", receipt);
    throw err;
  }
}

function emitTrace(state: WrapState, run: ReturnType<typeof emptyRun>, input?: Record<string, unknown>): void {
  if (!run.events.length) return;
  const trace: StretchTrace = {
    id: crypto.randomUUID(),
    events: run.events.map((e) => ({
      ...e,
      args: redact(e.args) as Record<string, unknown>,
      result: redact(e.result),
    })),
    input: (redact(input ?? run.events[0]?.args ?? {}) as Record<string, unknown>) ?? {},
    llmCalls: Math.max(run.llmCalls, run.events.length),
    duration_ms: performance.now() - run.t0,
    cost_cents: Math.max(run.cost, run.events.length),
    complete: run.events.at(-1)?.ok,
  };
  state.traces.push(trace);
  if (state.traces.length > MAX_TRACES) state.traces.splice(0, state.traces.length - MAX_TRACES);
  state.opts.onTrace?.(trace);
  post(state, "/v1/traces", trace);
  run.events = [];
  run.llmCalls = 0;
  run.cost = 0;
  run.t0 = performance.now();
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
  return state.programs.filter((p) => p.manifest);
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
  const run = emptyRun();
  // `rest` counts how many raw calls of each tool the compiled run has already
  // performed on the caller's behalf, so a sequence that calls one tool twice
  // suppresses both raw repeats rather than only the first.
  const skipRest = new Map<
    string,
    { rest: Map<string, number>; input: Record<string, unknown>; programId: string }
  >();
  const registry = registryFrom(
    Object.fromEntries(Object.entries(tools).map(([k, v]) => [k, asToolDef(k, v).execute])),
  );
  const wrapped: Record<string, ToolDef> = {};
  const compiledCache = new Map<string, ToolDef>();
  let calls = 0;
  let skipSeq = 0;

  const compiledFor = (name: string): ToolDef | undefined => {
    const p = state.programs.find((x) => x.manifest && (x.name === name || x.id === name));
    if (!p) return undefined;
    let def = compiledCache.get(p.id);
    if (!def) {
      def = compiledDef(state, p, tools, registry);
      compiledCache.set(p.id, def);
    }
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
          .filter(({ p, input }) => inDistribution(p, input))
          .sort((a, b) => (b.p.sequence?.length ?? 0) - (a.p.sequence?.length ?? 0));
        const hit = prefixHits[0];
        if (hit) {
          // Armed *before* the await, not after. Real hosts issue a turn's tool
          // calls in parallel, and while the compiled program was running the
          // map was still empty — so a sibling call naming a later step of the
          // same stretch sailed past the skip check and executed for real,
          // duplicating whatever the compiled leg was in the middle of doing.
          const armKey = `${hit.p.id}#${++skipSeq}`;
          skipRest.set(armKey, {
            rest: restCounts(hit.p),
            input: hit.input,
            programId: hit.p.id,
          });
          try {
            const value = await runCompiled(state, hit.p, hit.input, tools, registry);
            emitTrace(state, run, hit.input);
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

        for (const [id, armed] of skipRest) {
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
          if (!armed.rest.size) skipRest.delete(id);
          return { eden: "steered", skipped: name };
        }

        const t0 = performance.now();
        try {
          const result = await spec.execute(args);
          run.events.push({ name, args, result, ok: true, duration_ms: performance.now() - t0 });
          run.llmCalls += 1;
          run.cost += state.opts.llmCents ?? 1;
          const last = live.some((p) => (p.sequence ?? []).at(-1) === name);
          if (last || /^(notify|complete|finalize|done)$/i.test(name) || run.events.length >= 12) {
            emitTrace(state, run, run.events[0]?.args);
          }
          return result;
        } catch (err) {
          run.events.push({ name, args, ok: false, duration_ms: performance.now() - t0 });
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
