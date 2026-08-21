import { createHash } from "node:crypto";
import type { StretchProgram, StretchTrace } from "./types";
import { canonicalize, cloneJson } from "./eq";

export function hashProgram(program: Pick<StretchProgram, "name" | "description" | "inputSchema" | "steps" | "returns" | "contract" | "sequence">): string {
  const payload = {
    name: program.name,
    description: program.description,
    inputSchema: program.inputSchema,
    steps: program.steps,
    returns: program.returns,
    contract: {
      witnesses: program.contract.witnesses,
      minLlmReduction: program.contract.minLlmReduction,
      allowExact: program.contract.allowExact,
      envelope: program.contract.envelope ?? null,
    },
    sequence: program.sequence ?? [],
  };
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

/**
 * The identity of the *stretch* a program was mined from, as opposed to the
 * identity of one particular compilation of it.
 *
 * hashProgram() covers the whole program including contract.witnesses, so it
 * changes every time another trace is observed. Keying stored tools on that
 * meant a fourth witness produced a brand new tool id for an unchanged
 * program: the store never found the existing row, so it inserted a duplicate
 * and the `prev` version stack it maintains could never be reached. Two tools
 * for one stretch is exactly the `github_pr_bundle` / `github_pr_bundle_2`
 * pattern in the recorded benchmark runs.
 *
 * Identity is therefore the stretch — the tool sequence the agent kept
 * repeating — and hashProgram() remains the version within it.
 */
const STRETCH_HASH = new WeakMap<object, string>();

export function hashStretch(program: Pick<StretchProgram, "name" | "sequence">): string {
  const hit = STRETCH_HASH.get(program);
  if (hit) return hit;
  const hex = createHash("sha256")
    .update(canonicalize({ name: program.name, sequence: program.sequence ?? [] }))
    .digest("hex");
  STRETCH_HASH.set(program, hex);
  return hex;
}

export function hashTrace(t: Pick<StretchTrace, "events" | "input">): string {
  const input = cloneJson(t.input ?? null);
  const events = cloneJson(
    t.events.map((e) => ({
      name: e.name,
      args: e.args ?? {},
      result: e.result ?? null,
      ok: e.ok !== false,
    })),
  );
  return createHash("sha256").update(canonicalize({ input, events })).digest("hex");
}

export function withVersion<T extends Omit<StretchProgram, "version"> & { version?: string }>(program: T): T & { version: string } {
  return { ...program, version: hashProgram(program) };
}
