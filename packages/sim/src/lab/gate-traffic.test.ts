import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Label } from "../sessions";
import {
  ceilings,
  factKind,
  oracleFacts,
  poolHolds,
  READER_FACTS,
  ReuseLedger,
  reuseCeilings,
  reuseKeys,
} from "./gate-traffic";

describe("oracle facts", () => {
  test("a world fact's kind is the end of its id", () => {
    expect(factKind("arc-3:constraint")).toBe("constraint");
    expect(factKind("landlord:visit")).toBe("visit");
    expect(READER_FACTS.has("visit")).toBe(false);
    expect(READER_FACTS.has("blocker")).toBe(true);
  });

  test("only a need turn has facts; reader facts are the constraint kinds among must, then must and ok", () => {
    const need: Label = { kind: "need", must: ["m1:event", "t1:blocker"], ok: ["m1:constraint", "t1:status"] };
    const o = oracleFacts(need);
    expect([...o.must].sort()).toEqual(["m1:event", "t1:blocker"]);
    expect([...o.reader]).toEqual(["t1:blocker"]);
    expect([...o.readerOk].sort()).toEqual(["m1:constraint", "t1:blocker"]);
    for (const label of [{ kind: "context", ok: ["m1:constraint"] }, { kind: "silent" }] as Label[]) {
      const none = oracleFacts(label);
      expect(none.must.size + none.reader.size + none.readerOk.size).toBe(0);
    }
  });

  test("a pool holds a wanted fact only through an item stating it", () => {
    const facts = new Map<string, readonly string[]>([
      ["mail:a", ["m1:event"]],
      ["mail:b", ["m1:constraint"]],
    ]);
    expect(poolHolds(["mail:a"], new Set(["m1:constraint"]), facts)).toBe(false);
    expect(poolHolds(["mail:a", "mail:b"], new Set(["m1:constraint"]), facts)).toBe(true);
    expect(poolHolds(["mail:b"], new Set(), facts)).toBe(false);
  });

  test("ceilings are the preset's calls over the oracle's, 0 when the oracle makes none", () => {
    expect(ceilings(436, { must: 199, reader: 49, readerOk: 0 })).toEqual({
      must: 436 / 199,
      reader: 436 / 49,
      readerOk: 0,
    });
  });
});

describe("reuse across one user's sessions", () => {
  test("a key repeats only after an earlier call made it; exact input implies the same pool", () => {
    const ledger = new ReuseLedger();
    const first = ledger.seen(reuseKeys("book lunch", ["a", "b"], "meeting", ["b"]));
    expect(first).toEqual({ exact: false, pool: false, typeBinding: false });
    // Another wording on the same pool, binding set and type.
    const reworded = ledger.seen(reuseKeys("book a lunch", ["a", "b"], "meeting", ["b"]));
    expect(reworded).toEqual({ exact: false, pool: true, typeBinding: true });
    const again = ledger.seen(reuseKeys("book lunch", ["a", "b"], "meeting", ["b"]));
    expect(again).toEqual({ exact: true, pool: true, typeBinding: true });
    // The pool's order matters to the prompt; the binding set does not.
    const reordered = ledger.seen(reuseKeys("x", ["b", "a"], "meeting", ["b"]));
    expect(reordered.pool).toBe(false);
    expect(reordered.typeBinding).toBe(true);
    expect(ledger.seen(reuseKeys("x", ["c"], "deal", ["b"])).typeBinding).toBe(false);
  });

  test("a fresh ledger (another user) never sees the first user's keys", () => {
    const one = new ReuseLedger();
    one.seen(reuseKeys("book lunch", ["a"], "meeting", []));
    const other = new ReuseLedger();
    expect(other.seen(reuseKeys("book lunch", ["a"], "meeting", []))).toEqual({
      exact: false,
      pool: false,
      typeBinding: false,
    });
  });

  test("ceilings are calls over the calls not repeated", () => {
    expect(reuseCeilings(100, { exact: 0, pool: 20, typeBinding: 50 })).toEqual({
      exact: 1,
      pool: 1.25,
      typeBinding: 2,
    });
  });
});

describe("gate-traffic end to end (one seed, 15 sessions, no model)", () => {
  const out = join(mkdtempSync(join(tmpdir(), "gate-traffic-")), "g.json");
  const run = spawnSync(
    "bun",
    [join(import.meta.dir, "gate-traffic.ts"), "--seeds", "41", "--sessions", "15", "--reuse", "--json", out],
    { encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: "" } },
  );

  test("prints an oracle line and a reuse report per preset", () => {
    expect(run.status).toBe(0);
    expect(run.stdout.match(/^ {2}oracle gate: /gm)?.length).toBe(4);
    expect(run.stdout.match(/^ {2}reuse across one user's sessions: /gm)?.length).toBe(4);
  });

  test("the oracles and reuse counts are consistent with the calls", () => {
    type S = {
      calls: number;
      gated: number;
      skipped: number;
      bindingInPool: number;
      oracleCalls: { must: number; reader: number; readerOk: number };
      unreadNeed: number;
      unreadReaderNeed: number;
      reuseCalls: { exact: number; pool: number; typeBinding: number };
    };
    const results = (JSON.parse(readFileSync(out, "utf8")) as { results: Record<string, { all: S }> }).results;
    for (const { all } of Object.values(results)) {
      const o = all.oracleCalls;
      // Needed reader facts are a subset of needed facts and of the reader facts needed or usable.
      expect(o.reader).toBeLessThanOrEqual(o.must);
      expect(o.reader).toBeLessThanOrEqual(o.readerOk);
      // An oracle calls at most once for each message read or gated.
      expect(o.must).toBeLessThanOrEqual(all.calls + all.gated);
      expect(o.must).toBeLessThanOrEqual(all.bindingInPool);
      expect(all.unreadReaderNeed).toBeLessThanOrEqual(all.unreadNeed);
      expect(all.unreadNeed).toBeLessThanOrEqual(all.skipped);
      const u = all.reuseCalls;
      expect(u.exact).toBeLessThanOrEqual(u.pool);
      expect(u.pool).toBeLessThanOrEqual(all.calls);
      expect(u.typeBinding).toBeLessThanOrEqual(all.calls);
    }
    // With no gate and every request read, the any-fact oracle calls exactly where a pool holds a needed item.
    expect(results.NEW2!.all.oracleCalls.must).toBe(results.NEW2!.all.bindingInPool);
  });
});
