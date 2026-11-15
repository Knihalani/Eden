import { describe, expect, test } from "bun:test";
import { REALISTIC, simSources } from "./sources";
import { runQuality } from "./quality";
import { applyDelete, planDeletes } from "./updates";
import { buildWorld } from "./world";

describe("source-side deletions (--deletes)", () => {
  test("planned only for fact-stating items, deterministic per seed; applied, the sources no longer serve them", async () => {
    const w = buildWorld({ seed: 7 });
    const plan = planDeletes(w, 5, 3, 0.2);
    expect(plan.length).toBeGreaterThan(0);
    expect(planDeletes(buildWorld({ seed: 7 }), 5, 3, 0.2)).toEqual(plan);
    expect(planDeletes(w, 5, 3, 0)).toEqual([]);
    const byId = new Map(w.items.map((i) => [i.id, i]));
    for (const d of plan) {
      expect(d.session).toBeGreaterThanOrEqual(1);
      for (const id of d.items) expect(byId.get(id)!.facts.length).toBeGreaterThan(0);
    }
    const first = plan[0]!;
    const victim = byId.get(first.items[0]!)!;
    const sources = simSources(w, REALISTIC, 0, 1);
    const src = sources.find((s) => s.id === victim.sourceId)!;
    expect(await src.fetch(victim.ref, { tenantId: "t", userId: "u" }, AbortSignal.timeout(1_000))).not.toBeNull();
    expect(applyDelete(w, first)).toEqual(new Set([victim.sourceId]));
    src.reindex();
    expect(w.items.some((i) => i.id === victim.id)).toBe(false);
    for (const f of victim.facts) expect(w.facts.get(f)!.items).not.toContain(victim.id);
    expect(await src.fetch(victim.ref, { tenantId: "t", userId: "u" }, AbortSignal.timeout(1_000))).toBeNull();
  });

  test("the quality run counts deleted deliveries; with payload notifications Eden delivers none", async () => {
    const base = { users: 1, sessionsPerUser: 4, seed: 2, profiles: REALISTIC, timeScale: 0, waitMs: 0, model: null };
    const pushed = await runQuality({ ...base, deletes: 0.3, push: "payload" });
    expect(pushed.deletes.applied).toBeGreaterThan(0);
    expect(pushed.deletes.deletedDelivered + pushed.deletes.deletedCited).toBe(0);
    expect(pushed.lostNotices).toBe(0);
    // `lostNotices` (A8): every notice lost, so the deletions reach Eden only through its sweeps, and are counted.
    const lost = await runQuality({ ...base, deletes: 0.3, push: "payload", lostNotices: 1 });
    expect(lost.lostNotices).toBeGreaterThan(0);
    expect(lost.deletes.applied).toBe(pushed.deletes.applied);
  }, 120_000); // Two quality runs: about 3 s alone, more under load: the main run's limit (D1965).
});
