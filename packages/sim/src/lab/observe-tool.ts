/**
 * A tool result reported to Eden by a lab harness (pi-ab, hermes-ab): the observe can hand out a packet queued since the
 * last one (the push's, when its check came late), and Eden then marks that packet's items shown to the agent. A client
 * places an observe's injection; a harness that dropped it left the agent without the packet, and a later
 * `ask_context` answer said "(shown above)" for items the agent never read (F1, dev20 rehearsal: 18 of 29 "reached,
 * not raised" facts). `place` is how the harness delivers it.
 */
import type { AgentEvent, Injection } from "@eden/protocol";

/** The part of a partner a harness reports a tool result to. */
export interface ToolObserver {
  observe(event: AgentEvent): Promise<{ injection: Injection | null }>;
}

/** Reports `event` and places the injection it hands out, if any; returns the injection's item count (0 for none). */
export async function observeToolResult(
  partner: ToolObserver,
  event: AgentEvent,
  place: (injection: Injection) => void,
): Promise<number> {
  const seen = await partner.observe(event);
  if (!seen.injection) return 0;
  place(seen.injection);
  return seen.injection.citations.length;
}
