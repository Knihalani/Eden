/**
 * Rolling shadow (Wave 10.1).
 *
 * A clean in-distribution live receipt refreshes hold-out evidence and may
 * grow the envelope via inheritEnvelopeValues only (existing keys). OOD
 * inputs and failed receipts fail-open: the program and hold-out stay as
 * they were. Never invents keys.
 *
 * Control/site can call rollEnvelope without this package owning their store.
 */
import type { StretchProgram, StretchTrace } from "@eden/ir";
import { eq, inDistribution, inheritEnvelopeValues, withVersion } from "@eden/ir";

export type LiveReceipt = {
  ok: boolean;
  input?: Record<string, unknown>;
  events?: StretchTrace["events"];
};

function isCleanInDistribution(program: StretchProgram, receipt: LiveReceipt): receipt is LiveReceipt & {
  ok: true;
  input: Record<string, unknown>;
} {
  if (receipt.ok !== true || !receipt.input) return false;
  return inDistribution(program, receipt.input);
}

/**
 * Refresh the envelope from one confirmed in-distribution live receipt.
 * Existing keys only. Unchanged when the receipt is bad or OOD.
 */
export function rollEnvelope(program: StretchProgram, receipt: LiveReceipt): StretchProgram {
  if (!isCleanInDistribution(program, receipt)) return program;
  const env = program.contract.envelope;
  if (!env) return program;
  const next = inheritEnvelopeValues(env, receipt.input);
  if (eq(next, env)) return program;
  return withVersion({
    ...program,
    contract: { ...program.contract, envelope: next },
  });
}

/**
 * Append a clean in-distribution receipt onto the hold-out set. OOD / failed
 * receipts leave the set unchanged so shadow never trains on invented values.
 */
export function rollHoldout(
  held: readonly StretchTrace[],
  program: StretchProgram,
  receipt: LiveReceipt,
): StretchTrace[] {
  if (!isCleanInDistribution(program, receipt)) return [...held];
  const events = (receipt.events ?? []).map((e) => ({
    name: e.name,
    args: e.args ?? {},
    result: e.result,
    ok: e.ok !== false,
    ...(e.skipped ? { skipped: true as const } : {}),
    ...(e.duration_ms != null ? { duration_ms: e.duration_ms } : {}),
  }));
  return [
    ...held,
    {
      id: `roll-${held.length}`,
      input: receipt.input,
      events,
      llmCalls: 0,
      duration_ms: 0,
      cost_cents: 0,
      complete: true,
    },
  ];
}
