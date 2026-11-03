/**
 * `pi-ab --replay` and `--reuse-arms` (lab only): the reader and the grader behind `ReplayModel` as pi-ab wires them,
 * driven twice through a real `ContextPartner` with the reader on and graded with `gradeWith`. A second run calls no
 * model and gives the same answers, grades and per-task costs; a changed request calls again for that task only. And
 * `reusableArms` refuses an earlier run whose harness, grader or prompts differ; `backfillShares` adds up to what was
 * spent; a failed live call leaves no unhandled rejection; `--reconcile` exits 1 when the columns do not add up.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskReader, ContextPartner, CORE_CONFIG, ItemCache, ModelReaderMaker } from "@eden/engine";
import { SourceMap } from "@eden/graph";
import { Budget, FakeModel, type ChatRequest, type Model } from "@eden/llm";
import type { AgentEvent, ContextItem } from "@eden/protocol";
import type { Source } from "@eden/sources";
import {
  armPromptsHash,
  backfillShares,
  emptyResult,
  gradeWith,
  reusableArms,
  type ArmSource,
  type Background,
  type RunResult,
  type Task,
} from "./ab-common";
import { costAsMade, ReplayModel } from "./reader-disk";

const NOW = Date.parse("2026-10-27T09:00:00Z");
const HOUR = 3_600_000;
const item = (id: string, title: string, text: string, ageH: number): ContextItem => ({
  id: `mail:${id}`,
  sourceId: "mail",
  ref: id,
  title,
  text,
  updatedAt: NOW - ageH * HOUR,
});
const ITEMS = [
  item("inv", "Harlow invoice", "Harlow invoice for the venue deposit: the PDF is attached, reference HV-1042.", 2),
  item("due", "Harlow reminder", "Reminder from Harlow: the venue deposit invoice falls due today.", 3),
  item("bank", "Harlow accounts", "Harlow's accounts team: the deposit invoice is payable by bank transfer.", 4),
  item(
    "hold",
    "Harlow venue",
    "Let's sit on anything going out to Harlow until Dee has gone through their numbers.",
    200,
  ),
];
const source: Source = { id: "mail", kind: "test", description: "Mail", search: async () => ITEMS };

const task = (i: number, text: string): Task => ({
  id: `t${i}`,
  suite: "test",
  kind: "hidden",
  type: "hold",
  event: "user_message",
  text,
  must: [{ id: "hold", detail: "payments to Harlow are on hold until Dee has checked their numbers" }],
  secrets: [],
});
const TASKS = [
  task(0, "Pay the Harlow invoice for the venue deposit today."),
  task(1, "Send Harlow the bank transfer for the deposit invoice."),
  task(2, "Pay Harlow's venue deposit invoice HV-1042 by card through the portal."),
];

/** A live model as the run would see it: a reply and a cost per call, and every call counted. */
function live(reply: (r: ChatRequest) => string, costUsd: number): Model & { calls: number } {
  const fake = new FakeModel(reply);
  return {
    id: "live",
    calls: 0,
    async chat(request) {
      this.calls++;
      const res = await fake.chat(request);
      return { ...res, costUsd, latencyMs: 40 };
    },
  };
}
// The reader binds the oldest item of the pool; the grader says the fact was raised when the answer cites it.
const readerReply = (r: ChatRequest) => {
  const held = /<item i="(\d+)"[^>]*>Harlow venue:/.exec(r.messages.map((m) => m.content).join("\n"));
  const bears = held ? [{ i: Number(held[1]), k: "blocks", why: "payments to Harlow are on hold" }] : [];
  return JSON.stringify({ bears });
};
const graderReply = (r: ChatRequest) => JSON.stringify({ 1: /hold/i.test(r.messages.at(-1)!.content) });

const salt = (role: string, harness = "@earendil-works/pi-agent-core@1.3.0") => ({ role, harness, provider: {} });

/** One run as pi-ab makes it: each task asks Eden (the reader behind the replay cache), then the answer is graded. */
async function run(dir: string, tasks: Task[], options: { live: boolean; harness?: string } = { live: true }) {
  const readerLive = live(readerReply, 0.0004);
  const graderLive = live(graderReply, 0.00006);
  const reader = new ReplayModel(join(dir, "reader.jsonl"), options.live ? readerLive : null, "claude-haiku-5-5", {
    salt: salt("eden.reader", options.harness),
  });
  const grader = new ReplayModel(join(dir, "grader.jsonl"), options.live ? graderLive : null, "claude-haiku-5-5", {
    salt: salt("grader", options.harness),
  });
  const results: (RunResult & { ids: string[] })[] = [];
  let owner: RunResult | null = null;
  // pi-ab's `ownedModel`: each reader call charged to the running task at its cost as made.
  const owned: Model = {
    id: reader.id,
    async chat(request) {
      const r = owner;
      const res = await reader.chat(request);
      if (r) {
        r.edenModelCalls++;
        r.edenCostUsd += costAsMade(res);
      }
      return res;
    },
  };
  const partner = new ContextPartner({
    sources: async () => [source],
    sourceMap: new SourceMap(),
    cache: new ItemCache(),
    budget: new Budget(),
    model: null,
    now: () => NOW,
    config: { ...CORE_CONFIG, askReader: true, askReaderWaitMs: 2_000 },
    reader: new AskReader({ maker: new ModelReaderMaker(owned), budget: new Budget(), now: () => NOW }),
  });
  let spent = 0;
  for (const t of tasks) {
    const r = emptyResult(t.id, "eden~NEW");
    owner = r;
    const scope = { tenantId: "ab", userId: "w41", sessionId: t.id };
    await partner.observe({ ...scope, at: NOW, kind: "user_message", text: t.text } as AgentEvent, { waitMs: 2_000 });
    const a = await partner.ask({ ...scope, question: t.text, maxItems: 3 });
    r.answer = a.answer;
    // As pi-ab grades: a failed grading call (a replay-only miss) leaves the result ungraded.
    await gradeWith(grader, t, r.answer, (c) => (spent += c)).then(
      (facts) => (r.facts = facts),
      () => {},
    );
    results.push({ ...r, ids: a.citations.map((c) => c.itemId) });
    await partner.observe({ ...scope, at: NOW, kind: "session_end" } as AgentEvent);
  }
  return { results, reader, grader, readerLive, graderLive, spent };
}

describe("pi-ab --replay: the reader and the grader", () => {
  test("a second run makes no reader or grader call and gives the same results, costs as made", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-replay-"));
    const first = await run(dir, TASKS);
    expect(first.readerLive.calls).toBe(3);
    expect(first.graderLive.calls).toBe(3);
    // The run is a real one: the reader bound the held item and the grader saw it raised.
    expect(first.results.every((r) => r.ids[0] === "mail:hold" && r.facts?.hold === true)).toBe(true);
    expect(first.results.every((r) => r.edenCostUsd === 0.0004)).toBe(true);

    const second = await run(dir, TASKS);
    expect(second.readerLive.calls).toBe(0);
    expect(second.graderLive.calls).toBe(0);
    expect(second.reader.replayed).toBe(3);
    expect(second.grader.replayed).toBe(3);
    // Identical minus timing (wallMs is 0 in both here): answers, citations, grades and per-task cost as made.
    expect(second.results).toEqual(first.results);
    // Nothing was spent on the replayed grades.
    expect(first.spent).toBeCloseTo(3 * 0.00006, 10);
    expect(second.spent).toBe(0);
  });

  test("a one-task change calls again for that task's prompts only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-replay-"));
    await run(dir, TASKS);
    const changed = [TASKS[0]!, task(1, "Wire Harlow the deposit for the venue invoice this morning."), TASKS[2]!];
    const again = await run(dir, changed);
    expect(again.readerLive.calls).toBe(1);
    expect(again.graderLive.calls).toBe(1);
    expect(again.reader.replayed).toBe(2);
    expect(again.grader.replayed).toBe(2);
  });

  test("--replay-only: a prompt with no line is a miss, not a call; another harness's lines do not answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-replay-"));
    await run(dir, TASKS);
    const only = await run(dir, TASKS, { live: false });
    expect(only.reader.missed + only.grader.missed).toBe(0);
    const other = await run(dir, TASKS, { live: false, harness: "@earendil-works/pi-agent-core@2.0.0" });
    expect(other.reader.missed).toBe(3);
    // The reader failed open (no bearing), so the answers still went to the grader, which missed too.
    expect(other.grader.missed).toBe(3);
  });

  test("an identical prompt in flight is made once and shared", async () => {
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow: Model = {
      id: "slow",
      async chat() {
        calls++;
        await gate;
        return {
          text: "x",
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          costUsd: 0.001,
          model: "slow",
          latencyMs: 5,
        };
      },
    };
    const m = new ReplayModel("", slow, "slow");
    const request = { messages: [{ role: "user" as const, content: "same" }], maxTokens: 10 };
    const both = Promise.all([m.chat(request), m.chat(request)]);
    release();
    const [a, b] = await both;
    expect(calls).toBe(1);
    expect(a.text).toBe(b.text);
    expect(a.costUsd + b.costUsd).toBe(0.001);
    expect(costAsMade(b)).toBe(0.001);
  });

  test("a live call that fails leaves no unhandled rejection, and the same prompt goes live again", async () => {
    let calls = 0;
    const failing: Model = {
      id: "x",
      async chat() {
        calls++;
        throw new Error("reader timeout");
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const m = new ReplayModel("", failing, "x");
      const request = { messages: [{ role: "user" as const, content: "same" }], maxTokens: 10 };
      await expect(m.chat(request)).rejects.toThrow("reader timeout");
      await expect(m.chat(request)).rejects.toThrow("reader timeout");
      // An unhandled rejection is reported once the microtasks drain: give it a macrotask to surface.
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toBe(2);
      expect(m.failed).toBe(2);
      expect(m.sent).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("pi-ab --reuse-arms", () => {
  const tasks = TASKS;
  const results = ["none", "tools"].flatMap((c) =>
    tasks.map((t) => ({ ...emptyResult(t.id, c), answer: "a", facts: { hold: false }, costUsd: 0.0003 })),
  );
  const prior: ArmSource = {
    model: "claude-haiku-5-5",
    grader: "claude-haiku-5-5",
    harness: "pi",
    harnessVersion: "@earendil-works/pi-agent-core@1.3.0",
    promptsHash: armPromptsHash({ params: "query" }),
    seeds: [41, 42],
    suites: ["test"],
    timeScale: 1,
    toolExecution: "parallel",
    tasks,
    results,
  };
  const now = { ...prior, seeds: [41] } as Omit<ArmSource, "results">;

  test("copies the Eden-free arms of a matching run", () => {
    const got = reusableArms(prior, now, ["none", "tools"]);
    expect(got.length).toBe(6);
    expect(got).toEqual(results);
  });

  test("refuses when the harness version or the grader differs", () => {
    expect(() =>
      reusableArms(prior, { ...now, harnessVersion: "@earendil-works/pi-agent-core@2.0.0" }, ["none"]),
    ).toThrow(/harness version differs/);
    expect(() => reusableArms(prior, { ...now, grader: "deepseek/deepseek-v4.1-flash" }, ["none"])).toThrow(
      /grader differs/,
    );
  });

  test("refuses when the agent's or the grader's prompts differ (promptsHash), or the earlier run has none", () => {
    // The fingerprint is stable, and moves with what the harness adds (pi-ab: the tool's parameter schema).
    expect(armPromptsHash({ params: "query" })).toBe(prior.promptsHash!);
    expect(armPromptsHash({ params: "q" })).not.toBe(prior.promptsHash!);
    const changed = { ...now, promptsHash: armPromptsHash({ params: "q" }) };
    expect(() => reusableArms(prior, changed, ["none"])).toThrow(/prompts \(promptsHash\) differs/);
    const { promptsHash: _old, ...unrecorded } = prior;
    expect(() => reusableArms(unrecorded, now, ["none"])).toThrow(/promptsHash/);
  });

  test("refuses a changed task, a missing arm, an ungraded result and a partial run", () => {
    const reworded = [task(0, "Pay Harlow now."), ...tasks.slice(1)];
    expect(() => reusableArms(prior, { ...now, tasks: reworded }, ["none"])).toThrow(/task t0 differs/);
    expect(() => reusableArms(prior, now, ["both"])).toThrow(/no both result/);
    const ungraded = { ...prior, results: results.map((r) => ({ ...r, facts: undefined })) };
    expect(() => reusableArms(ungraded, now, ["none"])).toThrow(/not graded/);
    expect(() => reusableArms({ ...prior, partial: true }, now, ["none"])).toThrow(/partial/);
    expect(() => reusableArms(prior, { ...now, seeds: [43] }, ["none"])).toThrow(/seed 43/);
  });
});

describe("backfillShares: Eden's background spend per task run", () => {
  test("each seed's spend spread over its streams' task runs; the shares add up to the spend", () => {
    const bg: Background[] = [
      { seed: 41, suite: "s", condition: "eden", tasks: ["a", "b"], cardsUsd: 0.003, bridgeUsd: 0, calls: 2 },
      { seed: 41, suite: "s", condition: "eden~NEW", tasks: ["a", "b"], cardsUsd: 0.001, bridgeUsd: 0, calls: 1 },
      { seed: 42, suite: "s", condition: "eden", tasks: ["c"], cardsUsd: 0.05, bridgeUsd: 0.01, calls: 9 },
    ];
    const shares = backfillShares(bg);
    expect(shares.get("a\u0000eden")).toBeCloseTo(0.001, 12);
    expect(shares.get("b\u0000eden~NEW")).toBeCloseTo(0.001, 12);
    expect(shares.get("c\u0000eden")).toBeCloseTo(0.06, 12);
    expect([...shares.values()].reduce((n, x) => n + x, 0)).toBeCloseTo(0.064, 12);
  });
});

describe("pi-ab-report --reconcile", () => {
  const report = (total: string) =>
    [
      "harness pi, model x, grader x, time scale 0, tools parallel",
      `spent $1 (agent $0.5, Eden $${total}, grader $0.1); 20 runs, errors 0, ungraded 0`,
      "",
      "== hidden: hidden fact raised",
      "condition     n   rate   $/1k  (Eden)",
      "tools        10  0.500  0.300   0.000",
      "eden~NEW     10  0.700  0.900   0.500",
      "",
    ].join("\n");
  const ledger = [
    { run: "r-s41", role: "eden.reader", usd: 0.005 },
    { run: "r-s41", role: "eden.cards", usd: 0.002 },
    { run: "other", role: "eden.cards", usd: 9 },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
  const reconcile = (total: string) => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-"));
    writeFileSync(join(dir, "report.txt"), report(total));
    writeFileSync(join(dir, "ledger.jsonl"), ledger);
    const args = ["--reconcile", join(dir, "report.txt"), "--ledger", join(dir, "ledger.jsonl"), "--run", "r-"];
    return Bun.spawnSync(["bun", join(import.meta.dir, "pi-ab-report.ts"), ...args]);
  };

  test("exits 0 when the columns add up to the header's Eden total, 1 when they do not", () => {
    // (Eden) $0.5/1k x 10 runs = $0.005, plus the run's $0.002 of cards spread over its 10 runs with a partner.
    const ok = reconcile("0.0070");
    expect(ok.stdout.toString()).toContain("(within $0.01: OK)");
    expect(ok.exitCode).toBe(0);
    const off = reconcile("0.0500");
    expect(off.stdout.toString()).toContain("MORE THAN $0.01");
    expect(off.exitCode).toBe(1);
  });
});
