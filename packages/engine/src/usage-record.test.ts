import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner } from "./partner";
import type { UsageRecord } from "./trace";

// D293: `onUsage` reports, content-free, whether the agent used each injection (inferred, D18; or explicit feedback,
// D13), so an integrator's digest can say how often Eden's context was used. Ids, counts and source ids only.

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

async function delivered(p: ContextPartner): Promise<string> {
  const r = await p.observe(ev({ kind: "user_message", text: "Globex renewal with Dana Lee" }), { waitMs: 1_000 });
  const inj = r.injection ?? p.takePending(ref)[0];
  if (!inj) throw new Error("nothing delivered");
  return inj.id;
}

describe("onUsage (D293)", () => {
  test("inferred use: the agent repeats the injection's distinctive terms", async () => {
    const { p, got } = setup();
    const id = await delivered(p);
    await p.observe(ev({ kind: "agent_message", text: "Dana Lee wants 12% off; it must be signed by 2026-11-20." }));
    expect(got).toEqual([{ sessionId: "s", injectionId: id, used: true, how: "inferred", sourceIds: ["crm"] }]);
    // No content in a record: only ids, a flag and the way it was learned.
    expect(JSON.stringify(got)).not.toContain("Dana");
  });

  test("not used by session end; explicit feedback afterwards corrects it and is reported too", async () => {
    const { p, got } = setup();
    const id = await delivered(p);
    await p.observe(ev({ kind: "session_end" }));
    expect(got.map((g) => [g.used, g.how])).toEqual([[false, "ended"]]);
    expect(p.feedback({ ...ref, injectionId: id, used: true, how: "explicit" })).toBe(true);
    expect(got.map((g) => [g.used, g.how])).toEqual([
      [false, "ended"],
      [true, "explicit"],
    ]);
    // The same answer again changes nothing and reports nothing.
    p.feedback({ ...ref, injectionId: id, used: true, how: "explicit" });
    expect(got.length).toBe(2);
  });

  test("explicit feedback while outstanding is reported once; a sink that throws never breaks the partner", async () => {
    const { p, got } = setup();
    const id = await delivered(p);
    p.feedback({ ...ref, injectionId: id, used: false, how: "explicit" });
    expect(got).toEqual([{ sessionId: "s", injectionId: id, used: false, how: "explicit", sourceIds: ["crm"] }]);
    const bad = new ContextPartner({
      sources: async () => [new StaticSource("crm", "deals", [DOC])],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      config: CORE_CONFIG,
      onUsage: () => {
        throw new Error("sink down");
      },
    });
    const id2 = await delivered(bad);
    expect(bad.feedback({ ...ref, injectionId: id2, used: true, how: "explicit" })).toBe(true);
  });
});
