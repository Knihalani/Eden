/**
 * An eval scenario: a user's sources, and scripted sessions whose turns say what the partner should deliver.
 *
 * `expect` on a turn is the gold label:
 * - `{ "items": ["crm:deal-9"] }`: these items should reach the agent by this turn's delivery or the next one's
 *   (the slow path may deliver one event late);
 * - `"silent"`: nothing should be delivered at this turn;
 * - absent: the turn is not scored.
 */
import type { AgentEvent } from "@eden/protocol";
import type { StaticDoc } from "@eden/sources";

export type TurnEvent = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, "tenantId" | "userId" | "sessionId" | "at">
    : never
  : never;

export interface Turn {
  event: TurnEvent;
  expect?: { items: string[] } | "silent";
}

export interface Scenario {
  id: string;
  description: string;
  sources: { id: string; description: string; docs: StaticDoc[] }[];
  sessions: { id: string; turns: Turn[] }[];
}
