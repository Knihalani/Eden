import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";
import type { UsageRecord } from "./trace";

// A3/D2006: `context_reset` — the agent compacted or replaced its transcript, so the session's shown marks clear
// and a later delivery of the same item is news again, not a repeat. The session itself stays open.

const DOC = {
  ref: "d1",
  title: "Globex renewal",
  text: "Dana Lee wants 12% off the Globex renewal, signed by 2026-11-20",
};
const setup = () => {
  const got: UsageRecord[] = [];
  const p = new ContextPartner({
    sources: async () => [new StaticSource("crm", "deals", [DOC])],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    config: CORE_CONFIG,
    onUsage: (u) => got.push(u),
  });
  return { p, got };
};
const ref = { tenantId: "t", userId: "u", sessionId: "s" };
const ev = (e: Record<string, unknown>) => ({ ...ref, at: Date.UTC(2026, 10, 7), ...e }) as AgentEvent;
const QUESTION = "Globex renewal with Dana Lee";

async function delivered(p: ContextPartner): Promise<string> {
  const r = await p.observe(ev({ kind: "user_message", text: QUESTION }), { waitMs: 1_000 });
  const inj = r.injection ?? p.takePending(ref)[0];
  if (!inj) throw new Error("nothing delivered");
  return inj.id;
}

describe("context_reset (D2006)", () => {
  test("a compacted session may be shown the same item again", async () => {
    const { p } = setup();
    await delivered(p);
    await p.observe(ev({ kind: "context_reset" }));
    // The same request after the reset: the item the agent no longer has is delivered again.
    const again = await delivered(p);
    expect(again).toBeTruthy();
  });

  test("the reset drops the outstanding marks quietly: a compaction is no verdict", async () => {
    const { p, got } = setup();
    await delivered(p);
    await p.observe(ev({ kind: "context_reset" }));
    expect(got).toEqual([]);
  });

  test("feedback on a pre-reset delivery still lands: `recorded` is the user's, not the marks'", async () => {
    const { p, got } = setup();
    const id = await delivered(p);
    await p.observe(ev({ kind: "context_reset" }));
    expect(p.feedback({ ...ref, injectionId: id, used: true, how: "explicit" })).toBe(true);
    expect(got).toEqual([{ sessionId: "s", injectionId: id, used: true, how: "explicit", sourceIds: ["crm"] }]);
  });

  test("without the reset the repeat stays blocked", async () => {
    const { p } = setup();
    await delivered(p);
    const r = await p.observe(ev({ kind: "user_message", text: QUESTION }), { waitMs: 1_000 });
    const inj = r.injection ?? p.takePending(ref)[0];
    expect(inj?.citations.map((c) => c.itemId) ?? []).not.toContain("crm:d1");
  });
});
