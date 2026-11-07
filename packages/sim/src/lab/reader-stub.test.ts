import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readerMessages, type ReaderInput } from "@eden/engine";
import { PRESETS } from "./presets";
import {
  CountingReader,
  draw,
  INTENT_INERT,
  OracleReaderMaker,
  packetLines,
  parseOracle,
  poolLine,
  promptSize,
  type ScreenRow,
} from "./reader-stub";

const item = (id: string, text = `text of ${id}`) => ({
  id,
  source: "mail",
  title: `title ${id}`,
  date: "2026-11-01",
  from: "",
  text,
  hash: `h-${id}`,
});
const input = (ids: string[], standing = 0): ReaderInput => ({
  request: "Book the room for Friday",
  items: ids.map((id) => item(id)),
  today: "2026-11-03",
  standing,
});

describe("CountingReader (--reader stub)", () => {
  test("says nothing binds, costs nothing, and counts each call with its prompt's size", async () => {
    const r = new CountingReader();
    const got = await r.read(input(["a", "b", "c"]));
    expect(got).toEqual({ bears: [], rejected: [], costUsd: 0 });
    await r.read(input(["a"]));
    expect(r.calls).toBe(2);
    const whole = readerMessages(input(["a", "b", "c"])).reduce((n, m) => n + m.content.length, 0);
    expect(r.sizes[0]).toEqual({ items: 3, promptChars: whole, prefixChars: 0 });
  });

  test("the standing prefix is the cached message's characters", () => {
    const x = input(["s1", "s2", "a"], 2);
    const messages = readerMessages(x);
    expect(messages.length).toBe(3);
    expect(promptSize(x).prefixChars).toBe(messages[1]!.content.length);
  });
});

describe("OracleReaderMaker (--reader oracle)", () => {
  test("a perfect oracle flags the planted hidden item, rejects the decoy and passes over the rest", async () => {
    const o = new OracleReaderMaker();
    o.task = "train1/hidden/41/t/p1";
    o.planted = new Map([
      ["p1", "hidden"],
      ["d1", "decoy"],
    ]);
    const got = await o.read(input(["x", "p1", "d1", "y"]));
    expect(got.bears).toEqual([{ i: 1, kind: "blocks", why: "oracle proxy" }]);
    expect(got.rejected).toEqual([2]);
    expect(o.calls).toBe(1);
  });

  test("flips are fixed by (task, item): deterministic, and independent of the order of calls or the process", async () => {
    const run = async (tasks: string[]) => {
      const o = new OracleReaderMaker(0.5, 0.5);
      const out: Record<string, number> = {};
      for (const t of tasks) {
        o.task = t;
        o.planted = new Map([["p", "hidden"]]);
        out[t] = (await o.read(input(["p"]))).bears!.length;
      }
      return out;
    };
    const tasks = Array.from({ length: 40 }, (_, i) => `s/hidden/${41 + (i % 2)}/t${i}/p`);
    const a = await run(tasks);
    const b = await run([...tasks].reverse());
    expect(a).toEqual(b);
    // At 0.5 both outcomes occur over 40 tasks; the seed is part of the key.
    const hits = Object.values(a).reduce((n, x) => n + x, 0);
    expect(hits).toBeGreaterThan(5);
    expect(hits).toBeLessThan(35);
    expect(draw("s/hidden/41/t/p\tp")).not.toBe(draw("s/hidden/42/t/p\tp"));
  });

  test("rates: p_hit 0 never flags the hidden item; p_false 1 always flags the decoy", async () => {
    const o = new OracleReaderMaker(0, 1);
    for (let i = 0; i < 20; i++) {
      o.task = `t${i}`;
      o.planted = new Map([
        ["h", "hidden"],
        ["d", "decoy"],
      ]);
      const got = await o.read(input(["h", "d"]));
      expect(got.bears!.map((b) => b.i)).toEqual([1]);
      expect(got.rejected).toEqual([0]);
    }
  });

  test("parseOracle", () => {
    expect(parseOracle("oracle")).toEqual({ pHit: 1, pFalse: 0 });
    expect(parseOracle("oracle:0.9,0.05")).toEqual({ pHit: 0.9, pFalse: 0.05 });
    expect(() => parseOracle("oracle:1.5,0")).toThrow();
    expect(() => parseOracle("oracle:0.9")).toThrow();
    expect(() => parseOracle("oracles")).toThrow();
  });

  test("no model behind it: every read costs nothing", async () => {
    const o = new OracleReaderMaker();
    const got = await o.read(input(["a"]));
    expect(got.costUsd).toBe(0);
  });
});

describe("screen lines", () => {
  const rows: ScreenRow[] = [
    { variant: "hidden", delivered: false, poolHas: true, poolItems: 10, stubCalls: 1, promptChars: 100 },
    { variant: "hidden", delivered: true, poolHas: false, poolItems: 20, stubCalls: 1, promptChars: 300 },
    { variant: "control", delivered: false, poolHas: true, poolItems: 15, stubCalls: 0, promptChars: 0 },
  ];
  test("pool recall per variant, mean pool items and mean prompt per call", () => {
    expect(poolLine("s", rows)).toBe(
      "s          hidden in pool 1/2, decoy in pool 1/1, mean pool items 15.0, mean prompt 200.0 chars (standing " +
        "prefix 0.0) over 2 reader calls",
    );
    expect(poolLine("s", [{ variant: "hidden", delivered: false }])).toBeNull();
  });
  test("top-K by rank alone and with today's delivered or cited", () => {
    const ranked: ScreenRow[] = [
      { variant: "hidden", delivered: false, askRank: 0, packetKBytes: { 1: 50 } },
      { variant: "hidden", delivered: true, askRank: 3, packetKBytes: { 1: 70 } },
      { variant: "control", delivered: false, askRank: -1, packetKBytes: { 1: 60 } },
    ];
    expect(packetLines("s", ranked, [1])).toEqual([
      "s          top-1: hidden 1/2 (with delivered or cited 2), decoys 0/1 (0), mean 60.0 bytes, hidden at mean " +
        "position 1.0",
    ]);
  });
});

describe("the funnel with a no-model reader (end to end, small)", () => {
  const lab = import.meta.dir;
  const cards = join(lab, "..", "..", "lab", "cards", "cards-train.jsonl");
  type Run = {
    status: number | null;
    stdout: string;
    stderr: string;
    json: { reader?: unknown; perTask: Record<string, unknown>[] } & Record<string, unknown>;
  };
  // Each run's scratch directory, removed after the last test (each run used to leave its own in /tmp).
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  // NEWL with its sync capped at 100 items a user (3,000 by default): the sync still backfills, polls and counts its
  // items, but storing 3,000 items was 0.8 s of each run's 2.5 s CPU (bun --cpu-prof), and no check here needs them.
  // The reader's push (`pushCandidates` 0): the default's push (D237) makes no reader call, and these runs check
  // the reader.
  const config = JSON.stringify({ ...PRESETS.default, syncMaxItems: 100, pushCandidates: 0 });
  /** One small funnel run in its own process. The runs below go out together: each is CPU-bound, single-threaded. */
  const start = async (reader: string, extra: string[] = []): Promise<Run> => {
    const out = join(scratch(), "f.json");
    const child = Bun.spawn(
      [
        "bun",
        join(lab, "hidden-funnel.ts"),
        ...["--suite", "train1", "--seeds", "41", "--limit", "2", "--ask", "--no-record", "--reader", reader],
        ...["--config", config, "--cards", cards, "--json", out, ...extra],
      ],
      { env: { ...process.env, OPENROUTER_API_KEY: "" }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const json = status === 0 ? (JSON.parse(readFileSync(out, "utf8")) as Run["json"]) : { perTask: [] };
    return { status, stdout, stderr, json };
  };
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), "reader-stub-"));
    dirs.push(dir);
    return dir;
  };
  // The stub twice (its determinism) and the oracle once, run at the same time rather than one after another. The
  // first stub run also writes a reader log under a label: the NEWL flag checks below read it, so they need no run
  // of their own (they had one in funnel-flags.test.ts, a fourth process for the same work).
  let runs: { stub: Run[]; oracle: Run; log: string };
  beforeAll(async () => {
    const log = join(scratch(), "reader.jsonl");
    const [a, b, oracle] = await Promise.all([
      start("stub", ["--reader-log", log, "--label", "NEWL"]),
      start("stub"),
      start("oracle:0.9,0.1"),
    ]);
    runs = { stub: [a!, b!], oracle: oracle!, log };
  }, 60_000);
  const run = (r: Run) => {
    expect(r.status).toBe(0);
    return r;
  };
  const timing = new Set(["ms", "askMs", "readerWaitMs", "deliveryMs"]);
  const strip = (rows: Record<string, unknown>[]) =>
    rows.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !timing.has(k))));

  test("stub: no model (no replay or live reader), pool fields per task, deterministic across runs", () => {
    const a = run(runs.stub[0]!);
    expect(a.json.reader).toBeUndefined();
    expect(a.stdout).not.toContain("calls answered");
    expect(a.stdout).toContain("NOT the preset's numbers");
    expect(a.stdout).toContain("hidden in pool");
    expect(a.json.perTask.every((t) => typeof t.poolHas === "boolean")).toBe(true);
    expect(a.json.perTask.reduce((n, t) => n + Number(t.stubCalls ?? 0), 0)).toBeGreaterThan(0);
    expect(strip(run(runs.stub[1]!).json.perTask)).toEqual(strip(a.json.perTask));
  });

  test("the default with --reader stub and no --intent: stamped inert, JSON label, reader log, sync item counters", () => {
    const r = runs.stub[0]!;
    expect(r.stderr).not.toContain("error:");
    const { stdout, json } = run(r);
    const totals = stdout.split("\n").filter((l) => /^(TOTAL|train1 )/.test(l) || l.includes("hidden in pool"));
    expect(totals.length).toBeGreaterThan(1);
    for (const l of totals) expect(l).toContain(INTENT_INERT);
    expect(json.label).toBe(`NEWL  ${INTENT_INERT}`);
    expect((json.intent as { state: string }).state).toBe("inert");
    const lines = readFileSync(runs.log, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]!) as { task: string; reader: string; prompt: string };
    expect(first.reader).toBe("stub");
    expect(first.task.startsWith("train1/")).toBe(true);
    expect(first.prompt.length).toBeGreaterThan(0);
    // NEWL has the real sync: its item counters are in the JSON and on the sync line.
    const sync = json.sync as Record<string, number>;
    expect(typeof sync.demandItems).toBe("number");
    expect(sync.backgroundItems).toBeGreaterThan(0);
    expect(stdout).toMatch(/demand items \d+, background items \d+/);
    expect(stdout).toContain("delivered before first model call");
  });

  test("oracle: every table line is labelled a proxy", () => {
    const o = run(runs.oracle);
    const table = o.stdout.split("\n").filter((l) => /^(TOTAL|train1 )/.test(l));
    expect(table.length).toBeGreaterThan(0);
    for (const l of table) expect(l).toContain("[oracle proxy 0.9,0.1]");
  });

  test("funnel refuses a held-out suite in stub mode without --blind, before running anything", () => {
    const r = spawnSync("bun", [join(lab, "funnel.ts"), "--suite", "heldout13", "--", "--reader", "stub"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("held out");
  });
});
