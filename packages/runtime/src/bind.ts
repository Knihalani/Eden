import type { Binding } from "@eden/ir";
import { cloneJson, getPath, interpolate } from "@eden/ir";

export type BindScope = {
  input: Record<string, unknown>;
  results: Map<string, unknown>;
};

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
