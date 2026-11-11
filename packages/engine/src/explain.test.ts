import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget } from "@eden/llm";
import type { AgentEvent } from "@eden/protocol";
import { QueryPlanner, StaticSource } from "@eden/sources";
import { ItemCache } from "./cache";
import { CORE_CONFIG } from "./parts";
import { ContextPartner, EXPLAIN_TRACES } from "./partner";
import { explainTrace, SILENT_REASONS, type Trace } from "./trace";

// D277: `explain` keeps a session's last decisions (its traces), content-free, for "why this packet / why silent".

const partner = () =>
  new ContextPartner({
    sources: async () => [
      new StaticSource("crm", "deals", [{ ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off" }]),
    ],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    config: CORE_CONFIG,
  });
const ref = { tenantId: "t", userId: "u", sessionId: "s" };
const ev = (e: Record<string, unknown>) => ({ ...ref, at: Date.UTC(2026, 10, 7), ...e }) as AgentEvent;

describe("explain (D277)", () => {
  test("holds what onTrace got, at most EXPLAIN_TRACES, oldest dropped", async () => {
    const p = partner();
    for (let i = 0; i < EXPLAIN_TRACES + 8; i++) await p.observe(ev({ kind: "agent_message", text: `ok ${i}` }));
    const got = p.explain(ref);
    expect(got.length).toBe(EXPLAIN_TRACES);
    expect(got[0]!.turn).toBe(9);
    expect(got.at(-1)!.turn).toBe(EXPLAIN_TRACES + 8);
  });

  test("a copy: changing it changes nothing held; forget and session_end drop it", async () => {
    const p = partner();
    await p.observe(ev({ kind: "user_message", text: "Globex renewal with Dana Lee" }), { waitMs: 1_000 });
    const before = JSON.stringify(p.explain(ref));
    const copy = p.explain(ref);
    copy[0]!.reason = "changed";
    copy[0]!.itemIds.push("x");
    expect(JSON.stringify(p.explain(ref))).toBe(before);
    p.explain(ref).length = 0;
    expect(p.explain(ref).length).toBeGreaterThan(0);
    expect(p.explain({ ...ref, userId: "other" })).toEqual([]);
    p.forget({ tenantId: "t", userId: "u" });
    expect(p.explain(ref)).toEqual([]);
    await p.observe(ev({ kind: "user_message", text: "Globex" }));
    await p.observe(ev({ kind: "session_end" }));
    expect(p.explain(ref)).toEqual([]);
  });

  test("a copy all the way down: a trace's plans too (audit A11)", async () => {
    const p = new ContextPartner({
      sources: async () => [
        new StaticSource("crm", "deals", [{ ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off" }]),
      ],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      planner: new QueryPlanner({ seed: 1 }),
      config: CORE_CONFIG,
    });
    for (let i = 0; i < 4; i++) {
      await p.observe(ev({ kind: "user_message", text: `Globex renewal for Dana Lee, item ${101 + i}?` }), {
        waitMs: 1_000,
      });
    }
    const planned = p.explain(ref).find((t) => (t.plans?.length ?? 0) > 0);
    expect(planned).toBeDefined();
    const before = JSON.stringify(p.explain(ref));
    planned!.plans![0]!.calls = 999;
    planned!.plans![0]!.shapes.push("changed");
    expect(JSON.stringify(p.explain(ref))).toBe(before);
  });

  test("every decision and known silent reason has its own sentence", () => {
    const base: Trace = {
      sessionId: "s",
      turn: 1,
      event: "user_message",
      decision: "silent",
      reason: "",
      latencyMs: 1,
      sourceCalls: 0,
      modelCalls: 0,
      costUsd: 0,
      itemIds: [],
    };
    const decisions: Trace["decision"][] = [
      "skipped",
      "repeat",
      "fast",
      "sources",
      "model",
      "answer",
      "reader-push",
      "reader-late",
      "check-late",
      "verify",
    ];
    const silent = ["slow path busy", "no candidates", "served", "no model", "no model budget", "model: none"];
    const all = [
      ...decisions.map((decision) => explainTrace({ ...base, decision, reason: "cue:abc" })),
      ...silent.map((reason) => explainTrace({ ...base, reason })),
    ];
    expect(new Set(all).size).toBe(all.length);
    // The paths whose sentence would otherwise mislead (review of D277).
    expect(explainTrace({ ...base, decision: "reader-push", candidates: true, itemIds: ["a", "b"] })).toContain(
      "2 items as candidates",
    );
    expect(explainTrace({ ...base, decision: "reader-push" })).toContain("made no reading");
    expect(explainTrace({ ...base, decision: "sources", reason: "updated:inj_1", itemIds: ["a"] })).toContain(
      "newer version",
    );
    expect(explainTrace({ ...base, decision: "fast", reason: "action-party", itemIds: ["a"] })).toContain(
      "party check",
    );
    expect(explainTrace({ ...base, decision: "reader-push", readerCalls: 1 })).toContain("reader read it");
  });

  test("SILENT_REASONS names every silent reason partner.ts writes (trace-report and digest print only these)", async () => {
    const src = await Bun.file(new URL("./partner.ts", import.meta.url)).text();
    const written = [
      ...src.matchAll(/(?:done|trace)\("silent", "([^"]+)"\)/g),
      ...src.matchAll(/noModel\("([^"]+)"/g),
      ...src.matchAll(/"(no model(?: budget)?)"/g),
    ].map((m) => m[1]!);
    expect(written.length).toBeGreaterThan(8);
    for (const r of written) expect(SILENT_REASONS).toContain(r);
    // A silent trace's reason is otherwise a variable (`why`): its values are the noModel calls' above.
    expect([...src.matchAll(/done\("silent", (?!")([^)]+)\)/g)].map((m) => m[1])).toEqual(["why"]);
  });
});
