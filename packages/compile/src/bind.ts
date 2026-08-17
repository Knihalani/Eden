import type { Binding, StretchTrace, TraceEvent } from "@eden/ir";
import { canonicalize, containsRedaction, eq, flatten, interpolate, isWeakValue } from "@eden/ir";
export { isCheckName, isIslandName, isMutating } from "@eden/ir";

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

function intersectProducers(rows: Producer[][]): Producer | null {
  if (!rows.length || rows.some((r) => !r.length)) return null;
  const key = (p: Producer) => (p.kind === "input" ? `input:${p.path}` : `from:${p.step}:${p.path}`);
  let set = new Set(rows[0]!.map(key));
  const map = new Map(rows[0]!.map((p) => [key(p), p]));
  for (let i = 1; i < rows.length; i++) {
    const next = new Set(rows[i]!.map(key));
    set = new Set([...set].filter((k) => next.has(k)));
  }
  if (!set.size) return null;
  const ranked = [...set].sort((a, b) => {
    const pa = map.get(a)!;
    const pb = map.get(b)!;
    if (pa.kind === "input" && pb.kind !== "input") return -1;
    if (pb.kind === "input" && pa.kind !== "input") return 1;
    return a.length - b.length;
  });
  const chosen = ranked[0]!;
  for (const row of rows) {
    const hit = row.find((p) => key(p) === chosen);
    if (hit) return hit;
  }
  return map.get(chosen) ?? null;
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

function tryTemplate(
  values: unknown[],
  inputFlats: Map<string, unknown>[],
  priorFlats: Array<Array<{ id: string; flat: Map<string, unknown>; result: unknown }>>,
): Binding | null {
  if (!values.every((v) => typeof v === "string")) return null;
  const strs = values as string[];
  const base = strs[0]!;
  const ranked = [...inputFlats[0]!]
    .filter(([path, v]) => typeof v === "string" && path && v.length >= 2 && base.includes(v))
    .sort((a, b) => (b[1] as string).length - (a[1] as string).length);
  for (const [path, v] of ranked) {
    const expr = base.split(v as string).join(`{${path}}`);
    if (expr === base || !expr.includes("{")) continue;
    const ok = strs.every((s, j) => interpolate(expr, inputRecord(inputFlats[j]!)) === s);
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
      return interpolate(expr, src.result) === s;
    });
    if (ok) return { kind: "transform", fn: "template", expr, of: { kind: "from", step: step.id, path: "" } };
  }
  return null;
}

export type BindResult =
  | { ok: true; binding: Binding }
  | { ok: false; reason: string; trap92?: boolean };

function priorFlats(traces: StretchTrace[], priorIds: string[]) {
  return traces.map((t) => {
    const seen = new Map<string, number>();
    return priorIds.map((id) => {
      const nth = seen.get(id) ?? 0;
      seen.set(id, nth + 1);
      const hits = t.events.filter((e) => e.name === id);
      const ev = hits[nth];
      return { id, result: ev?.result, flat: flatten(ev?.result) };
    });
  });
}

export function bindSlot(
  values: unknown[],
  traces: StretchTrace[],
  priorIds: string[],
  opts: { mutating: boolean; allowExact: boolean },
): BindResult {
  if (!values.length) return { ok: false, reason: "empty slot" };
  const inputs = traces.map((t) => t.input ?? {});
  const inputFlats = inputs.map((i) => flatten(i));
  const priors = priorFlats(traces, priorIds);
  const rows = values.map((v, i) => producersFor(v, inputFlats[i]!, priors[i]!));
  const unique = intersectProducers(rows);
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

export function keyJaccard(events: TraceEvent[]): number {
  if (events.length < 2) return 1;
  const sets = events.map((e) => new Set(Object.keys(e.args ?? {})));
  let min = 1;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      let inter = 0;
      for (const k of a) if (b.has(k)) inter++;
      const union = a.size + b.size - inter;
      min = Math.min(min, union ? inter / union : 1);
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
  const keys = new Map<string, string>();
  const present = new Map<string, number>();
  let nObj = 0;
  for (const v of values) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    nObj++;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const t = Array.isArray(val) ? "array" : val === null ? "null" : typeof val;
      keys.set(k, t === "object" ? "object" : t === "number" ? "number" : t === "boolean" ? "boolean" : "string");
      present.set(k, (present.get(k) ?? 0) + 1);
    }
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
