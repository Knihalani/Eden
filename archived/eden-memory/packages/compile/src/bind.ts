import type { Binding, StretchTrace, TraceEvent } from "@eden/ir";
import {
  canonicalize,
  containsRedaction,
  eq,
  flatten,
  getPath,
  interpolateShell,
  interpolateSlots,
  isWeakValue,
} from "@eden/ir";
export { isCheckName, isIslandName, isMutating, isReadName } from "@eden/ir";

type Producer = { kind: "input"; path: string } | { kind: "from"; step: string; path: string };

/**
 * How a string template is filled: interpolateSlots, or interpolateShell for a
 * shell command line. A template is verified against its witnesses with the
 * renderer the runtime will run it with, so what is verified is what runs.
 */
type Render = (expr: string, record: unknown) => string | null;

type BindOpts = { mutating: boolean; allowExact: boolean; shell?: boolean };

function producersFor(
  value: unknown,
  inputFlat: Map<string, unknown>,
  priorFlats: Array<{ id: string; flat: Map<string, unknown> }>,
): Producer[] {
  const found: Producer[] = [];
  const weak = isWeakValue(value);
  const primitive = value == null || typeof value !== "object";
  for (const [path, v] of inputFlat) {
    if (weak && !path) continue;
    if (primitive ? v === value : eq(v, value)) found.push({ kind: "input", path });
  }
  if (weak) return found;
  for (const step of priorFlats) {
    for (const [path, v] of step.flat) {
      if (primitive ? v === value : eq(v, value)) found.push({ kind: "from", step: step.id, path });
    }
  }
  return found;
}

function producerKey(p: Producer): string {
  return p.kind === "input" ? `input:${p.path}` : `from:${p.step}:${p.path}`;
}

function sameValue(candidate: unknown, value: unknown, primitive: boolean): boolean {
  return primitive ? candidate === value : eq(candidate, value);
}

/**
 * Does this producer still yield `value` for one particular witness?
 *
 * The verification half of the intersection. Mirrors producersFor() exactly,
 * including its treatment of weak values — a weak value gets no `from`
 * producers and no root-path `input` producer — but answers for a single
 * candidate with a map lookup instead of enumerating everything the witness
 * could possibly have produced.
 */
function producerHolds(
  p: Producer,
  value: unknown,
  inputFlat: Map<string, unknown>,
  priors: Array<{ id: string; flat: Map<string, unknown> }>,
): boolean {
  const weak = isWeakValue(value);
  const primitive = value == null || typeof value !== "object";
  if (p.kind === "input") {
    if (weak && !p.path) return false;
    if (!inputFlat.has(p.path)) return false;
    return sameValue(inputFlat.get(p.path), value, primitive);
  }
  if (weak) return false;
  // The same tool can appear more than once among the priors, so any occurrence
  // producing the value counts — matching producersFor(), whose duplicate
  // entries collapse onto one key.
  for (const step of priors) {
    if (step.id !== p.step) continue;
    if (step.flat.has(p.path) && sameValue(step.flat.get(p.path), value, primitive)) return true;
  }
  return false;
}

function rankProducers(candidates: Producer[]): Producer | null {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => {
    if (a.kind === "input" && b.kind !== "input") return -1;
    if (b.kind === "input" && a.kind !== "input") return 1;
    return producerKey(a).length - producerKey(b).length;
  })[0]!;
}

function agreement(values: unknown[]): number {
  if (!values.length) return 0;
  const counts = new Map<string, number>();
  for (const v of values) {
    const k = canonicalize(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / values.length;
}

function inputRecord(flat: Map<string, unknown>): Record<string, unknown> {
  const root = flat.get("");
  if (root && typeof root === "object" && !Array.isArray(root)) return root as Record<string, unknown>;
  return Object.fromEntries([...flat].filter(([k]) => k));
}

/**
 * Multi-slot whitespace-token template inference.
 *
 * Every witness must tokenize to the same width (skeleton clustering
 * guarantees this for shell steps); each varying token position resolves to
 * ONE record key whose value equals that witness's token. All slots must
 * resolve against the SAME source record — the binding interpolates from a
 * single `of` — and the finished template must reproduce every witness
 * verbatim before it is trusted.
 */
/** Shared quote wrapping a whole token column (`'R-1'` vs input `R-1`). */
function tokenQuote(col: string[]): "'" | '"' | "" {
  if (!col.length) return "";
  const q = col[0]![0];
  if ((q === "'" || q === '"') && col.every((t) => t.length >= 3 && t[0] === q && t.at(-1) === q)) return q;
  return "";
}

function tryTokenTemplate(
  strs: string[],
  inputFlats: Map<string, unknown>[],
  priorFlats: Array<Array<{ id: string; flat: Map<string, unknown>; result: unknown }>>,
  render: Render,
): Binding | null {
  if (!strs.every((v) => typeof v === "string")) return null;
  const rows = strs.map((s) => (s as string).split(/\s+/));
  const w = rows[0]!.length;
  if (w < 2 || !rows.every((r) => r.length === w)) return null;

  type Source = { kind: "input" } | { kind: "from"; id: string };
  const sources: Source[] = [{ kind: "input" }];
  for (const step of priorFlats[0] ?? []) sources.push({ kind: "from", id: step.id });

  const recordFor = (source: Source, j: number): Record<string, unknown> | undefined => {
    if (source.kind === "input") return inputRecord(inputFlats[j]!);
    const step = priorFlats[j]?.find((p) => p.id === source.id);
    const r = step?.result;
    return r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : undefined;
  };

  for (const source of sources) {
    const recs = rows.map((_, j) => recordFor(source, j));
    if (recs.some((r) => !r)) continue;
    const exprTokens = rows[0]!.slice();
    let slots = 0;
    let resolved = true;
    for (let i = 0; i < w && resolved; i++) {
      const col = rows.map((r) => r[i]!);
      if (col.every((t) => t === col[0]!)) continue;
      // Numbers and booleans are legitimate slot sources: interpolate()
      // stringifies them exactly, so --replicas 3 binds {replicas} just like
      // a string would. The old string-only filter refused stretches whose
      // varying parameter was witnessed as a number.
      const keys = new Set<string>();
      for (const r of recs)
        for (const [k, v] of Object.entries(r!))
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") keys.add(k);
      const quote = tokenQuote(col);
      const bare = quote ? col.map((t) => t.slice(1, -1)) : col;
      let hit: string | null = null;
      for (const k of keys) {
        if (bare.every((t, j) => String(recs[j]![k]) === t)) {
          hit = k;
          break;
        }
      }
      if (!hit) {
        resolved = false;
        break;
      }
      exprTokens[i] = quote ? `${quote}{${hit}}${quote}` : `{${hit}}`;
      slots++;
    }
    if (!resolved || !slots) continue;
    const expr = exprTokens.join(" ");
    if (!rows.every((_, j) => render(expr, recs[j]!) === strs[j])) continue;
    return source.kind === "input"
      ? { kind: "transform", fn: "template", expr, of: { kind: "input", path: "" } }
      : { kind: "transform", fn: "template", expr, of: { kind: "from", step: source.id, path: "" } };
  }
  return null;
}

function tryObjectTemplate(
  values: unknown[],
  inputFlats: Map<string, unknown>[],
  priorFlats: Array<Array<{ id: string; flat: Map<string, unknown>; result: unknown }>>,
): Binding | null {
  if (!values.length || !values.every((v) => v && typeof v === "object")) return null;
  if (!values.every((v) => sameKeyShape(v, values[0]))) return null;

  type Source = { kind: "input" } | { kind: "from"; id: string } | { kind: "union"; id: string };
  const singles: Source[] = [{ kind: "input" }];
  for (const step of priorFlats[0] ?? []) singles.push({ kind: "from", id: step.id });

  const recordFor = (source: Source, j: number): Record<string, unknown> | undefined => {
    if (source.kind === "input") return inputRecord(inputFlats[j]!);
    const step = priorFlats[j]?.find((p) => p.id === source.id);
    const r = step?.result;
    const prior = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : undefined;
    if (source.kind === "from") return prior;
    if (!prior) return undefined;
    return { ...inputRecord(inputFlats[j]!), ...prior };
  };

  const attempt = (source: Source): Binding | null => {
    const recs = values.map((_, j) => recordFor(source, j));
    if (recs.some((r) => !r)) return null;
    const flats = recs.map((r) => flattenCached(r));
    const expr = buildJsonSkeleton(values, flats);
    if (!expr) return null;
    const ok = values.every((v, j) => {
      try {
        return eq(JSON.parse(interpolateSlots(expr, recs[j]!)), v);
      } catch {
        return false;
      }
    });
    if (!ok) return null;
    if (source.kind === "input") {
      return { kind: "transform", fn: "template", expr, of: { kind: "input", path: "" } };
    }
    return { kind: "transform", fn: "template", expr, of: { kind: "from", step: source.id, path: "" } };
  };

  for (const source of singles) {
    const hit = attempt(source);
    if (hit) return hit;
  }
  // Mixed: every leaf uniquely reproduces from input ∪ one prior. Two priors
  // that both work is a guess — fail closed. Quoted `"` inside a slot already
  // fails JSON.parse in attempt() and never lands here as a bind.
  const unions: Binding[] = [];
  for (const step of priorFlats[0] ?? []) {
    const hit = attempt({ kind: "union", id: step.id });
    if (hit) unions.push(hit);
  }
  return unions.length === 1 ? unions[0]! : null;
}

function sameKeyShape(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameKeyShape(x, b[i]));
  }
  if (typeof a !== "object") return true;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
  return ka.every((k) => sameKeyShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function buildJsonSkeleton(values: unknown[], flats: Map<string, unknown>[]): string | null {
  let slots = 0;
  const walk = (objs: unknown[]): string | null => {
    const first = objs[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const keys = Object.keys(first as object).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const child = walk(objs.map((o) => (o as Record<string, unknown>)[k]));
        if (child == null) return null;
        parts.push(`${JSON.stringify(k)}:${child}`);
      }
      return `{${parts.join(",")}}`;
    }
    if (Array.isArray(first)) {
      if (!objs.every((o) => Array.isArray(o) && o.length === first.length)) return null;
      const parts: string[] = [];
      for (let i = 0; i < first.length; i++) {
        const child = walk(objs.map((o) => (o as unknown[])[i]));
        if (child == null) return null;
        parts.push(child);
      }
      return `[${parts.join(",")}]`;
    }
    if (objs.every((v) => eq(v, first))) return JSON.stringify(first);
    let hit: string | null = null;
    for (const p of flats[0]!.keys()) {
      if (!p) continue;
      if (!objs.every((v, j) => eq(flats[j]!.get(p), v))) continue;
      if (hit != null) {
        if (p.length < hit.length) hit = p;
        else if (p.length === hit.length && p !== hit) return null;
        continue;
      }
      hit = p;
    }
    if (hit) {
      slots++;
      if (typeof first === "string") return `"{${hit}}"`;
      return `{${hit}}`;
    }
    // Nested string assembled from a source field (`"User "+email`) rather
    // than copied verbatim. Same honesty as tryTemplate: the skeleton must
    // reproduce every witness; do not guess among equal-length alternatives.
    if (!objs.every((v) => typeof v === "string")) return null;
    const strs = objs as string[];
    const ranked = [...flats[0]!]
      .filter(
        ([path, v]) => typeof v === "string" && path && (v as string).length >= 2 && strs[0]!.includes(v as string),
      )
      .sort((a, b) => (b[1] as string).length - (a[1] as string).length);
    let chosen: string | null = null;
    for (const [path, v] of ranked) {
      const expr = strs[0]!.split(v as string).join(`{${path}}`);
      if (expr === strs[0]! || !expr.includes("{")) continue;
      if (!strs.every((s, j) => interpolateSlots(expr, inputRecord(flats[j]!)) === s)) continue;
      if (chosen != null && chosen !== expr) return null;
      chosen = expr;
      break;
    }
    if (!chosen) return null;
    slots++;
    return JSON.stringify(chosen);
  };
  const expr = walk(values);
  if (!expr || !slots) return null;
  return expr;
}

function tryTemplate(
  values: unknown[],
  inputFlats: Map<string, unknown>[],
  priorFlats: Array<Array<{ id: string; flat: Map<string, unknown>; result: unknown }>>,
  render: Render,
): Binding | null {
  // Multi-slot token template first: commands whose varying parts span more
  // than one value (`kubectl logs {app} -n {namespace}`) are unreachable by
  // the single-value substitution below. Token alignment is guaranteed for
  // skeleton-clustered shell steps and harmless to attempt otherwise.
  const tokenAttempt = tryTokenTemplate(values as string[], inputFlats, priorFlats, render);
  if (tokenAttempt) return tokenAttempt;
  const objectAttempt = tryObjectTemplate(values, inputFlats, priorFlats);
  if (objectAttempt) return objectAttempt;
  if (!values.every((v) => typeof v === "string")) return null;
  const strs = values as string[];
  const base = strs[0]!;
  const ranked = [...inputFlats[0]!]
    .filter(([path, v]) => typeof v === "string" && path && v.length >= 2 && base.includes(v))
    .sort((a, b) => (b[1] as string).length - (a[1] as string).length);
  for (const [path, v] of ranked) {
    const expr = base.split(v as string).join(`{${path}}`);
    if (expr === base || !expr.includes("{")) continue;
    const ok = strs.every((s, j) => render(expr, inputRecord(inputFlats[j]!)) === s);
    if (ok) return { kind: "transform", fn: "template", expr, of: { kind: "input", path: "" } };
  }
  const priorHits = [...(priorFlats[0] ?? [])]
    .flatMap((step) =>
      [...step.flat]
        .filter(([, v]) => typeof v === "string" && (v as string).length >= 2 && base.includes(v as string))
        .map(([path, v]) => ({ step, path, v: v as string })),
    )
    .sort((a, b) => b.v.length - a.v.length);
  for (const { step, path, v } of priorHits) {
    const expr = base.split(v).join(`{${path || "$"}}`);
    if (expr === base || !expr.includes("{")) continue;
    const ok = strs.every((s, j) => {
      const src = priorFlats[j]!.find((p) => p.id === step.id);
      if (!src) return false;
      // Verify with the SAME renderer the runtime executes (interpolateSlots).
      // The old interpolate() also expanded ${…} and emptied unresolvable
      // {…} tokens, so a command containing literal shell expansions verified
      // here but executed at runtime with those tokens left raw — the
      // compiled tool ran a command that was never witnessed.
      return render(expr, src.result) === s;
    });
    if (ok) return { kind: "transform", fn: "template", expr, of: { kind: "from", step: step.id, path: "" } };
  }
  return null;
}

export type BindResult = { ok: true; binding: Binding } | { ok: false; reason: string; trap92?: boolean };

/**
 * Events bucketed by tool name, memoised per trace.
 *
 * Rebuilt for every argument slot before, then for every step; a trace's events
 * do not change during a compile, so it is built once. Bucketing at all
 * replaces the old filter-per-prior-id scan, which was O(priors x events).
 */
const eventsByName = new WeakMap<object, Map<string, TraceEvent[]>>();

function indexEvents(t: StretchTrace): Map<string, TraceEvent[]> {
  const hit = eventsByName.get(t);
  if (hit) return hit;
  const byName = new Map<string, TraceEvent[]>();
  for (const e of t.events) {
    const list = byName.get(e.name);
    if (list) list.push(e);
    else byName.set(e.name, [e]);
  }
  eventsByName.set(t, byName);
  return byName;
}

/**
 * flatten() always copies its cached entries into a fresh Map. Bind never
 * mutates those Maps, so we keep one Map per object and reuse it across
 * every prior-step rebuild (the old cost was O(steps² × traces) copies).
 */
const flatMemo = new WeakMap<object, Map<string, unknown>>();

function flattenCached(value: unknown): Map<string, unknown> {
  if (value && typeof value === "object") {
    const hit = flatMemo.get(value);
    if (hit) return hit;
    const flat = flatten(value);
    flatMemo.set(value, flat);
    return flat;
  }
  return flatten(value);
}

function priorFlats(traces: StretchTrace[], priorIds: string[]) {
  return traces.map((t) => {
    const byName = indexEvents(t);
    const seen = new Map<string, number>();
    return priorIds.map((id) => {
      const nth = seen.get(id) ?? 0;
      seen.set(id, nth + 1);
      const ev = byName.get(id)?.[nth];
      return { id, result: ev?.result, flat: flattenCached(ev?.result) };
    });
  });
}

export type BindContext = {
  traces: StretchTrace[];
  inputFlats: Array<Map<string, unknown>>;
  priors: ReturnType<typeof priorFlats>;
};

/**
 * The per-step work every slot in that step shares.
 *
 * Flattening the inputs and the prior results depends only on the step's
 * position, not on which argument is being bound, but bindSlot() used to redo
 * both for every argument. On a cluster with hundreds of witnesses that
 * dominated compile time.
 */
const inputFlatsByTrace = new WeakMap<StretchTrace, Map<string, unknown>>();
const ctxByTraces = new WeakMap<StretchTrace[], { priorIds: string[]; ctx: BindContext }>();

function priorIdsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function extendPriors(
  traces: StretchTrace[],
  prev: BindContext["priors"],
  newId: string,
  nth: number,
): BindContext["priors"] {
  return traces.map((t, i) => {
    const byName = indexEvents(t);
    const ev = byName.get(newId)?.[nth];
    return [...prev[i]!, { id: newId, result: ev?.result, flat: flattenCached(ev?.result) }];
  });
}

export function bindContext(traces: StretchTrace[], priorIds: string[]): BindContext {
  const cached = ctxByTraces.get(traces);
  if (cached && priorIdsMatch(cached.priorIds, priorIds)) return cached.ctx;
  if (
    cached &&
    cached.priorIds.length + 1 === priorIds.length &&
    priorIdsMatch(cached.priorIds, priorIds.slice(0, -1))
  ) {
    const newId = priorIds[priorIds.length - 1]!;
    let nth = 0;
    for (let i = 0; i < cached.priorIds.length; i++) if (cached.priorIds[i] === newId) nth++;
    const ctx: BindContext = {
      traces,
      inputFlats: cached.ctx.inputFlats,
      priors: extendPriors(traces, cached.ctx.priors, newId, nth),
    };
    ctxByTraces.set(traces, { priorIds: priorIds.slice(), ctx });
    return ctx;
  }
  const ctx: BindContext = {
    traces,
    inputFlats: traces.map((t) => {
      const hit = inputFlatsByTrace.get(t);
      if (hit) return hit;
      const flat = flattenCached(t.input ?? {});
      inputFlatsByTrace.set(t, flat);
      return flat;
    }),
    priors: priorFlats(traces, priorIds),
  };
  ctxByTraces.set(traces, { priorIds: priorIds.slice(), ctx });
  return ctx;
}

export function bindSlot(values: unknown[], ctx: BindContext, opts: BindOpts): BindResult {
  if (!values.length) return { ok: false, reason: "empty slot" };
  const { inputFlats, priors } = ctx;
  const render: Render = opts.shell ? interpolateShell : interpolateSlots;
  // Enumerate every producer for the first witness, then only *verify* the
  // survivors against the rest. Enumerating for all of them and intersecting
  // afterwards costs O(witnesses x flattened entries); verification is a map
  // lookup per surviving candidate, and the candidate set collapses within the
  // first couple of witnesses. This was the compiler's hottest loop.
  let candidates = producersFor(values[0], inputFlats[0]!, priors[0]!);
  // A shell command taken whole from an earlier step's result would run whatever
  // that step returns (isSafeShellCommand): a constant one binds as a literal.
  if (opts.shell) candidates = candidates.filter((p) => p.kind === "input");
  for (let i = 1; i < values.length && candidates.length; i++) {
    const flat = inputFlats[i]!;
    const prior = priors[i]!;
    const value = values[i];
    candidates = candidates.filter((p) => producerHolds(p, value, flat, prior));
  }
  const unique = rankProducers(candidates);
  if (unique) {
    if (unique.kind === "input") return { ok: true, binding: { kind: "input", path: unique.path } };
    return { ok: true, binding: { kind: "from", step: unique.step, path: unique.path } };
  }
  const agr = agreement(values);
  if (agr === 1) {
    // Deep check: redact() rewrites credentials wherever they sit, so a slot can
    // agree perfectly on a value like `{authorization: "[REDACTED]"}`. Binding
    // that as a literal compiles a tool that sends the sentinel to a live API.
    if (values.some((v) => containsRedaction(v))) return { ok: false, reason: "redacted secret slot" };
    if (!opts.allowExact && values.some((v) => v && typeof v === "object")) {
      const tmpl = tryTemplate(values, inputFlats, priors, render);
      if (tmpl) return { ok: true, binding: tmpl };
    }
    return { ok: true, binding: { kind: "literal", value: values[0] } };
  }
  if (agr >= 0.92) {
    return {
      ok: false,
      trap92: true,
      reason: `92% trap: slot agrees ${agr.toFixed(2)} but is not exact`,
    };
  }
  const tmpl = tryTemplate(values, inputFlats, priors, render);
  if (tmpl) return { ok: true, binding: tmpl };
  if (opts.mutating) return { ok: false, reason: "under-determined mutating argument" };
  return { ok: false, reason: "under-determined argument" };
}

/**
 * Bind a slot without flattening every witness.
 *
 * Flattening priors is O(steps × traces) Maps. On a 2k-trace homogeneous
 * cluster that dominates compile and scales worse than 4× a 500-trace run
 * because of GC. Bind on a sample, then verify the chosen binding against
 * every remaining witness with getPath — same answer as bindSlot on the
 * full context, without building it. If the sample's winner fails later
 * traces, fall back to the full bind.
 */
const BIND_SAMPLE = 32;
const sampleByTraces = new WeakMap<StretchTrace[], StretchTrace[]>();

function sampleTraces(traces: StretchTrace[]): StretchTrace[] {
  if (traces.length <= BIND_SAMPLE) return traces;
  const hit = sampleByTraces.get(traces);
  if (hit) return hit;
  const s = traces.slice(0, BIND_SAMPLE);
  sampleByTraces.set(traces, s);
  return s;
}

export function bindSlotWitnesses(
  values: unknown[],
  traces: StretchTrace[],
  priorIds: string[],
  opts: BindOpts,
): BindResult {
  if (!values.length) return { ok: false, reason: "empty slot" };
  if (values.length !== traces.length || values.length <= BIND_SAMPLE) {
    return bindSlot(values, bindContext(traces, priorIds), opts);
  }
  const sampleT = sampleTraces(traces);
  const sampleV = values.slice(0, BIND_SAMPLE);
  const sampled = bindSlot(sampleV, bindContext(sampleT, priorIds), opts);
  const render: Render = opts.shell ? interpolateShell : interpolateSlots;
  if (sampled.ok && bindingHoldsAll(sampled.binding, values, traces, priorIds, render)) return sampled;
  return bindSlot(values, bindContext(traces, priorIds), opts);
}

function bindingHoldsAll(
  b: Binding,
  values: unknown[],
  traces: StretchTrace[],
  priorIds: string[],
  render: Render,
): boolean {
  for (let i = BIND_SAMPLE; i < values.length; i++) {
    if (!bindingHolds(b, values[i], traces[i]!, priorIds, render)) return false;
  }
  return true;
}

function bindingHolds(b: Binding, value: unknown, t: StretchTrace, priorIds: string[], render: Render): boolean {
  const primitive = value == null || typeof value !== "object";
  if (b.kind === "literal") return sameValue(b.value, value, primitive);
  if (b.kind === "input") {
    const got = getPath(t.input ?? {}, b.path);
    return sameValue(got, value, primitive);
  }
  if (b.kind === "from") {
    if (fromHolds(t, b.step, b.path, value, priorIds, primitive)) return true;
    return b.or ? bindingHolds(b.or, value, t, priorIds, render) : false;
  }
  if (b.kind === "transform" && b.fn === "template") {
    const rec = templateRecord(b.of, t, priorIds);
    if (!rec) return false;
    const rendered = render(b.expr, rec);
    if (rendered === null) return false;
    const trimmed = b.expr.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return eq(JSON.parse(rendered), value);
      } catch {
        return false;
      }
    }
    return rendered === value;
  }
  if (b.kind === "transform" && b.fn === "slice") {
    const inner = evalOverForHold(b.of, t, priorIds);
    if (!Array.isArray(inner)) return false;
    const m = /^(\d+):(\d+)$/.exec(b.expr.trim());
    if (!m) return false;
    const sliced = inner.slice(Number(m[1]), Number(m[2]));
    return eq(sliced, value);
  }
  return false;
}

function evalOverForHold(of: Binding, t: StretchTrace, priorIds: string[]): unknown {
  if (of.kind === "from") {
    const byName = indexEvents(t);
    const seen = new Map<string, number>();
    for (const id of priorIds) {
      const nth = seen.get(id) ?? 0;
      seen.set(id, nth + 1);
      if (id !== of.step) continue;
      const ev = byName.get(id)?.[nth];
      return of.path ? getPath(ev?.result, of.path) : ev?.result;
    }
  }
  if (of.kind === "input") return of.path ? getPath(t.input ?? {}, of.path) : t.input;
  return undefined;
}

function templateRecord(of: Binding, t: StretchTrace, priorIds: string[]): Record<string, unknown> | null {
  const rec = templateRecordRaw(of, t, priorIds);
  if (!rec) return null;
  // Mixed object templates interpolate against input ∪ one prior. Extra input
  // keys are unused by interpolateSlots; prior keys win on collision so a
  // getOrg.orgId is not shadowed by a leftover input.orgId.
  const input =
    t.input && typeof t.input === "object" && !Array.isArray(t.input)
      ? (t.input as Record<string, unknown>)
      : inputRecord(flattenCached(t.input ?? {}));
  return { ...input, ...rec };
}

function templateRecordRaw(of: Binding, t: StretchTrace, priorIds: string[]): Record<string, unknown> | null {
  if (of.kind === "input") {
    const v = of.path ? getPath(t.input ?? {}, of.path) : t.input;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  }
  if (of.kind === "from") {
    const byName = indexEvents(t);
    const seen = new Map<string, number>();
    for (const id of priorIds) {
      const nth = seen.get(id) ?? 0;
      seen.set(id, nth + 1);
      if (id !== of.step) continue;
      const ev = byName.get(id)?.[nth];
      const v = of.path ? getPath(ev?.result, of.path) : ev?.result;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    }
  }
  if (of.kind === "transform") return templateRecordRaw(of.of, t, priorIds);
  return null;
}

function fromHolds(
  t: StretchTrace,
  step: string,
  path: string,
  value: unknown,
  priorIds: string[],
  primitive: boolean,
): boolean {
  const byName = indexEvents(t);
  const seen = new Map<string, number>();
  for (const id of priorIds) {
    const nth = seen.get(id) ?? 0;
    seen.set(id, nth + 1);
    if (id !== step) continue;
    const ev = byName.get(id)?.[nth];
    if (!ev) continue;
    const got = path ? getPath(ev.result, path) : ev.result;
    if (sameValue(got, value, primitive)) return true;
  }
  return false;
}

export function argKeys(events: TraceEvent[]): string[] {
  const freq = new Map<string, number>();
  for (const e of events) for (const k of Object.keys(e.args ?? {})) freq.set(k, (freq.get(k) ?? 0) + 1);
  return [...freq.entries()].filter(([, c]) => c / Math.max(events.length, 1) >= 0.8).map(([k]) => k);
}

/**
 * The least similar pair of argument key-sets across these events.
 *
 * `floor` lets the caller stop as soon as the answer is already below the
 * threshold it is going to compare against. This is all-pairs — O(events²·keys)
 * — and it runs for every mutating tool in every cluster, so at 500 witnesses
 * it was 125k set intersections computed in full to produce a number that gets
 * compared against a single constant.
 */
export function keyJaccard(events: TraceEvent[], floor = 0): number {
  if (events.length < 2) return 1;
  // Homogeneous batches (synth500, ETL) share one key set. Prove Jaccard=1
  // with one Set and Object.keys — do not allocate n Sets that all match.
  const firstKeys = Object.keys(events[0]!.args ?? {});
  const first = new Set(firstKeys);
  let allEqual = true;
  for (let i = 1; i < events.length; i++) {
    const keys = Object.keys(events[i]!.args ?? {});
    if (keys.length !== first.size) {
      allEqual = false;
      break;
    }
    for (const k of keys) {
      if (!first.has(k)) {
        allEqual = false;
        break;
      }
    }
    if (!allEqual) break;
  }
  if (allEqual) return 1;
  const sets = events.map((e) => new Set(Object.keys(e.args ?? {})));
  let min = 1;
  for (let i = 0; i < sets.length; i++) {
    if (min < floor) return min;
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      let inter = 0;
      for (const k of a) if (b.has(k)) inter++;
      const union = a.size + b.size - inter;
      min = Math.min(min, union ? inter / union : 1);
      if (min < floor) return min;
    }
  }
  return min;
}

export function outputsDiverge(events: TraceEvent[]): boolean {
  if (events.length < 2) return false;
  const first = canonicalize(events[0]!.result);
  for (let i = 1; i < events.length; i++) if (canonicalize(events[i]!.result) !== first) return true;
  return false;
}

export function inferSchema(values: unknown[]): Record<string, unknown> {
  // Tally every witnessed type per key and take the modal one, rather than
  // whichever witness happened to come last. `keys.set` overwrote, so a single
  // late null downgraded a number field to "string" for the whole schema.
  const seen = new Map<string, Map<string, number>>();
  const present = new Map<string, number>();
  let nObj = 0;
  for (const v of values) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    nObj++;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      // "array" and "null" both used to fall through to "string", so an island
      // whose witnessed result was `{items: [...]}` told the model to return a
      // string where the program's consumers expect an array. null is not
      // evidence of a type at all, so it is skipped rather than counted.
      if (val === null) continue;
      const t = Array.isArray(val)
        ? "array"
        : typeof val === "number"
          ? "number"
          : typeof val === "boolean"
            ? "boolean"
            : typeof val === "object"
              ? "object"
              : "string";
      const tally = seen.get(k) ?? new Map<string, number>();
      tally.set(t, (tally.get(t) ?? 0) + 1);
      seen.set(k, tally);
      present.set(k, (present.get(k) ?? 0) + 1);
    }
  }
  const keys = new Map<string, string>();
  for (const [k, tally] of seen) {
    let best = "string";
    let bestN = -1;
    for (const [t, n] of tally) {
      if (n > bestN) {
        best = t;
        bestN = n;
      }
    }
    keys.set(k, best);
  }
  return {
    type: "object",
    properties: Object.fromEntries([...keys].map(([k, t]) => [k, { type: t }])),
    required: [...keys.keys()].filter((k) => (present.get(k) ?? 0) / Math.max(nObj, 1) >= 0.8),
  };
}

function remapExceptExpr(expr: string, nameToId: Map<string, string>): string {
  const dot = expr.indexOf(".");
  const step = dot < 0 ? expr : expr.slice(0, dot);
  const path = dot < 0 ? "" : expr.slice(dot + 1);
  const mapped = nameToId.get(step) ?? step;
  return path ? `${mapped}.${path}` : mapped;
}

function remapLookupExpr(expr: string, nameToId: Map<string, string>): string {
  const i = expr.search(/=(?!=)/);
  if (i <= 0) return expr;
  const field = expr.slice(0, i).trim();
  const needle = expr.slice(i + 1).trim();
  return `${field}=${remapExceptExpr(needle, nameToId)}`;
}

export function remapBinding(b: Binding, nameToId: Map<string, string>): Binding {
  if (b.kind === "from") {
    const remapped: Binding = {
      kind: "from",
      step: nameToId.get(b.step) ?? b.step,
      path: b.path,
      ...(b.or ? { or: remapBinding(b.or, nameToId) } : {}),
    };
    return remapped;
  }
  if (b.kind === "transform") {
    const of = remapBinding(b.of, nameToId);
    if (b.fn === "except" || b.fn === "zip") {
      return { ...b, expr: remapExceptExpr(b.expr, nameToId), of };
    }
    if (b.fn === "lookup") {
      return { ...b, expr: remapLookupExpr(b.expr, nameToId), of };
    }
    return { ...b, of };
  }
  return b;
}

export function tryTemplateForTest(values: unknown[], traces: StretchTrace[], priorIds: string[]): Binding | null {
  const inputFlats = traces.map((t) => flatten(t.input ?? {}));
  return tryTemplate(values, inputFlats, priorFlats(traces, priorIds), interpolateSlots);
}
