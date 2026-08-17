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
