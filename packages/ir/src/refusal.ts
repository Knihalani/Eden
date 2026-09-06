import type { Refusal, RefusalCode } from "./types";

/** One label per class. Home status and canvas empty share these words. */
export const REFUSAL_LABELS: Record<RefusalCode, string> = {
  unbound_foreach: "Unbound loop",
  read_set_mismatch: "Read-set mismatch",
  underdetermined_write: "Unbound write",
  underdetermined_command: "Unbound command",
  empty_output: "Empty output",
  too_short: "Too short",
  no_envelope: "No envelope",
  invalid_program: "Invalid program",
  unbound_branch: "Unbound branch",
  max_programs: "At cap",
};

const CODE_FROM_REASON: Array<{ test: RegExp; code: RefusalCode }> = [
  { test: /without a bindable foreach/i, code: "unbound_foreach" },
  { test: /commands are under-determined/i, code: "underdetermined_command" },
  { test: /under-determined|mutating call has no bound/i, code: "underdetermined_write" },
  { test: /empty or identical output/i, code: "empty_output" },
  { test: /fewer than 3 steps/i, code: "too_short" },
  { test: /no witnessed input/i, code: "no_envelope" },
  { test: /invalid program/i, code: "invalid_program" },
  { test: /could not be bound|refuses to guess/i, code: "unbound_branch" },
  { test: /max programs cap/i, code: "max_programs" },
];

export function refusalCodeOf(row: Pick<Refusal, "code" | "reason" | "readSet" | "repeats">): RefusalCode | undefined {
  if (row.code) return row.code;
  if (row.readSet != null && row.repeats != null && row.readSet !== row.repeats) return "read_set_mismatch";
  for (const { test, code } of CODE_FROM_REASON) if (test.test(row.reason)) return code;
  return undefined;
}

/**
 * Home "Needs attention" status. Named class + the count that fell short.
 * A row without a code stays "Refused" so older candidates do not invent a class.
 */
export function refusalStatus(row: Pick<Refusal, "code" | "reason" | "readSet" | "repeats">): string {
  const code = refusalCodeOf(row);
  if (code === "read_set_mismatch" && row.readSet != null && row.repeats != null) {
    return `Read-set · ${row.repeats} of ${row.readSet}`;
  }
  if (code) return REFUSAL_LABELS[code];
  return "Refused";
}

/** Canvas empty-graph copy: class, counts, what to change. */
export function refusalCopy(row: Pick<Refusal, "code" | "reason" | "hint" | "readSet" | "repeats" | "slot">): string {
  const code = refusalCodeOf(row);
  const label = code ? REFUSAL_LABELS[code] : "Refused";
  const hint = row.hint?.trim();
  if (hint) return `${label}. ${hint}`;
  if (code === "read_set_mismatch" && row.readSet != null && row.repeats != null) {
    const slot = row.slot ? `${row.slot} ran` : "the loop ran";
    return `${label}. A prior read returned ${row.readSet}; ${slot} ${row.repeats} times. Expose the full array the loop iterates, or iterate once per item.`;
  }
  return `${label}. ${row.reason}`;
}

export function refusalNext(row: Pick<Refusal, "code" | "hint">): string {
  if (row.hint) return row.hint;
  const code = row.code;
  if (code === "read_set_mismatch") {
    return "Expose the full array the loop iterates, or iterate once per item.";
  }
  if (code === "unbound_foreach") {
    return "Return one array of the items the loop will walk, then call the body once per item.";
  }
  if (code === "underdetermined_write" || code === "underdetermined_command") {
    return "Pass the write arguments from input or a prior step. Eden will not guess.";
  }
  if (code === "too_short") return "Wrap a stretch of at least three steps.";
  if (code === "no_envelope") return "Pass arguments (IDs, paths, queries) so Eden can witness valid values.";
  if (code === "empty_output") return "Check that the agent's tool calls succeed and return a useful result.";
  return "Wrap more runs, then come back.";
}
