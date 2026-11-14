import { describe, expect, test } from "bun:test";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel } from "@eden/llm";
import { ItemCache } from "./cache";
import { ContextPartner } from "./partner";
import { CORE_CONFIG } from "./parts";
import { checkMessages, PushChecker, type PushCheckInput, type SheetCard } from "./push-check";
import { SHEET_REUSE_WEIGHT, SHEET_TTL_MS, SheetCachePolicy, SystemTtlPolicy } from "./sheet-cache";

// D1800: the rule sheet carries its 1-hour cache breakpoint only when caching it is likely to pay for that user. The
// bytes the model reads never change with it.

const MIN = 60_000;
const T0 = Date.parse("2026-11-13T09:00:00Z");

const SHEET: SheetCard[] = [
  { id: "mail:a", kind: "prohibition", statement: "no alcohol", title: "Prescription", source: "health" },
  { id: "mail:b", kind: "freeze", statement: "payments to Harlow on hold", title: "Harlow", source: "mail" },
];
const INPUT: PushCheckInput = {
  request: "Pay the Harlow deposit",
  today: "2026-11-13",
  items: [{ id: "x", hash: "1", source: "mail", title: "Hold", text: "On hold.", date: "2026-11-12", from: "" }],
  sheet: SHEET,
};

/** Checks `n` times, `gapMin` minutes apart from `start`, noting each as answered; returns what each was told. */
function run(p: SheetCachePolicy, user: string, n: number, gapMin: number, start = T0, hash = "h1"): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const now = start + i * gapMin * MIN;
    const marked = p.mark(user, hash, now);
    p.note(user, hash, now, marked);
    out.push(marked);
  }
  return out;
}

describe("SheetCachePolicy (D1800)", () => {
  test("a new user's sheet goes plain; one whose checks come minutes apart has it marked from the third", () => {
    const p = new SheetCachePolicy();
    // The second check is the first that says how far apart they come.
    const marks = run(p, "t/u", 6, 10);
    expect(marks.slice(0, 2)).toEqual([false, false]);
    expect(marks.slice(2).every(Boolean)).toBe(true);
  });

  test("a user whose checks are more than an hour apart never pays the write", () => {
    const p = new SheetCachePolicy();
    expect(run(p, "t/u", 40, 90).some(Boolean)).toBe(false);
  });

  test("a sheet in the cache stays marked (a read), whatever the average says", () => {
    const p = new SheetCachePolicy();
    // A long light history: the average is near 0.
    run(p, "t/u", 64, 120);
    const at = T0 + 64 * 120 * MIN;
    // Marked once by hand (as a write would be), the next check within the hour reads it.
    p.note("t/u", "h1", at, true);
    expect(p.mark("t/u", "h1", at + 30 * MIN)).toBe(true);
    // Past the hour, or with another sheet, it is a write again, which the light average refuses.
    expect(p.mark("t/u", "h1", at + SHEET_TTL_MS + MIN)).toBe(false);
    expect(p.mark("t/u", "h2", at + 30 * MIN)).toBe(false);
  });

  test("a changed sheet is a write: marked for a user whose sheet is usually reused, plain for one whose is not", () => {
    const heavy = new SheetCachePolicy();
    run(heavy, "t/u", 32, 10);
    expect(heavy.mark("t/u", "h2", T0 + 32 * 10 * MIN)).toBe(true);
    // A sheet that changes at every check is never read: the average falls and the sheet goes plain.
    const churn = new SheetCachePolicy();
    for (let i = 0; i < 32; i++) {
      const now = T0 + i * 10 * MIN;
      churn.note("t/u", `h${i}`, now, churn.mark("t/u", `h${i}`, now));
    }
    expect(churn.mark("t/u", "h-next", T0 + 32 * 10 * MIN)).toBe(false);
  });

  test("the average follows a user who slows down", () => {
    const p = new SheetCachePolicy();
    run(p, "t/u", 64, 10);
    const later = T0 + 64 * 10 * MIN;
    // Two weights' worth of checks two hours apart pulls the average under the bar.
    const marks = run(p, "t/u", Math.ceil(2 / SHEET_REUSE_WEIGHT), 120, later);
    expect(marks.at(-1)).toBe(false);
  });

  test("isolation: per tenant/user; one user's history marks nothing for another with the same sheet", () => {
    const p = new SheetCachePolicy();
    run(p, "t1/u1", 10, 10);
    const now = T0 + 10 * 10 * MIN;
    expect(p.mark("t1/u1", "h1", now)).toBe(true);
    expect(p.mark("t1/u2", "h1", now)).toBe(false);
    expect(p.mark("t2/u1", "h1", now)).toBe(false);
    p.forget("t1/u1");
    expect(p.mark("t1/u1", "h1", now)).toBe(false);
  });

  test("bounded: the least recently checked user goes first", () => {
    const p = new SheetCachePolicy(3);
    for (const u of ["a", "b", "c", "d"]) run(p, u, 3, 10);
    expect(p.size).toBe(3);
    // "a" was dropped: it starts over, plain.
    expect(p.mark("a", "h1", T0 + 30 * MIN)).toBe(false);
    expect(p.mark("d", "h1", T0 + 30 * MIN)).toBe(true);
  });
});

describe("the sheet's breakpoint changes no byte the model reads", () => {
  test("checkMessages with and without it: the same roles and text, only the cache fields differ", () => {
    const on = checkMessages(INPUT);
    const off = checkMessages(INPUT, { sheetCache: false });
    expect(on.map((m) => [m.role, m.content])).toEqual(off.map((m) => [m.role, m.content]));
    expect(on[1]).toMatchObject({ cache: true, cacheTtl: "1h" });
    expect(off[1]!.cache).toBeUndefined();
    expect(off[1]!.cacheTtl).toBeUndefined();
    expect(off.some((m) => m.cache || m.cacheTtl)).toBe(false);
  });
});

describe("PushChecker follows the policy per user (D1800)", () => {
  const ok = () => new FakeModel(() => '{"items":[]}');
  const signal = new AbortController().signal;
  const u1 = { tenantId: "t", userId: "u1" };
  const u2 = { tenantId: "t", userId: "u2" };

  test("a user checking every ten minutes gets the breakpoint from the third check; another user does not", async () => {
    const model = ok();
    let now = T0;
    const checker = new PushChecker({ model, budget: new Budget(), now: () => now });
    for (let i = 0; i < 4; i++, now += 10 * MIN) await checker.check(u1, "s1", INPUT, signal);
    await checker.check(u2, "s2", INPUT, signal);
    const sheetOf = (i: number) => model.calls[i]!.messages[1]!;
    for (const i of [0, 1]) expect(sheetOf(i).cache).toBeUndefined();
    for (const i of [2, 3]) expect(sheetOf(i)).toMatchObject({ cache: true, cacheTtl: "1h" });
    expect(sheetOf(4).cache).toBeUndefined();
    // The text is the same whichever way it went.
    expect(new Set(model.calls.map((c) => c.messages[1]!.content)).size).toBe(1);
  });

  test("a failed call is not noted: it may never have reached the provider", async () => {
    let fail = true;
    const model = new FakeModel(() => {
      if (fail) throw new Error("down");
      return '{"items":[]}';
    });
    let now = T0;
    const checker = new PushChecker({ model, budget: new Budget(), now: () => now });
    await checker.check(u1, "s1", INPUT, signal);
    expect(checker.sheetUsers).toBe(0);
    fail = false;
    now += 10 * MIN;
    await checker.check(u1, "s1", INPUT, signal);
    expect(checker.sheetUsers).toBe(1);
  });

  test("a call whose session ended while it ran (a forget aborts it) leaves no state behind", async () => {
    let answer: () => void = () => {};
    const model = new FakeModel(() => '{"items":[]}');
    const slow = {
      id: "slow",
      chat: async (r: Parameters<FakeModel["chat"]>[0]) => {
        await new Promise<void>((done) => (answer = done));
        return model.chat(r);
      },
    };
    const checker = new PushChecker({ model: slow, budget: new Budget(), now: () => T0 });
    const ac = new AbortController();
    const running = checker.check(u1, "s1", INPUT, ac.signal);
    await Promise.resolve();
    ac.abort();
    answer();
    await running;
    expect(checker.sheetUsers).toBe(0);
  });

  test("no sheet, no state", async () => {
    const checker = new PushChecker({ model: ok(), budget: new Budget() });
    await checker.check(u1, "s1", { ...INPUT, sheet: [] }, signal);
    expect(checker.sheetUsers).toBe(0);
  });

  test("the partner's forget and release drop the user's state", async () => {
    const checker = new PushChecker({ model: ok(), budget: new Budget(), now: () => T0 });
    const partner = new ContextPartner({
      sources: async () => [],
      sourceMap: new SourceMap(),
      cache: new ItemCache(),
      budget: new Budget(),
      model: null,
      now: () => T0,
      config: { ...CORE_CONFIG },
      checker,
    });
    await checker.check(u1, "s1", INPUT, signal);
    await checker.check(u2, "s2", INPUT, signal);
    expect(checker.sheetUsers).toBe(2);
    partner.forget(u1);
    expect(checker.sheetUsers).toBe(1);
    partner.release(u2, false);
    expect(checker.sheetUsers).toBe(0);
  });
});

describe("SystemTtlPolicy: the instructions' TTL under a plain sheet (D1800, D1810)", () => {
  const notes = (p: SystemTtlPolicy, tenant: string, n: number, gapMin: number, start = T0, marked = false) => {
    for (let i = 0; i < n; i++) p.note(tenant, start + i * gapMin * MIN, marked);
  };

  test("checks minutes apart get the hour; a minute or two apart, five minutes; hours apart, none (D1810)", () => {
    const p = new SystemTtlPolicy();
    expect(p.ttl("busy", T0)).toBe("5m");
    notes(p, "busy", 2, 10);
    expect(p.ttl("busy", T0)).toBe("1h");
    // Checks a minute or two apart read either TTL: no reason to pay the hour's write, and none against it.
    notes(p, "constant", 20, 1);
    expect(p.ttl("constant", T0)).toBe("5m");
    // Hours apart: every breakpoint would write (1.25 or 2.0) where plain is 1.0.
    notes(p, "quiet", 20, 120);
    expect(p.ttl("quiet", T0)).toBe("none");
    // D1800's rule (the lab's switch) never sends none: five minutes there.
    const d1800 = new SystemTtlPolicy(undefined, undefined, false);
    notes(d1800, "quiet", 20, 120);
    expect(d1800.ttl("quiet", T0)).toBe("5m");
  });

  test("a new tenant starts at five minutes (D1790's shape), and one check alone decides nothing", () => {
    const p = new SystemTtlPolicy();
    expect(p.ttl("t", T0)).toBe("5m");
    p.note("t", T0);
    expect(p.ttl("t", T0)).toBe("5m");
  });

  test("none is priced as a write where a marked sheet follows a plain check within the hour", () => {
    // Plain then marked, ten minutes apart, every ~day: with the hour, the marked check reads the instructions the
    // plain one wrote; with none it writes them. Pricing none at 1.0 there would choose it wrongly.
    const p = new SystemTtlPolicy();
    for (let d = 0; d < 40; d++) {
      p.note("t", T0 + d * 1_440 * MIN, false);
      p.note("t", T0 + (d * 1_440 + 10) * MIN, true);
    }
    expect(p.ttl("t", T0)).toBe("1h");
  });

  test("near the line it holds its choice rather than flip at every check (PLAIN_MARGIN)", () => {
    // Two checks ten minutes apart a day: the hour's mean is about 1.05, none's 1.0: within the margin, so the
    // tenant keeps the hour at both checks of a day rather than none before the short gap and the hour before the long.
    const p = new SystemTtlPolicy();
    const seen: string[] = [];
    for (let d = 0; d < 60; d++) {
      for (const off of [0, 10]) {
        const now = T0 + (d * 1_440 + off) * MIN;
        if (d >= 20) seen.push(p.ttl("t", now));
        p.note("t", now);
      }
    }
    expect(new Set(seen)).toEqual(new Set(["1h"]));
    // Once none is chosen, a tenant whose gaps shorten a little does not flip back at once either.
    const q = new SystemTtlPolicy();
    notes(q, "t", 40, 120);
    expect(q.ttl("t", T0)).toBe("none");
    q.note("t", T0 + 40 * 120 * MIN + 10 * MIN);
    expect(q.ttl("t", T0)).toBe("none");
  });

  test("isolation: per tenant; bounded, least recently checked first", () => {
    const p = new SystemTtlPolicy(2);
    notes(p, "a", 20, 120);
    expect(p.ttl("a", T0)).toBe("none");
    expect(p.ttl("b", T0)).toBe("5m");
    notes(p, "b", 3, 10);
    expect(p.ttl("b", T0)).toBe("1h");
    expect(p.ttl("a", T0)).toBe("none");
    notes(p, "c", 1, 10);
    expect(p.size).toBe(2);
    // "a" was dropped: it starts again at five minutes.
    expect(p.ttl("a", T0)).toBe("5m");
    expect(p.ttl("b", T0)).toBe("1h");
  });

  test("PushChecker asks the hour for the instructions alone, for a tenant whose checks come often", async () => {
    const model = new FakeModel(() => '{"items":[]}');
    let now = T0;
    const checker = new PushChecker({ model, budget: new Budget(), now: () => now });
    const plain = { ...INPUT, sheet: [] };
    const u = { tenantId: "t", userId: "u1" };
    for (let i = 0; i < 3; i++, now += 10 * MIN) await checker.check(u, "s1", plain, new AbortController().signal);
    expect(model.calls[0]!.messages[0]!.cacheTtl).toBeUndefined();
    expect(model.calls[2]!.messages[0]).toMatchObject({ cache: true, cacheTtl: "1h" });
    // Another tenant starts at five minutes.
    await checker.check({ tenantId: "t2", userId: "u1" }, "s2", plain, new AbortController().signal);
    expect(model.calls[3]!.messages[0]!.cacheTtl).toBeUndefined();
    // The text is the same either way.
    expect(new Set(model.calls.map((c) => c.messages[0]!.content)).size).toBe(1);
  });

  test("PushChecker sends the instructions plain for a tenant whose checks are hours apart, its neighbour not", async () => {
    const model = new FakeModel(() => '{"items":[]}');
    let now = T0;
    const checker = new PushChecker({ model, budget: new Budget(), now: () => now });
    const plain = { ...INPUT, sheet: [] };
    const signal = new AbortController().signal;
    for (let i = 0; i < 20; i++, now += 120 * MIN)
      await checker.check({ tenantId: "q", userId: "u" }, "s", plain, signal);
    const last = model.calls.at(-1)!.messages[0]!;
    expect(last.noCache).toBe(true);
    expect(last.cache).toBeUndefined();
    // Another tenant on the same checker starts at five minutes: no breakpoint field set, none dropped.
    await checker.check({ tenantId: "b", userId: "u" }, "s2", plain, signal);
    expect(model.calls.at(-1)!.messages[0]!.noCache).toBeUndefined();
    expect(new Set(model.calls.map((c) => c.messages[0]!.content)).size).toBe(1);
  });

  test("checkMessages under each TTL: the same roles and text, only the cache fields differ", () => {
    const sheetPlain = (systemTtl: "1h" | "5m" | "none") => checkMessages(INPUT, { sheetCache: false, systemTtl });
    const five = sheetPlain("5m");
    for (const ttl of ["1h", "none"] as const) {
      expect(sheetPlain(ttl).map((m) => [m.role, m.content])).toEqual(five.map((m) => [m.role, m.content]));
    }
    expect(checkMessages(INPUT, { sheetCache: false }).map((m) => [m.role, m.content])).toEqual(
      five.map((m) => [m.role, m.content]),
    );
    expect(sheetPlain("1h")[0]).toMatchObject({ cache: true, cacheTtl: "1h" });
    expect(sheetPlain("none")[0]).toEqual({ role: "system", content: five[0]!.content, noCache: true });
    expect(five[0]).toEqual({ role: "system", content: five[0]!.content });
    expect(sheetPlain("none").slice(1)).toEqual(five.slice(1));
  });
});
