import type { Binding } from "@eden/ir";
import { cloneJson, getPath, interpolate } from "@eden/ir";

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

export function evalBinding(binding: Binding, scope: BindScope): unknown {
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
      if (!scope.results.has(binding.step)) throw new Error(`unknown step ${binding.step}`);
      return getPath(scope.results.get(binding.step), binding.path);
    }
    case "transform": {
      const inner = evalBinding(binding.of, scope);
      if (binding.fn === "identity") return inner;
      if (binding.fn === "jsonpath") return getPath(inner, binding.expr);
      return interpolate(binding.expr, inner);
    }
  }
}

export function evalArgs(args: Record<string, Binding>, scope: BindScope): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, b] of Object.entries(args)) out[k] = evalBinding(b, scope);
  return out;
}
