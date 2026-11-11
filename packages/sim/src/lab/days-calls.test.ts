import { describe, expect, test } from "bun:test";
import { callsWhere, daysCalls, parseRange, parseSeeds, scheduleArrivals, type PlantedRow } from "./days-calls";
import { planUser, suiteTemplates, userWorldOf } from "./pi-user";

const MIX = { hidden: 1, control: 1, neutral: 8 };

// A8: over a user's days with item-carrying notices, the recap's change re-reads nothing else (before D272 pi-ab sent
// it as a bare signal, which doubted every copy of the source and cost 1.6-2.0 gmail fetches a request).
describe("days-calls: connector calls over a user's days (A8)", () => {
  const fetchesAtRequest = (counts: Record<string, number>) =>
    callsWhere(counts, (phase, _source, op) => phase === "request" && op === "fetch");
  // One payload run serves the first two tests (D819): `onPlanted` only observes (its run's report is the same as one
  // without it, checked 2026-11-11), so the run with it is the run without it, at one run's CPU, not two.
  const planted: PlantedRow[] = [];
  let payload: ReturnType<typeof daysCalls> | undefined;
  const payloadRun = () =>
    (payload ??= daysCalls(41, { days: 2, push: "payload", onPlanted: (row) => void planted.push(row) }));

  test("payload notices that carry the changed items re-read nothing, and still announce and hold the change", async () => {
    const before = await daysCalls(41, { days: 2, push: "payload", recapSignal: true });
    const after = await payloadRun();
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
    const run = await payloadRun();
    const rows = planted;
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
          // M3's offline-screen fields (D900, D911): the planted id, the request and template, the pool's ids.
          .concat("today", "planted", "pool", "request", "template")
          .sort(),
      );
    }
  });

  // M3's corpus dump (D911): the user's items redacted and cut, and the planted rows' ids among them.
  test("onCorpus dumps the user's items; planted rows carry ids the corpus holds and the pool's ids", async () => {
    let items: { id: string; title: string; text: string }[] = [];
    const rows: PlantedRow[] = [];
    await daysCalls(41, {
      days: 1,
      push: "payload",
      onCorpus: (_seed, xs) => void (items = xs),
      onPlanted: (row) => void rows.push(row),
    });
    expect(items.length).toBeGreaterThan(500);
    for (const it of items) expect(it.text.length).toBeLessThanOrEqual(1_200);
    const ids = new Set(items.map((it) => it.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(ids.has(r.planted!)).toBe(true);
      expect(r.template).toMatch(/^train\d\//);
      expect(r.pool!.length).toBe(r.poolSize);
    }
  });

  test("signals are unchanged: a bare signal still doubts the source's copies, which are re-read", async () => {
    const signals = await daysCalls(41, { days: 2, push: "signals" });
    expect(fetchesAtRequest(signals.counts)).toBeGreaterThan(5);
    expect(signals.staleHeld).toBe(0);
  });

  // P4 (D841): `--move-after N` moves a handed item mid-session and reads its fate when the session ends.
  test("moveAfter: with notices every mid-session move is updated; without, owed updates by source add up", async () => {
    const told = await daysCalls(41, { days: 2, push: "payload", moveAfter: 2 });
    const mid = Object.values(told.midFates).reduce((a, b) => a + b, 0);
    expect(mid).toBeGreaterThan(0);
    expect(told.midFates.updated).toBe(mid);
    expect(told.midDelays.length).toBe(mid);
    for (const d of told.midDelays) expect(d).toBeGreaterThanOrEqual(0);
    const silent = await daysCalls(41, { days: 2, push: "payload", recapSilent: true, moveAfter: 2 });
    const owed = Object.values(silent.bySource).reduce((a, r) => a + r.owed, 0);
    const updated = Object.values(silent.bySource).reduce((a, r) => a + r.updated, 0);
    const recapOwed = silent.fates.updated + silent.fates.unpolled + silent.fates.unseen + silent.fates.undelivered;
    const midOwed = Object.values(silent.midFates).reduce((a, b) => a + b, 0);
    expect(owed).toBe(recapOwed + midOwed);
    expect(updated).toBe(silent.fates.updated + silent.midFates.updated);
    // Off, nothing moves mid-session and the recap's fates are the run's.
    const off = await daysCalls(41, { days: 2, push: "payload", recapSilent: true });
    expect(Object.values(off.midFates).reduce((a, b) => a + b, 0)).toBe(0);
    expect(Object.values(off.bySource).reduce((a, r) => a + r.owed, 0)).toBe(
      off.fates.updated + off.fates.unpolled + off.fates.unseen + off.fates.undelivered,
    );
  });
});

// P7 (D874, D875): weeks, more users, the long tail and silent arrivals.
describe("days-calls: weeks, the long tail and silent arrivals (D874, D875)", () => {
  test("seed ranges and LO-HI ranges parse; bad ones throw", () => {
    expect(parseSeeds("41-44,50")).toEqual([41, 42, 43, 44, 50]);
    expect(parseRange("0-10", "--arrive-days")).toEqual([0, 10]);
    expect(parseRange("3", "--x")).toEqual([3, 3]);
    expect(() => parseRange("5-2", "--x")).toThrow(/LO ≤ HI/);
    expect(() => parseSeeds("a")).toThrow(/--seeds/);
  });

  test("scheduleArrivals holds planted items until LO-HI days before their request, never neutral ones", () => {
    const plan = planUser(45, suiteTemplates(45, ["train1", "longtail"]), { days: 6, size: [12, 12], mix: MIX });
    const u = userWorldOf(45, plan);
    const items = u.world.items.length;
    const world = { ...u.world, items: [...u.world.items] };
    const { arrivals, lagOf } = scheduleArrivals(world, u.tasks, u.daySizes, 45, [1, 3]);
    const held = [...arrivals.values()].flat();
    expect(world.items.length + held.length).toBe(items);
    const dayOf = u.daySizes.flatMap((n, d) => Array.from({ length: n }, () => d));
    u.tasks.forEach((t, i) => {
      const day = [...arrivals].find(([, its]) => its.some((it) => it.id === t.planted))?.[0];
      if (t.kind === "neutral" || !t.planted) return expect(day).toBeUndefined();
      if (day === undefined) return expect(dayOf[i]! - 3).toBeLessThanOrEqual(0);
      expect(dayOf[i]! - day).toBeGreaterThanOrEqual(1);
      expect(dayOf[i]! - day).toBeLessThanOrEqual(3);
      expect(lagOf.get(t.id)).toBe("1-6d");
    });
    // No range, nothing held.
    expect(scheduleArrivals({ ...world }, u.tasks, u.daySizes, 45, null).arrivals.size).toBe(0);
  });

  test("a long-tail user over weeks: rare connectors listed, every planted request counted by class and lag", async () => {
    const u = await daysCalls(46, {
      days: 14,
      push: "payload",
      nightMs: 20 * 3_600_000,
      suites: ["train1", "train2", "longtail"],
      arriveDays: [0, 8],
    });
    expect(u.days).toBe(14);
    const by = Object.entries(u.surfacedBy);
    expect(by.some(([k]) => k.includes(" rare "))).toBe(true);
    const n = (kind: string) => by.filter(([k]) => k.startsWith(`${kind} `)).reduce((x, [, v]) => x + v.n, 0);
    expect(n("hidden")).toBe(u.surfaced.hidden!.n);
    expect(n("control")).toBe(u.surfaced.control!.n);
    expect(callsWhere(u.counts, (_p, src, op) => src === "notes" && op === "list")).toBeGreaterThan(0);
    // 14 days of one user: about 1 s alone, past bun's 5 s default under a parallel cold run.
  }, 60_000);
});
