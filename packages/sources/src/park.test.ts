/**
 * D754: a (user, source) pair's guards are parked once no call has taken them for twenty minutes and they hold
 * nothing a new set would not, and come back as they were (docs/research/o4-per-source.md). Each test holds one
 * part of `SourceFanout.park`.
 */
import { describe, expect, test } from "bun:test";
import type { ContextItem } from "@eden/protocol";
import { RollingHistogram } from "@eden/primitives";
import { SourceFanout } from "./guarded";
import type { SearchQuery, Source } from "./source";

const IDLE_MS = 1_200_000;
const scope = { tenantId: "t", userId: "u" };
const other = { tenantId: "t", userId: "v" };
const query = (text: string, who = scope): SearchQuery => ({ scope: who, text, entities: [], limit: 5 });
const item = (id: string): ContextItem => ({ id: `${id}:1`, sourceId: id, ref: "1", title: "t", text: "x" });

function source(id: string, behave: () => Promise<ContextItem[]> = async () => [item(id)]): Source & { calls: number } {
  const s = { id, kind: "test", description: "", calls: 0, search: () => (s.calls++, behave()) };
  return s;
}
function fanout(extra: Record<string, unknown> = {}) {
  const clock = { now: 1_000_000 };
  const f = new SourceFanout({
    sanitize: (x) => x,
    cacheBytes: 0,
    ratePerSec: 1_000,
    burst: 1_000,
    now: () => clock.now,
    ...extra,
  });
  const ask = async (src: Source, text: string, who = scope) =>
    (await f.search([src], query(text, who), { timeoutMs: 1_000 }))[0]!.status;
  return { f, clock, ask };
}

describe("SourceFanout.park (D754)", () => {
  test("idle pairs' guards are parked as later calls come, 64 a call, and not before twenty minutes", async () => {
    const { f, clock, ask } = fanout();
    const idle = Array.from({ length: 100 }, (_, i) => source(`s${i}`));
    for (const s of idle) await ask(s, "a");
    expect(f.guards()).toEqual({ live: 100, parked: 0 });
    const busy = source("busy");
    clock.now += IDLE_MS - 1;
    await ask(busy, "a");
    expect(f.guards().live).toBe(101);
    clock.now += 1;
    await ask(busy, "b");
    expect(f.guards().live).toBe(37);
    await ask(busy, "c");
    // The pair that is in use stays.
    expect(f.guards().live).toBe(1);
    expect(busy.calls).toBe(3);
  });

  test("idle is since the pair's last call, not its first", async () => {
    const { f, clock, ask } = fanout();
    const s = source("s");
    await ask(s, "a");
    clock.now += IDLE_MS - 1;
    await ask(s, "b");
    clock.now += 2;
    await ask(source("else"), "a", other);
    expect(f.guards()).toEqual({ live: 2, parked: 0 });
  });

  test("a parked pair comes back with the concurrency limit it had learned", async () => {
    const slow = () => Bun.sleep(10).then(() => [item("s")]);
    for (const parkIt of [true, false]) {
      const { f, clock, ask } = fanout();
      const s = source("s", slow);
      // Three answered calls: the limit grows from 2 to 3.
      for (const q of ["a", "b", "c"]) await ask(s, q);
      if (parkIt) {
        clock.now += IDLE_MS;
        await ask(source("else"), "a", other);
        expect(f.guards()).toEqual({ live: 1, parked: 1 });
      }
      // Three at once all go. (A new limiter, at 2, would call the third busy: the control below.)
      expect(await Promise.all(["d", "e", "f"].map((q) => ask(s, q)))).toEqual(["ok", "ok", "ok"]);
    }
    const { ask } = fanout();
    const fresh = source("s", slow);
    expect((await Promise.all(["d", "e", "f"].map((q) => ask(fresh, q)))).sort()).toEqual(["busy", "ok", "ok"]);
  });

  test("a limit a failed call backed off is kept too", async () => {
    const { f, clock, ask } = fanout({ breaker: { minCalls: 100 } });
    const s = source("s", async () => {
      throw new Error("down");
    });
    // Eight failures: the limit falls from 2 to under 1 and stays at its floor, 1.
    for (let i = 0; i < 8; i++) await ask(s, `q${i}`);
    clock.now += IDLE_MS;
    await ask(source("else"), "a", other);
    expect(f.guards()).toEqual({ live: 1, parked: 1 });
    const slow = source("s", () => Bun.sleep(10).then(() => [item("s")]));
    expect((await Promise.all(["a", "b"].map((q) => ask(slow, q)))).sort()).toEqual(["busy", "ok"]);
  });

  test("a pair whose breaker is not closed is kept, and does not hold up the scan", async () => {
    const { f, clock, ask } = fanout({ breaker: { minCalls: 2, failureRate: 0.5, openMs: 30_000 } });
    const down = source("down", async () => {
      throw new Error("down");
    });
    expect(await ask(down, "a")).toBe("error");
    expect(await ask(down, "b")).toBe("error");
    expect(await ask(down, "c")).toBe("open");
    const fine = Array.from({ length: 5 }, (_, i) => source(`s${i}`));
    for (const s of fine) await ask(s, "a");
    clock.now += IDLE_MS;
    await ask(source("else"), "a", other);
    // The five healthy pairs behind the broken one were parked; the broken one's guards are still there.
    expect(f.guards()).toEqual({ live: 2, parked: 5 });
    // Half-open, as it would be had nothing been parked: one failed probe opens it again at once (a new breaker
    // would take two failures).
    expect(await ask(down, "d")).toBe("error");
    expect(await ask(down, "e")).toBe("open");
  });

  test("a pair with a call in flight is kept", async () => {
    const { f, clock, ask } = fanout();
    let release!: (x: ContextItem[]) => void;
    const hung = source("hung", () => new Promise<ContextItem[]>((r) => (release = r)));
    const flying = f.search([hung], query("a"), { timeoutMs: 5_000 });
    await Bun.sleep(1);
    clock.now += IDLE_MS;
    await ask(source("else"), "a", other);
    expect(f.guards()).toEqual({ live: 2, parked: 0 });
    release([item("hung")]);
    expect((await flying)[0]!.status).toBe("ok");
  });

  test("forget drops a user's parked limits with their guards", async () => {
    const { f, clock, ask } = fanout();
    for (const q of ["a", "b"]) await ask(source("s"), q);
    await ask(source("mine"), "a", other);
    clock.now += IDLE_MS;
    await ask(source("else"), "a", { tenantId: "t", userId: "w" });
    expect(f.guards()).toEqual({ live: 1, parked: 2 });
    f.forget(scope);
    expect(f.guards()).toEqual({ live: 1, parked: 1 });
    f.forget(other, "mine");
    expect(f.guards()).toEqual({ live: 1, parked: 0 });
  });

  test("a pair whose planner calls' latency history is not empty is kept (a report can come long after its call)", async () => {
    const { f, clock, ask } = fanout();
    await ask(source("s"), "a");
    // A planner call that began with the lookup reports fifteen minutes on: the pair's history holds a sample,
    // though no call has taken the pair since.
    clock.now += 15 * 60_000;
    const per = (f as unknown as { per: Map<string, { callLatency?: RollingHistogram }> }).per;
    const state = [...per.values()][0]!;
    state.callLatency = new RollingHistogram(600_000, () => clock.now);
    state.callLatency.record(5);
    clock.now += 5 * 60_000;
    await ask(source("else"), "a", other);
    expect(f.guards()).toEqual({ live: 2, parked: 0 });
    // Twenty minutes after the sample it has run out, and the pair is parked.
    clock.now += IDLE_MS;
    await ask(source("else"), "b", other);
    expect(f.guards()).toEqual({ live: 1, parked: 1 });
  });

  test("a breaker with a window longer than the idle time keeps its counted failures", async () => {
    const down = () =>
      source("s", async () => {
        throw new Error("down");
      });
    const run = async (parkIt: boolean) => {
      const { f, clock, ask } = fanout({ breaker: { windowMs: 60 * 60_000, minCalls: 5, failureRate: 0.5 } });
      const s = down();
      for (let i = 0; i < 4; i++) await ask(s, `q${i}`);
      clock.now += IDLE_MS + 60_000;
      if (parkIt) await ask(source("else"), "a", other);
      // The fifth failure in the hour opens it, parked on the way or not: the pair was not parked.
      return { live: f.guards().live, statuses: [await ask(s, "x"), await ask(s, "y")] };
    };
    expect((await run(true)).statuses).toEqual(["error", "open"]);
    expect((await run(false)).statuses).toEqual(["error", "open"]);
    expect((await run(true)).live).toBe(2);
  });

  test("a rate-limit push-back still standing keeps the pair", async () => {
    const { f, clock, ask } = fanout();
    await ask(
      source("s", async () => {
        throw new Error("429 Too Many Requests, retry after 3000");
      }),
      "a",
    );
    clock.now += IDLE_MS;
    await ask(source("else"), "a", other);
    expect(f.guards()).toEqual({ live: 2, parked: 0 });
  });

  test("a rate-limit error reported for a parked pair is noted as it would be on its guards", async () => {
    const fetching = () => ({ ...source("s"), fetch: async () => item("s") });
    const run = async (parkIt: boolean) => {
      const { f, clock, ask } = fanout();
      const s = fetching();
      await ask(s, "a");
      clock.now += IDLE_MS;
      if (parkIt) {
        await ask(source("else"), "a", other);
        expect(f.guards()).toEqual({ live: 1, parked: 1 });
      }
      f.rateLimited(scope, "s", "429 Too Many Requests, retry after 30");
      return f.fetchChecked(s, scope, "1", { timeoutMs: 1_000 });
    };
    const kept = await run(false);
    expect(kept).toMatchObject({ pushedBack: true });
    expect(await run(true)).toEqual(kept);
  });

  test("parked limits are bounded as guards are: past `maxStates` the oldest is let go", async () => {
    const { f, clock, ask } = fanout({ maxStates: 10 });
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 10; i++) await ask(source(`s${round}-${i}`), "a");
      clock.now += IDLE_MS;
    }
    const g = f.guards();
    expect(g.live).toBeLessThanOrEqual(10);
    expect(g.parked).toBeLessThanOrEqual(10);
    expect(g.parked).toBeGreaterThan(0);
  });
});
