import type { Binding, StretchTrace, TraceEvent } from "@eden/ir";
import { canonicalize, containsRedaction, eq, flatten, interpolateSlots, isWeakValue } from "@eden/ir";
export { isCheckName, isIslandName, isMutating, isReadName } from "@eden/ir";

type Producer = { kind: "input"; path: string } | { kind: "from"; step: string; path: string };

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
function tryTokenTemplate(
  strs: string[],
  inputFlats: Map<string, unknown>[],
  priorFlats: Array<Array<{ id: string; flat: Map<string, unknown>; result: unknown }>>,
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
      let hit: string | null = null;
      for (const k of keys) {
        if (rows.every((r, j) => String(recs[j]![k]) === col[j])) {
          hit = k;
          break;
        }
      }
      if (!hit) {
        resolved = false;
        break;
      }
      exprTokens[i] = `{${hit}}`;
      slots++;
    }
    if (!resolved || !slots) continue;
    const expr = exprTokens.join(" ");
    if (!rows.every((_, j) => interpolateSlots(expr, recs[j]!) === strs[j])) continue;
    return source.kind === "input"
      ? { kind: "transform", fn: "template", expr, of: { kind: "input", path: "" } }
      : { kind: "transform", fn: "template", expr, of: { kind: "from", step: source.id, path: "" } };
  }
  return null;
}

function tryTemplate(
  values: unknown[],
  inputFlats: Map<string, unknown>[],
  priorFlats: Array<Array<{ id: string; flat: Map<string, unknown>; result: unknown }>>,
): Binding | null {
  // Multi-slot token template first: commands whose varying parts span more
  // than one value (`kubectl logs {app} -n {namespace}`) are unreachable by
  // the single-value substitution below. Token alignment is guaranteed for
  // skeleton-clustered shell steps and harmless to attempt otherwise.
  const tokenAttempt = tryTokenTemplate(values as string[], inputFlats, priorFlats);
  if (tokenAttempt) return tokenAttempt;
  if (!values.every((v) => typeof v === "string")) return null;
  const strs = values as string[];
  const base = strs[0]!;
  const ranked = [...inputFlats[0]!]
    .filter(([path, v]) => typeof v === "string" && path && v.length >= 2 && base.includes(v))
    .sort((a, b) => (b[1] as string).length - (a[1] as string).length);
  for (const [path, v] of ranked) {
    const expr = base.split(v as string).join(`{${path}}`);
    if (expr === base || !expr.includes("{")) continue;
    const ok = strs.every((s, j) => interpolateSlots(expr, inputRecord(inputFlats[j]!)) === s);
    if (ok) return { kind: "transform", fn: "template", expr, of: { kind: "input", path: "" } };
  }
  const priorHits = [...(priorFlats[0] ?? [])].flatMap((step) =>
    [...step.flat]
      .filter(([, v]) => typeof v === "string" && (v as string).length >= 2 && base.includes(v as string))
      .map(([path, v]) => ({ step, path, v: v as string })),
  ).sort((a, b) => b.v.length - a.v.length);
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
      return interpolateSlots(expr, src.result) === s;
    });
    if (ok) return { kind: "transform", fn: "template", expr, of: { kind: "from", step: step.id, path: "" } };
  }
  return null;
}

export type BindResult =
  | { ok: true; binding: Binding }
  | { ok: false; reason: string; trap92?: boolean };

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

function priorFlats(traces: StretchTrace[], priorIds: string[]) {
  return traces.map((t) => {
    const byName = indexEvents(t);
    const seen = new Map<string, number>();
    return priorIds.map((id) => {
      const nth = seen.get(id) ?? 0;
      seen.set(id, nth + 1);
      const ev = byName.get(id)?.[nth];
      return { id, result: ev?.result, flat: flatten(ev?.result) };
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
export function bindContext(traces: StretchTrace[], priorIds: string[]): BindContext {
  return {
    traces,
    inputFlats: traces.map((t) => flatten(t.input ?? {})),
    priors: priorFlats(traces, priorIds),
  };
}

export function bindSlot(
  values: unknown[],
  ctx: BindContext,
  opts: { mutating: boolean; allowExact: boolean },
): BindResult {
  if (!values.length) return { ok: false, reason: "empty slot" };
  const { inputFlats, priors } = ctx;
  // Enumerate every producer for the first witness, then only *verify* the
  // survivors against the rest. Enumerating for all of them and intersecting
  // afterwards costs O(witnesses x flattened entries); verification is a map
  // lookup per surviving candidate, and the candidate set collapses within the
  // first couple of witnesses. This was the compiler's hottest loop.
  let candidates = producersFor(values[0], inputFlats[0]!, priors[0]!);
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
      const tmpl = tryTemplate(values, inputFlats, priors);
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
  const tmpl = tryTemplate(values, inputFlats, priors);
  if (tmpl) return { ok: true, binding: tmpl };
  if (opts.mutating) return { ok: false, reason: "under-determined mutating argument" };
  return { ok: false, reason: "under-determined argument" };
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

export function remapBinding(b: Binding, nameToId: Map<string, string>): Binding {
  if (b.kind === "from") return { ...b, step: nameToId.get(b.step) ?? b.step };
  if (b.kind === "transform") return { ...b, of: remapBinding(b.of, nameToId) };
  return b;
}

export function tryTemplateForTest(
  values: unknown[],
  traces: StretchTrace[],
  priorIds: string[],
): Binding | null {
  const inputFlats = traces.map((t) => flatten(t.input ?? {}));
  return tryTemplate(values, inputFlats, priorFlats(traces, priorIds));
}
