import type { StretchProgram } from "./types";
import { eq } from "./eq";
import { getPath, parsePath } from "./path";

/** Keys on input that are neither envelope paths nor declared schema properties. */
export function extraInputKeys(program: StretchProgram, input: Record<string, unknown>): string[] {
  const allowed = new Set<string>();
  const env = program.contract.envelope?.inputs;
  if (env) {
    for (const path of Object.keys(env)) {
      const parts = parsePath(path);
      if (parts?.[0]) allowed.add(parts[0]);
    }
  }
  const props = (program.inputSchema as { properties?: unknown } | undefined)?.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    for (const k of Object.keys(props as object)) allowed.add(k);
  }
  if (!allowed.size) return [];
  return Object.keys(input).filter((k) => !allowed.has(k));
}

export function inDistribution(program: StretchProgram, input: Record<string, unknown>): boolean {
  const env = program.contract.envelope?.inputs;
  // An empty envelope constrains nothing — but it also proves nothing. Falling
  // through the zero-iteration loop returned true for any input at all; an
  // empty envelope means "no witnessed values", which is exactly the no-envelope
  // case: out of distribution unless the contract explicitly allows exact replay.
  if (!env || Object.keys(env).length === 0) return program.contract.allowExact === true;
  if (extraInputKeys(program, input).length) return false;
  for (const [path, values] of Object.entries(env)) {
    if (!Array.isArray(values)) return false;
    const v = getPath(input, path);
    if (!values.some((w) => eq(w, v))) return false;
  }
  return true;
}
