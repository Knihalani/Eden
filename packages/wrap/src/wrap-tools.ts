import type { IslandCaller, StretchProgram, ToolRegistry } from "@eden/ir";
import { inDistribution, redact, eq } from "@eden/ir";
import { DeoptError, isDeopt, registryFrom, runProgram } from "@eden/runtime";
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

function isEarlyDeopt(err: unknown): boolean {
  const reason = err instanceof DeoptError ? err.reason : String((err as Error)?.message ?? "");
  return /input not in witness envelope|no island caller|island .+ needs an island caller/.test(reason);
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
  const skipRest = new Map<string, { rest: Set<string>; input: Record<string, unknown>; programId: string }>();
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
          try {
            const value = await runCompiled(state, hit.p, hit.input, tools, registry);
            const rest = (hit.p.sequence ?? []).slice(1);
            skipRest.set(`${hit.p.id}#${++skipSeq}`, { rest: new Set(rest), input: hit.input, programId: hit.p.id });
            emitTrace(state, run, hit.input);
            return value;
          } catch (err) {
            for (const [k, v] of skipRest) if (v.programId === hit.p.id) skipRest.delete(k);
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
          if (!armed.rest.has(name)) continue;
          const liveP = live.find((p) => p.id === armed.programId);
          const cur = liveP ? extractInput(liveP, args) : args;
          if (!eq(cur, armed.input)) continue;
          armed.rest.delete(name);
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
