import { describe, expect, test } from "bun:test";
import { callsWhere, daysCalls, type PlantedRow } from "./days-calls";

// A8: over a user's days with item-carrying notices, the recap's change re-reads nothing else (before D272 pi-ab sent
// it as a bare signal, which doubted every copy of the source and cost 1.6-2.0 gmail fetches a request).
describe("days-calls: connector calls over a user's days (A8)", () => {
  const fetchesAtRequest = (counts: Record<string, number>) =>
    callsWhere(counts, (phase, _source, op) => phase === "request" && op === "fetch");

  test("payload notices that carry the changed items re-read nothing, and still announce and hold the change", async () => {
    const before = await daysCalls(41, { days: 2, push: "payload", recapSignal: true });
    const after = await daysCalls(41, { days: 2, push: "payload" });
    expect(before.changed).toBeGreaterThan(0);
    expect(after.changed).toBe(before.changed);
    // The bare signal doubted every gmail copy read before it: the next day's deliveries re-read them.
    expect(fetchesAtRequest(before.counts)).toBeGreaterThan(5);
    expect(fetchesAtRequest(after.counts)).toBe(0);
    expect(after.freshness.calls).toBe(0);
    // Its poll found nothing the items did not carry: the notice's listing goes too.
    expect(callsWhere(after.counts, (phase) => phase === "notice")).toBe(0);
    // D205 and D126 hold: the agent still gets the "updated:" packets, and no old copy is held undoubted.
    expect(after.updatePackets).toBe(before.updatePackets);
    expect(after.updatePackets).toBeGreaterThan(0);
    expect(after.staleHeld).toBe(0);
    expect(before.staleHeld).toBe(0);
  });

  // O3 (D712): `--pool-diag`. One row a hidden or control request, ids and flags only, consistent with `surfaced`.
  test("onPlanted reports where each planted item was in the push's pool", async () => {
    const rows: PlantedRow[] = [];
    const run = await daysCalls(41, { days: 2, push: "payload", onPlanted: (row) => void rows.push(row) });
    const n = Object.values(run.surfaced).reduce((sum, k) => sum + k.n, 0);
    expect(n).toBeGreaterThan(0);
    expect(rows.length).toBe(n);
    expect(rows.filter((r) => r.got).length).toBe(Object.values(run.surfaced).reduce((sum, k) => sum + k.got, 0));
    for (const r of rows) {
      expect(r.seed).toBe(41);
      expect(r.rank).toBeLessThan(r.poolSize);
      if (!r.pushRan) expect(r.rank).toBe(-1);
      if (r.pushed) expect(r.got).toBe(true);
      expect(Object.keys(r).sort()).toEqual(
        ["day", "got", "handed", "kind", "like", "likeAhead", "poolSize", "pushRan", "pushed", "rank", "seed", "task"]
          .concat("today")
          .sort(),
      );
    }
  });

  test("signals are unchanged: a bare signal still doubts the source's copies, which are re-read", async () => {
    const signals = await daysCalls(41, { days: 2, push: "signals" });
    expect(fetchesAtRequest(signals.counts)).toBeGreaterThan(5);
    expect(signals.staleHeld).toBe(0);
  });
});
