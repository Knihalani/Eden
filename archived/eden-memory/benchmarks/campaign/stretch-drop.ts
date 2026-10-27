/**
 * Wave 8 rotation: 3-call stretch — transparent serve, host-drop, remainder skip.
 *
 * Home/canvas must name the whole stretch, not only the latest receipt word.
 * Not a retune of silent-drop (that world stays analogue cents + replica drop).
 *
 *   bun test benchmarks/campaign/stretch-drop.test.ts
 *
 * Pre-registered expect (ROADMAP §4.9) is `EXPECT` below.
 */

import { stretchWords, type StretchWord } from "@eden/measure";

/**
 * Pre-registered Wave 8 rotation verdict. Recorded before the run.
 * expect: stretchWords ["Served","Skipped","Degraded"]; Home `Live · Served · Skipped · Degraded`
 */
export const EXPECT =
  "3-call serve + host-drop + remainder skip (skip latest): stretchWords Served, Skipped, Degraded; " +
  "Home Live · Served · Skipped · Degraded";

export const TOOL_ID = "wf_stretch";

export const SERVE = {
  tool_id: TOOL_ID,
  created_at: 1,
  ok: 1,
  tokenClass: "transparent",
  outcome: "ok",
};

export const DROP = {
  tool_id: TOOL_ID,
  created_at: 2,
  ok: 1,
  outcome: "degraded",
  reason: "The host dropped the rewrite (updatedToolOutput). Original tool output was kept.",
};

export const SKIP = {
  tool_id: TOOL_ID,
  created_at: 3,
  ok: 1,
  tokenClass: "steered-skip",
  skipped: ["Grep"],
};

/** Chronological 3-call list; steered-skip is the latest row. */
export function stretchDropReceipts(): unknown[] {
  return [SERVE, DROP, SKIP];
}

export function stretchDropWords(): StretchWord[] {
  return stretchWords(stretchDropReceipts());
}

export function stretchDropInbox() {
  return {
    live: [{ id: TOOL_ID, name: "notify", state: "live" as const, stats: { n: 3, fail: 0 }, updated_at: 3 }],
  };
}
