import { describe, expect, test } from "bun:test";
import type { Trace } from "@eden/engine";
import type { AgentEvent } from "@eden/protocol";
import { StaticSource } from "@eden/sources";
import { buildPartner } from "./build";
import { digest, formatDigest } from "./digest";

// D293: "Eden caught this", over an EDEN_TRACE=1 log: traces and usage records, counts and connector ids only.

const t = (x: Partial<Trace>): string =>
  JSON.stringify({
    sessionId: "s",
    turn: 1,
    event: "user_message",
    decision: "silent",
    reason: "no candidates",
    latencyMs: 10,
    sourceCalls: 1,
    modelCalls: 0,
    costUsd: 0,
    itemIds: [],
    ...x,
  });
const u = (injectionId: string, used: boolean, how = "inferred", sourceIds = ["gmail"]) =>
  JSON.stringify({ usage: { sessionId: "s", injectionId, used, how, sourceIds } });

describe("digest (D293)", () => {
  test("kinds, connectors, use (last word per injection), silence and cost; no item ids printed", () => {
    const d = digest([
      "eden partner listening on http://127.0.0.1:8790",
      t({ decision: "sources", reason: "grounded-people", itemIds: ["gmail:msg-1"] }),
      t({ decision: "reader-push", reason: "candidates:1", candidates: true, itemIds: ["gmail:msg-1", "cal:ev-9"] }),
      t({ turn: 2, event: "agent_message", decision: "skipped", reason: "agent_message", sourceCalls: 0 }),
      t({ turn: 3, decision: "answer", reason: "ask", itemIds: ["drive:doc-3"] }),
      t({ turn: 4, decision: "answer", reason: "ask", itemIds: [] }),
      t({ turn: 5 }),
      u("inj_1", false, "expired"),
      u("inj_1", true, "explicit"), // a correction: the last word stands
      u("inj_2", false, "ended", ["cal"]),
    ]);
    expect(d.kinds).toEqual({ conflict: 1, candidates: 1, answer: 1 });
    expect(d.sources).toEqual({ gmail: 2, cal: 1, drive: 1 });
    expect(d.asks).toEqual({ total: 2, withItems: 1 });
    expect(d.used).toMatchObject({ measured: true, injections: 2, used: 1, explicit: 1 });
    expect(d.used.bySource).toEqual({ gmail: { injections: 1, used: 1 }, cal: { injections: 1, used: 0 } });
    expect(d.silent).toEqual({ events: 1, reasons: { "no candidates": 1 }, nothingToLookUp: 1 });
    const md = formatDigest(d);
    expect(md).toContain("The agent visibly used **1 of 2 injections (50%)**");
    expect(md).toContain("- gmail: 2; used in 1 of 1 injections");
    for (const id of ["msg-1", "ev-9", "doc-3", "inj_1"]) expect(md).not.toContain(id);
  });

  test("use is 'not measured' without agent events or feedback, never 0%; an empty log says how to make one", () => {
    const d = digest([t({ decision: "sources", reason: "cue:1", itemIds: ["crm:d1"] }), u("inj_1", false, "ended")]);
    expect(d.used.measured).toBe(false);
    expect(formatDigest(d)).toContain("**not measured**");
    expect(formatDigest(digest([]))).toContain("EDEN_TRACE=1");
  });

  test("reads what a real partner writes: traces and usage, with no item text in the log or the digest", async () => {
    const lines: string[] = [];
    const crm = new StaticSource("crm", "deals", [
      { ref: "d1", title: "Globex renewal", text: "Dana Lee wants 12% off the Globex renewal by 2026-11-20" },
    ]);
    const p = buildPartner({
      sources: async () => [crm],
      model: null,
      onTrace: (x) => lines.push(JSON.stringify(x)),
      onUsage: (x) => lines.push(JSON.stringify({ usage: x })),
    });
    const ev = (e: Record<string, unknown>) =>
      ({ tenantId: "t", userId: "u", sessionId: "s", at: Date.UTC(2026, 10, 7), ...e }) as AgentEvent;
    await p.observe(ev({ kind: "user_message", text: "Globex renewal with Dana Lee" }), { waitMs: 1_000 });
    p.takePending({ tenantId: "t", userId: "u", sessionId: "s" });
    await p.observe(ev({ kind: "agent_message", text: "Dana Lee wants 12% off, by 2026-11-20." }));
    p.stopSync();
    const d = digest(lines);
    expect(d.added).toBeGreaterThan(0);
    expect(d.used.measured).toBe(true);
    expect(d.used.used).toBeGreaterThan(0);
    for (const text of [lines.join("\n"), formatDigest(d)]) expect(text).not.toContain("Dana");
  });
});
