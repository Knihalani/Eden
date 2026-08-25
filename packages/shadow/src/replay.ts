import type { StretchTrace, ToolRegistry } from "@eden/ir";
import { canonicalize, redact } from "@eden/ir";

/**
 * Why shadowing needs this at all.
 *
 * Shadowing replays a candidate program once per held-out trace to decide
 * whether it is good enough to ship. It was handed the *live* registry, so for
 * a mined stretch like [get_issue, update_issue, notify] it performed n real
 * updates and n real notifications — in order to decide whether the program
 * could be trusted to perform them. Validation is not allowed to be the thing
 * that does the damage.
 *
 * A recorded trace already contains the answer every tool gave, so the program
 * can be run against the recording instead. It still runs for real: it still
 * builds every argument from its own bindings, still evaluates its asserts,
 * still calls the island for real. Only the tools are served from tape.
 *
 * Every tool is replayed, not just the writes. Replaying the writes while
 * letting the reads hit the live world produces an incoherent world — the
 * TicketShip program writes a record and then calls verifyWrite to check it
 * landed, and against a live registry where the write was replayed rather than
 * performed, that check fails and the program is refused for a fault it does
 * not have. A shadow world has to be self-consistent to mean anything.
 */

/**
 * Thrown when the recording has no answer for a call the program made.
 *
 * Distinct from an ordinary failure on purpose: a compiled program runs the
 * checks the agent skipped — that is most of the point, and it is what
 * skipRateBefore/skipRateAfter measure — so a call the trace never made is
 * absence of evidence, not evidence of a fault. shadowProgram treats it as
 * "this trace cannot validate the program" rather than "the program is wrong".
 */
export class UnrecordedCall extends Error {
  readonly tool: string;
  constructor(tool: string) {
    super(`shadow: ${tool} was not recorded in this trace, so it cannot be replayed`);
    this.name = "UnrecordedCall";
    this.tool = tool;
  }
}

export function isUnrecordedCall(e: unknown): e is UnrecordedCall {
  // Walk the cause chain: the runtime wraps mid-run failures in DeoptError to
  // carry completion state, and the original UnrecordedCall rides along as
  // `cause` without losing its meaning.
  let cur: unknown = e;
  for (let depth = 0; cur != null && depth < 5; depth++) {
    if (cur instanceof UnrecordedCall || (cur as { name?: string })?.name === "UnrecordedCall") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

export type ReplayMiss = {
  tool: string;
  reason: "unrecorded" | "different-args";
  /** Present for different-args, to show what the program asked for instead. */
  args?: Record<string, unknown>;
};

export type ReplayRegistry = ToolRegistry & {
  /** Calls the program made that the recording could not answer. */
  misses: ReplayMiss[];
};

/** Same comparison shadow uses for outputs: redacted, then key-order-normalised. */
function sameArgs(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(redact(a)) === canonicalize(redact(b));
  } catch {
    return false;
  }
}

/**
 * A registry that answers every tool call from `trace`.
 *
 * Repeated calls to the same tool are served in the order the trace recorded
 * them, so a stretch that writes twice replays two distinct results rather
 * than the first one twice.
 *
 * A call the recording never saw is not passed through to the real tool and
 * not faked either: there is no recorded answer to give, and inventing one
 * would be inventing the very thing under test, so the call fails and the
 * divergence is reported.
 *
 * `base` is consulted only for `has()`, so coverage checks still see the real
 * tool set rather than whichever subset this one trace happened to exercise.
 */
export function replayRegistry(base: ToolRegistry | undefined, trace: StretchTrace): ReplayRegistry {
  const recorded = new Map<string, Array<{ args: Record<string, unknown>; result: unknown; ok: boolean }>>();
  for (const e of trace.events ?? []) {
    if (!e?.name) continue;
    const list = recorded.get(e.name);
    const entry = { args: e.args ?? {}, result: e.result, ok: e.ok !== false };
    if (list) list.push(entry);
    else recorded.set(e.name, [entry]);
  }
  const used = new Map<string, number>();
  const misses: ReplayMiss[] = [];

  return {
    misses,
    has: (name: string) => Boolean(base?.has?.(name)) || recorded.has(name),
    execute: async (name: string, args: Record<string, unknown>) => {
      const list = recorded.get(name) ?? [];
      const i = used.get(name) ?? 0;
      used.set(name, i + 1);
      const hit = list[i];
      if (!hit) {
        // Not necessarily a fault. A compiled program runs the checks the
        // agent skipped — that is most of the point, and it is what
        // skipRateBefore/skipRateAfter measure — so it can legitimately make a
        // call this particular trace never made. There is simply no recorded
        // answer, and calling the real tool is what this exists to prevent.
        misses.push({ tool: name, reason: "unrecorded", args });
        throw new UnrecordedCall(name);
      }
      // A divergence in arguments is recorded but not fatal. Any step
      // downstream of an island takes the model's fresh output as an argument,
      // so it will differ from the recording every single time — failing on
      // that would refuse every program with an island in it, which is most of
      // them. Whether the program got the *right answer* is decided by
      // comparing its final output against the trace, which is a question this
      // registry is the wrong place to answer. Its job is that nothing is
      // actually called.
      if (!sameArgs(hit.args, args)) misses.push({ tool: name, reason: "different-args", args });
      if (!hit.ok) throw new Error(`shadow: ${name} failed in the recorded trace`);
      return hit.result;
    },
  };
}
