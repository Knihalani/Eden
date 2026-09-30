import type { Binding } from "@eden/ir";
import {
  asArray,
  canonicalize,
  cloneJson,
  eq,
  getPath,
  interpolateShell,
  interpolateSlots,
  isShellCommand,
  setKey,
} from "@eden/ir";
import { evalAssert } from "./assert";
import { DeoptError } from "./deopt";

/**
 * The subset of Map that binding evaluation needs. A plain Map satisfies it, so
 * the common path is unchanged; the interface exists so a loop iteration can be
 * handed a scope that shadows the shared one instead of writing into it.
 */
export interface ResultScope {
  has(id: string): boolean;
  get(id: string): unknown;
  set(id: string, value: unknown): void;
  delete(id: string): void;
}

export type BindScope = {
  input: Record<string, unknown>;
  results: ResultScope;
};

/**
 * A scope layered over a parent: reads fall through, writes stay local.
 *
 * Loop iterations write their body-step results and their item variable under
 * fixed ids. Run sequentially that is fine — each iteration overwrites the last.
 * Run concurrently it is a data race, with iterations reading each other's
 * values through the shared map. Giving every iteration its own layer makes the
 * bindings resolve exactly as they would have sequentially.
 */
export class ChildScope implements ResultScope {
  private readonly own = new Map<string, unknown>();
  private readonly shadowed = new Set<string>();

  constructor(private readonly parent: ResultScope) {}

  has(id: string): boolean {
    if (this.own.has(id)) return true;
    if (this.shadowed.has(id)) return false;
    return this.parent.has(id);
  }

  get(id: string): unknown {
    if (this.own.has(id)) return this.own.get(id);
    if (this.shadowed.has(id)) return undefined;
    return this.parent.get(id);
  }

  set(id: string, value: unknown): void {
    this.shadowed.delete(id);
    this.own.set(id, value);
  }

  /** Hides the parent's binding for this run rather than mutating the parent. */
  delete(id: string): void {
    this.own.delete(id);
    this.shadowed.add(id);
  }

  /** Everything this layer wrote, for merging the final iteration back. */
  entries(): Array<[string, unknown]> {
    return [...this.own];
  }
}

/**
 * `shell` marks a shell tool's command line: a template then splices each slot
 * value as data (interpolateShell), and a value it cannot keep as data stops
 * the run instead of reaching the shell.
 */
export function evalBinding(binding: Binding, scope: BindScope, shell = false): unknown {
  switch (binding.kind) {
    case "literal":
      // A compiled program is a long-lived artifact executed many times. Handing
      // out the *same* object every run lets one tool that mutates its arguments
      // poison every later run, so object literals are copied on read. Scalars —
      // the overwhelming majority — take the identity fast path in cloneJson.
      return cloneJson(binding.value);
    case "input": {
      return getPath(scope.input, binding.path);
    }
    case "from": {
      if (!scope.results.has(binding.step)) {
        if (binding.or) return evalBinding(binding.or, scope);
        throw new Error(`unknown step ${binding.step}`);
      }
      return getPath(scope.results.get(binding.step), binding.path);
    }
    case "transform": {
      const inner = evalBinding(binding.of, scope);
      if (binding.fn === "identity") return inner;
      if (binding.fn === "jsonpath") return getPath(inner, binding.expr);
      if (binding.fn === "slice") {
        const m = /^(\d+):(\d+)$/.exec(binding.expr.trim());
        if (!m) throw new Error(`slice expr must be start:end, got ${JSON.stringify(binding.expr)}`);
        return asArray(inner).slice(Number(m[1]), Number(m[2]));
      }
      if (binding.fn === "except") {
        const excl = asArray(lookupExceptExpr(binding.expr, scope));
        return asArray(inner).filter((item) => !excl.some((x) => sameLoopIdentity(item, x)));
      }
      if (binding.fn === "flatten") {
        const path = binding.expr.trim();
        if (path.startsWith("deep:")) {
          const key = path.slice("deep:".length);
          const roots = Array.isArray(inner) ? inner : inner == null ? [] : [inner];
          return roots.flatMap((n) => collectLeaves(n, key));
        }
        return asArray(inner).flatMap((item) => asArray(path ? getPath(item, path) : item));
      }
      if (binding.fn === "unique") {
        return uniqueBy(asArray(inner), binding.expr.trim());
      }
      if (binding.fn === "sort") {
        return sortBy(asArray(inner), binding.expr.trim());
      }
      if (binding.fn === "reduce") {
        return reduceOf(asArray(inner), binding.expr.trim());
      }
      if (binding.fn === "add") {
        const n = Number(binding.expr.trim());
        if (!Number.isInteger(n)) throw new Error(`add expr must be an integer, got ${JSON.stringify(binding.expr)}`);
        if (typeof inner !== "number" || !Number.isFinite(inner)) {
          throw new Error(`add requires a number, got ${typeof inner}`);
        }
        return inner + n;
      }
      if (binding.fn === "filter") {
        return asArray(inner).filter((item) => {
          try {
            return evalAssert(binding.expr, item, scope.input, scope.results);
          } catch {
            return false;
          }
        });
      }
      if (binding.fn === "lookup") {
        const split = splitLookupExpr(binding.expr);
        if (!split) throw new Error(`lookup expr must be field=step.path, got ${JSON.stringify(binding.expr)}`);
        const needle = lookupExceptExpr(split.needle, scope);
        const found = asArray(inner).find((h) => eq(getPath(h, split.field), needle));
        if (found === undefined) throw new DeoptError(`lookup miss ${binding.expr}`);
        return found;
      }
      if (binding.fn === "chunk") {
        const n = Number(binding.expr.trim());
        if (!Number.isInteger(n) || n < 2) throw new Error(`chunk expr must be an integer >= 2, got ${JSON.stringify(binding.expr)}`);
        const arr = asArray(inner);
        const out: unknown[][] = [];
        for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
        return out;
      }
      if (binding.fn === "zip") {
        const right = asArray(lookupExceptExpr(binding.expr, scope));
        const left = asArray(inner);
        if (left.length !== right.length) {
          throw new DeoptError(`zip length ${left.length} != ${right.length}`);
        }
        return left.map((a, i) => ({ left: a, right: right[i] }));
      }
      if (binding.fn === "group") {
        const field = binding.expr.trim();
        if (!field) throw new Error("group expr needs a field path");
        const order: string[] = [];
        const groups = new Map<string, unknown[]>();
        for (const item of asArray(inner)) {
          const raw = getPath(item, field);
          const k = canonicalize(raw);
          if (!groups.has(k)) {
            groups.set(k, []);
            order.push(k);
          }
          groups.get(k)!.push(item);
        }
        return order.map((k) => {
          const items = groups.get(k)!;
          return { key: getPath(items[0], field), items };
        });
      }
      // interpolateSlots preserves literal braces in structured bodies
      // (JSON, shell expansions) while still resolving named slots.
      // Mixed JSON templates compile against input ∪ one prior; prior keys
      // win on collision so getOrg.orgId is not shadowed by leftover input.
      const record = templateRecord(inner, scope.input);
      const rendered = shell ? interpolateShell(binding.expr, record) : interpolateSlots(binding.expr, record);
      if (rendered === null) throw new DeoptError("a slot value cannot be quoted as data in this shell command");
      const trimmed = binding.expr.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return JSON.parse(rendered);
        } catch {
          throw new Error(`template JSON parse failed`);
        }
      }
      return rendered;
    }
  }
}

/** Merge input under a prior object so `{email}` slots resolve without the prior echoing them. */
function templateRecord(inner: unknown, input: Record<string, unknown>): unknown {
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return inner;
  return { ...input, ...(inner as Record<string, unknown>) };
}

/** `expr` is `stepId` or `stepId.path` naming the exclusion array. */
function lookupExceptExpr(expr: string, scope: BindScope): unknown {
  const raw = expr.trim();
  const dot = raw.indexOf(".");
  const step = dot < 0 ? raw : raw.slice(0, dot);
  const path = dot < 0 ? "" : raw.slice(dot + 1);
  if (!scope.results.has(step)) throw new Error(`unknown step ${step}`);
  return getPath(scope.results.get(step), path);
}

/** `id=item_loop.deptId` — field on the haystack, needle from a scoped step. */
export function splitLookupExpr(expr: string): { field: string; needle: string } | null {
  const i = expr.search(/=(?!=)/);
  if (i <= 0) return null;
  const field = expr.slice(0, i).trim();
  const needle = expr.slice(i + 1).trim();
  if (!field || !needle) return null;
  return { field, needle };
}

/**
 * Set-difference identity: objects with `id` compare on id; otherwise eq,
 * then canonicalize so two equal-content records still match.
 */
export function sameLoopIdentity(a: unknown, b: unknown): boolean {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ida = (a as Record<string, unknown>).id;
    const idb = (b as Record<string, unknown>).id;
    if (ida !== undefined && idb !== undefined) return eq(ida, idb);
  }
  return eq(a, b) || canonicalize(a) === canonicalize(b);
}

/** Recursively collect leaves: nodes whose `key` array is missing or empty. */
export function collectLeaves(node: unknown, key: string, depth = 0): unknown[] {
  if (node == null || typeof node !== "object" || depth > 12) return [];
  const kids = getPath(node, key);
  if (!Array.isArray(kids) || kids.length === 0) return [node];
  return kids.flatMap((ch) => collectLeaves(ch, key, depth + 1));
}

function uniqueBy(arr: unknown[], field: string): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of arr) {
    const k = field ? canonicalize(getPath(item, field)) : canonicalize(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function sortBy(arr: unknown[], expr: string): unknown[] {
  const desc = expr.startsWith("-");
  const field = desc ? expr.slice(1) : expr;
  if (!field) throw new Error("sort expr needs a field path");
  return arr
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const cmp = cmpPrim(getPath(a.item, field), getPath(b.item, field));
      const ordered = desc ? -cmp : cmp;
      return ordered !== 0 ? ordered : a.i - b.i;
    })
    .map((x) => x.item);
}

function cmpPrim(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return String(a).localeCompare(String(b));
}

function reduceOf(arr: unknown[], expr: string): unknown {
  const i = expr.indexOf(":");
  const op = (i < 0 ? expr : expr.slice(0, i)).trim();
  const field = (i < 0 ? "" : expr.slice(i + 1)).trim();
  if (op === "sum") {
    let s = 0;
    for (const item of arr) {
      const v = field ? getPath(item, field) : item;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`reduce sum:${field || "(item)"} needs numbers`);
      }
      s += v;
    }
    return s;
  }
  if (op === "concat") {
    return arr.flatMap((item) => asArray(field ? getPath(item, field) : item));
  }
  throw new Error(`reduce expr must be sum:field or concat:field, got ${JSON.stringify(expr)}`);
}

/** `tool` is the step's tool, so a shell tool's command line is bound as one (see evalBinding). */
export function evalArgs(args: Record<string, Binding>, scope: BindScope, tool = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // setKey rather than `out[k] =`: a step whose args carry a "__proto__" key
  // would otherwise run the inherited setter, losing the argument and
  // installing it as the prototype of the object handed to the tool.
  for (const [k, b] of Object.entries(args)) setKey(out, k, evalBinding(b, scope, isShellCommand(tool, k)));
  return out;
}
