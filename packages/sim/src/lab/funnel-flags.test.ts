import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReaderInput } from "@eden/engine";
import { PRESETS } from "./presets";
import { allMissedHint, cacheModels, DEFAULT_READER_MODEL } from "./reader-disk";
import {
  beforeModelLine,
  CountingReader,
  INTENT_INERT,
  intentMismatch,
  intentOfRun,
  intentState,
  OracleReaderMaker,
  type StubLogLine,
} from "./reader-stub";

const lab = import.meta.dir;
const cards = join(lab, "..", "..", "lab", "cards", "cards-train.jsonl");
// Every scratch directory this file makes, removed when it is done (each run used to leave its own in /tmp).
const scratchDirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "funnel-flags-"));
  scratchDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
const noKey = { ...process.env, OPENROUTER_API_KEY: "" };
// Every run below has the preset's sync capped at 100 items a user (3,000 by default): it still backfills, polls and
// counts, but storing 3,000 items was 0.8 s of each run's 2.5 s CPU (bun --cpu-prof), and no check here needs them.
const smallSync = { syncMaxItems: 100 };

type Run = { status: number | null; stdout: string; stderr: string; out: string };
/** `bun args…` in a child process without blocking this one, so the runs below can go out together. */
const spawn = async (args: string[], out: string): Promise<Run> => {
  const p = Bun.spawn(["bun", ...args], { env: noKey, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { status, stdout, stderr, out };
};

/** hidden-funnel.ts on train1 seed 41, the first `limit` tasks of each variant, no model. */
const funnel = (config: Record<string, unknown>, extra: string[], limit = 2) => {
  const out = join(scratch(), "f.json");
  return spawn(
    [
      join(lab, "hidden-funnel.ts"),
      ...["--suite", "train1", "--seeds", "41", "--limit", String(limit), "--ask", "--no-record"],
      ...["--config", JSON.stringify(config), "--cards", cards, "--json", out, ...extra],
    ],
    out,
  );
};

/** funnel.ts on train1 seeds 41 and 42: two seeds make two shards, so `--jobs 2` really runs two at a time. */
const funnelTimed = (jobs: string) => {
  const out = join(scratch(), "f.json");
  return spawn(
    [
      join(lab, "funnel.ts"),
      ...["--suite", "train1", "--seeds", "41,42", "--jobs", jobs, "--set", JSON.stringify(smallSync), "--json", out],
      // One task per variant and seed. Not a smaller --time: at 0.005 the sleeps are as short as a loaded machine's
      // scheduling jitter, and a task's call counts then changed between the two runs (seen once in three runs).
      ...["--", "--time", "0.05", "--limit", "1"],
    ],
    out,
  );
};

// The end-to-end runs are single-threaded child processes (mostly sleeps, for the shards). They start together
// here, before any test, and each test awaits its own: one after another they cost the sum of their wall times.
// The default's stub run assertions are in reader-stub.test.ts, on the stub run that file makes anyway.
let runs: {
  overlap: Promise<Run>;
  solo: Promise<Run>;
  sharded: Promise<Run>;
  missNoModel: Promise<Run>;
  missModel: Promise<Run>;
};
// A reader cache with one line recorded under a model that is not the default: every prompt of a run misses it.
let otherCache = "";
beforeAll(() => {
  otherCache = join(scratch(), "rc.jsonl");
  const line = { k: "0".repeat(40), text: "{}", usage: {}, costUsd: 0, latencyMs: 0, model: "claude-haiku-5-5" };
  writeFileSync(otherCache, `${JSON.stringify(line)}\n`);
  const replay = (extra: string[]) =>
    funnel(smallSync, ["--reader", "replay", "--reader-cache", otherCache, ...extra], 1);
  runs = {
    overlap: funnel({ ...PRESETS["minus-reader"], ...PRESETS["minus-intent"], ...smallSync }, ["--overlap"], 3),
    solo: funnelTimed("1"),
    sharded: funnelTimed("2"),
    missNoModel: replay([]),
    missModel: replay(["--reader-model", "claude-haiku-5-5"]),
  };
});

describe("intent state (inert without a replay)", () => {
  test("off without intent; inert with intent and nothing replayed; live once any request replayed", () => {
    expect(intentState({}, { asked: 10, found: 3 })).toBe("off");
    expect(intentState({ intent: true }, undefined)).toBe("inert");
    expect(intentState({ intent: true }, { asked: 10, found: 0 })).toBe("inert");
    expect(intentState({ intent: true }, { asked: 10, found: 1 })).toBe("live");
  });

  test("a run's file gives its state; an older file with intent configured is unknown", () => {
    expect(intentOfRun({ config: { intent: true }, intent: { state: "live" } })).toBe("live");
    expect(intentOfRun({ config: { intent: false } })).toBe("off");
    expect(intentOfRun({ config: {} })).toBe("off");
    expect(intentOfRun({ config: { intent: true } })).toBe("unknown");
  });

  test("a no-model screen compares only like intent states", () => {
    expect(intentMismatch("inert", "inert")).toBeNull();
    expect(intentMismatch("inert", "off")).toContain("baseline's intent is off");
    expect(intentMismatch("live", "unknown")).toContain("unknown");
  });
});

describe("no-model readers write --reader-log lines", () => {
  const input: ReaderInput = {
    request: "Book the room for Friday",
    items: [{ id: "p1", source: "mail", title: "t", date: "2026-11-01", from: "", text: "x", hash: "h" }],
    today: "2026-11-03",
  };
  test("the stub logs the prompt a model would read and its empty verdict", async () => {
    const lines: StubLogLine[] = [];
    const r = new CountingReader();
    r.log = (l) => lines.push(l);
    await r.read(input);
    expect(lines.length).toBe(1);
    expect(lines[0]!.prompt).toContain("Book the room for Friday");
    expect(lines[0]!.reply).toEqual({ bears: [], rejected: [], costUsd: 0 });
  });
  test("the oracle logs its verdict, and still counts the call", async () => {
    const lines: StubLogLine[] = [];
    const o = new OracleReaderMaker();
    o.planted = new Map([["p1", "hidden"]]);
    o.log = (l) => lines.push(l);
    const got = await o.read(input);
    expect(got.bears?.map((b) => b.i)).toEqual([0]);
    expect(lines[0]!.reply).toEqual(got);
    expect(o.calls).toBe(1);
  });
});

describe("all reader prompts missed and no --reader-model (devloop-paid-reader-replay-exists)", () => {
  const all = { replayed: 0, sent: 0, missed: 1250 };
  test("names --reader-model and the models the cache was recorded as", () => {
    const hint = allMissedHint(all, false, ["claude-haiku-5-5"]);
    expect(hint).toContain("all 1250 reader prompts missed");
    expect(hint).toContain("--reader-model");
    expect(hint).toContain("recorded as claude-haiku-5-5");
    expect(hint).toContain(DEFAULT_READER_MODEL);
    // A cache made under the default model names no other model (its full miss is a stale cache).
    expect(allMissedHint(all, false, [DEFAULT_READER_MODEL])).not.toContain("recorded as");
    expect(allMissedHint(all, false)).not.toContain("recorded as");
  });
  test("silent when the model was named, nothing missed, or anything replayed, sent or subset-answered", () => {
    expect(allMissedHint(all, true, ["claude-haiku-5-5"])).toBeNull();
    expect(allMissedHint({ replayed: 0, sent: 0, missed: 0 }, false)).toBeNull();
    expect(allMissedHint({ replayed: 648, sent: 0, missed: 5 }, false)).toBeNull();
    expect(allMissedHint({ replayed: 0, sent: 1, missed: 5 }, false)).toBeNull();
    expect(allMissedHint({ replayed: 0, sent: 0, missed: 5, subset: 3 }, false)).toBeNull();
  });
  test("cacheModels: distinct and sorted; empty for no file, a .gz or torn lines", () => {
    const f = join(scratch(), "models.jsonl");
    writeFileSync(
      f,
      `${JSON.stringify({ model: "b" })}\n{"model": "a"}\n{"model":\n\n${JSON.stringify({ model: "b" })}\n`,
    );
    expect(cacheModels(f)).toEqual(["a", "b"]);
    expect(cacheModels("")).toEqual([]);
    expect(cacheModels(join(scratch(), "none.jsonl"))).toEqual([]);
    expect(cacheModels(`${f}.gz`)).toEqual([]);
  });
  test("end to end: hidden-funnel prints the hint without --reader-model, and not with it", async () => {
    const [bare, named] = await Promise.all([runs.missNoModel, runs.missModel]);
    // Both runs missed every prompt, so both exit 3 at the miss gate (no --allow-misses).
    expect(bare.status).toBe(3);
    expect(bare.stdout).toContain("READER MISSES");
    expect(bare.stdout).toContain("READER HINT");
    expect(bare.stdout).toContain("recorded as claude-haiku-5-5");
    expect(named.status).toBe(3);
    expect(named.stdout).toContain("READER MISSES");
    expect(named.stdout).not.toContain("READER HINT");
  }, 60_000);
  test("a gzipped --reader-cache is refused with the gunzip step", () => {
    const r = spawnSync(
      "bun",
      [
        join(lab, "hidden-funnel.ts"),
        "--suite",
        "train1",
        "--seeds",
        "41",
        "--limit",
        "1",
        "--ask",
        "--no-record",
      ].concat(["--reader", "replay", "--reader-cache", "x.jsonl.gz"]),
      { encoding: "utf8", env: noKey },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is compressed: gunzip -c it into .local/");
  });
});

describe("delivered before the first model call", () => {
  test("counts delivered tasks the reply or the first drain carried", () => {
    const rows = [
      { variant: "hidden" as const, delivered: true, beforeModel: true },
      { variant: "hidden" as const, delivered: true, beforeModel: false },
      { variant: "hidden" as const, delivered: false },
      { variant: "control" as const, delivered: true, beforeModel: true },
    ];
    expect(beforeModelLine(rows, 1500)).toBe(
      "delivered before first model call (observe wait 1500 ms): hidden 1 of 2 delivered (3 tasks), " +
        "decoys 1 of 1 delivered (1 tasks)",
    );
  });
});

describe("hidden-funnel flags (end to end, small, no model)", () => {
  test("--overlap with slowPathQueue: a request arrives while the slow path is busy, and is queued", async () => {
    const r = await runs.overlap;
    expect(r.stderr).not.toContain("error:");
    expect(r.status).toBe(0);
    const stdout = r.stdout;
    const json = JSON.parse(readFileSync(r.out, "utf8")) as Record<string, unknown>;
    const m = /overlap: slow path busy (\d+) times \((\d+) queued/.exec(stdout);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(1);
    expect(Number(m![2])).toBeGreaterThanOrEqual(1);
    // ALL3 has no intent: no stamp.
    expect(stdout).not.toContain(INTENT_INERT);
    expect((json.intent as { state: string }).state).toBe("off");
  }, 60_000);
});

describe("funnel.ts flags", () => {
  test("a stub screen refuses a baseline whose intent differs, before running anything", () => {
    const base = join(scratch(), "base.json");
    writeFileSync(base, JSON.stringify({ config: { intent: false }, perTask: [] }));
    const r = spawnSync(
      "bun",
      [join(lab, "funnel.ts"), "--preset", "default", "--baseline", base, "--", "--reader", "stub"],
      { encoding: "utf8", env: noKey },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refused");
    expect(r.stderr).toContain("baseline's intent is off and this run's is inert");
  });

  test("--time shards: --jobs is honoured, and rows match one process's without their timing fields", async () => {
    // Both runs went out together in beforeAll, each in its own scratch directory.
    const rowsOf = async (run: Promise<Run>) => {
      const r = await run;
      expect(r.status).toBe(0);
      return { stderr: r.stderr, rows: (JSON.parse(readFileSync(r.out, "utf8")) as { perTask: object[] }).perTask };
    };
    // Timing fields (the reader's wait, now that the default reads, D112), and `beforeModel` (whether a delivery beat
    // the observe's wait is a matter of timing too).
    const timing = new Set(["ms", "askMs", "deliveryMs", "beforeModel", "readerWaitMs"]);
    const strip = (rows: object[]) =>
      rows.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !timing.has(k))));
    const [solo, sharded] = await Promise.all([rowsOf(runs.solo), rowsOf(runs.sharded)]);
    expect(sharded.stderr).not.toContain("running one job");
    expect(sharded.stderr).toContain("2 at a time");
    expect(strip(sharded.rows)).toEqual(strip(solo.rows));
  }, 120_000);
});
