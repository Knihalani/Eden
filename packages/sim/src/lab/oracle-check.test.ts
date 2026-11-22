import { expect, test } from "bun:test";
import { CHECK_MAX_ITEMS, checkMessages, PushChecker, type PushCheckInput } from "@eden/engine";
import { Budget, type ChatRequest, type Model } from "@eden/llm";
import { OracleCheckModel, taskScopedCheck } from "./oracle-check";
import type { DumpTask } from "./check-dump";

const task: DumpTask = { suite: "hidden", seed: 41, variant: "hidden", template: "hold", planted: "planted" };
const item = (id: string) => ({
  id,
  title: "GOLD MUST NOT LEAK",
  text: "secret gold detail",
  source: "slack",
  from: "",
  date: "",
  hash: id,
});
const input = (ids = ["irrelevant", "planted", "decoy"]): PushCheckInput => ({
  request: "Reply to the customer.",
  today: "2026-10-29",
  items: ids.map(item),
});
const scope = { tenantId: "t", userId: "u" };
const signal = () => new AbortController().signal;
const request = (i: PushCheckInput): ChatRequest => ({ messages: checkMessages(i), maxTokens: 1000 });

test("perfect answers round-trip through PushChecker, with generic links and zero cost", async () => {
  const oracle = new OracleCheckModel();
  const i = input();
  const reply = await oracle.run(task, i, () => oracle.chat(request(i)));
  expect(JSON.parse(reply.text)).toEqual({ items: [{ i: 2, on: "oracle proxy", hits: "this request", act: true }] });
  expect(reply.text).not.toContain("GOLD");
  expect(reply.text).not.toContain("secret gold detail");
  expect(reply.costUsd).toBe(0);
  const checker = new PushChecker({ model: oracle, budget: new Budget() });
  taskScopedCheck(checker, oracle, () => task);
  const read = await checker.check(scope, "s", i, signal());
  expect([...read.yes!]).toEqual(["planted"]);
  expect([...read.changes!]).toEqual([["planted", "this request"]]);
  expect(read).toMatchObject({ costUsd: 0, called: true });
  expect(checker.stats.failures).toBe(0);
});

test("perfect controls, neutral, irrelevant and empty pools yield no selections", async () => {
  const oracle = new OracleCheckModel();
  for (const variant of ["control", "neutral", "hidden"]) {
    const t = { ...task, variant, planted: variant === "neutral" ? "" : task.planted };
    for (const ids of variant === "hidden" ? [[], ["irrelevant", "decoy"]] : [[], ["planted", "irrelevant", "decoy"]]) {
      const i = input(ids);
      const checker = new PushChecker({ model: oracle, budget: new Budget() });
      taskScopedCheck(checker, oracle, () => t);
      const read = await checker.check(scope, "s", i, signal());
      expect(ids.length ? [...read.yes!] : read.yes).toEqual(ids.length ? [] : null);
      expect(read.costUsd).toBe(0);
    }
  }
});

test("noisy draws are stable across reordered and growing pools, and seeded by task", async () => {
  const oracle = new OracleCheckModel(0.85, 0.05);
  const ids = ["planted", ...Array.from({ length: 17 }, (_, i) => `other-${i}`)];
  const picks = async (seed: number, names: string[]) => {
    const i = input(names);
    const r = await oracle.run({ ...task, seed }, i, () => oracle.chat(request(i)));
    return new Set((JSON.parse(r.text).items as { i: number }[]).map((x) => names[x.i - 1]));
  };
  const seen = new Set<string>();
  for (let seed = 1; seed <= 50; seed++) {
    const small = await picks(seed, ids.slice(0, 6));
    const large = await picks(seed, [...ids].reverse());
    expect([...large].filter((id) => ids.slice(0, 6).includes(id!)).sort()).toEqual([...small].sort());
    seen.add(JSON.stringify([...large].sort()));
  }
  expect(seen.size).toBeGreaterThan(1);
  const all = new OracleCheckModel(0, 1);
  const r = await all.run(task, input(), () => all.chat(request(input())));
  expect(JSON.parse(r.text).items.map((x: { i: number }) => x.i)).toEqual([1, 3]);
});

test("per-call snapshots survive concurrent tasks and later mutation", async () => {
  const oracle = new OracleCheckModel();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const delayed: Model = {
    id: oracle.id,
    chat: async (r) => {
      await gate;
      return oracle.chat(r);
    },
  };
  const checker = new PushChecker({ model: delayed, budget: new Budget() });
  const labels = new Map([
    ["a", { ...task }],
    ["b", { ...task, planted: "decoy", seed: 42 }],
  ]);
  taskScopedCheck(checker, oracle, (s) => labels.get(s));
  const i = input();
  const a = checker.check(scope, "a", i, signal());
  const b = checker.check({ tenantId: "t2", userId: "u2" }, "b", input(), signal());
  labels.get("a")!.planted = "irrelevant";
  release();
  expect([...(await b).yes!]).toEqual(["decoy"]);
  expect([...(await a).yes!]).toEqual(["planted"]);
});

test("missing context, invalid rates, aborts and bounded pools", async () => {
  for (const rates of [
    [-1, 0],
    [1, 2],
    [NaN, 0],
    [1, Infinity],
  ])
    expect(() => new OracleCheckModel(rates[0], rates[1])).toThrow();
  const oracle = new OracleCheckModel();
  expect(() => oracle.run(undefined, input(), () => null)).toThrow("no task labels");
  await expect(oracle.chat(request(input()))).rejects.toThrow("outside its task");
  const abort = new AbortController();
  abort.abort(new Error("cancelled"));
  await expect(
    oracle.run(task, input(), () => oracle.chat({ ...request(input()), signal: abort.signal })),
  ).rejects.toThrow("cancelled");
  const i = input([...Array.from({ length: CHECK_MAX_ITEMS }, (_, i) => `x${i}`), "planted"]);
  const r = await oracle.run(task, i, () => oracle.chat(request(i)));
  expect(JSON.parse(r.text)).toEqual({ items: [] });
});

test("sheet-only truth uses the real rule parser", async () => {
  const oracle = new OracleCheckModel();
  const checker = new PushChecker({ model: oracle, budget: new Budget() });
  taskScopedCheck(checker, oracle, () => task);
  const i = input(["irrelevant"]);
  i.sheet = [{ id: "planted", kind: "prohibition", statement: "gold rule", title: "Rule", source: "slack" }];
  const read = await checker.check(scope, "s", i, signal());
  expect([...read.yes!]).toEqual([]);
  expect([...read.rules!]).toEqual(["planted"]);
  expect([...read.changes!]).toEqual([["planted", "this request"]]);
  const both = { ...i, items: input(["planted"]).items };
  const inPool = await checker.check(scope, "s", both, signal());
  expect([...inPool.yes!]).toEqual(["planted"]);
  expect([...inPool.rules!]).toEqual([]);
});
