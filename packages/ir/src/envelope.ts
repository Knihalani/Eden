import type { StretchProgram } from "./types";
import { eq } from "./eq";
import { getPath } from "./path";

export function inDistribution(program: StretchProgram, input: Record<string, unknown>): boolean {
  const env = program.contract.envelope?.inputs;
  // An empty envelope constrains nothing — but it also proves nothing. Falling
  // through the zero-iteration loop returned true for any input at all; an
  // empty envelope means "no witnessed values", which is exactly the no-envelope
  // case: out of distribution unless the contract explicitly allows exact replay.
  if (!env || Object.keys(env).length === 0) return program.contract.allowExact === true;
  for (const [path, values] of Object.entries(env)) {
    if (!Array.isArray(values)) return false;
    const v = getPath(input, path);
    if (!values.some((w) => eq(w, v))) return false;
  }
  return true;
}
