import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReaderInput } from "@eden/engine";
import { PRESETS } from "./presets";
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
const scratch = () => mkdtempSync(join(tmpdir(), "funnel-flags-"));
const noKey = { ...process.env, OPENROUTER_API_KEY: "" };

/** hidden-funnel.ts on train1 seed 41, the first `limit` tasks of each variant, no model. */
const funnel = (config: Record<string, unknown>, extra: string[], limit = 2) => {
  const out = join(scratch(), "f.json");
  const r = spawnSync(
    "bun",
    [
      join(lab, "hidden-funnel.ts"),
      ...["--suite", "train1", "--seeds", "41", "--limit", String(limit), "--ask", "--no-record"],
      ...["--config", JSON.stringify(config), "--cards", cards, "--json", out, ...extra],
    ],
    { encoding: "utf8", env: noKey },
  );
  expect(r.stderr).not.toContain("error:");
  expect(r.status).toBe(0);
  return { stdout: r.stdout, json: JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown> };
};

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
  test("NEWL with --reader stub and no --intent: stamped inert, JSON label, reader log, sync item counters", () => {
    const log = join(scratch(), "reader.jsonl");
    const { stdout, json } = funnel(PRESETS.NEWL!, ["--reader", "stub", "--reader-log", log, "--label", "NEWL"]);
    const totals = stdout.split("\n").filter((l) => /^(TOTAL|train1 )/.test(l) || l.includes("hidden in pool"));
    expect(totals.length).toBeGreaterThan(1);
    for (const l of totals) expect(l).toContain(INTENT_INERT);
    expect(json.label).toBe(`NEWL  ${INTENT_INERT}`);
    expect((json.intent as { state: string }).state).toBe("inert");
    const lines = readFileSync(log, "utf8").trim().split("\n");
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
  }, 60_000);

  test("--overlap with slowPathQueue: a request arrives while the slow path is busy, and is queued", () => {
    const { stdout, json } = funnel({ ...PRESETS.ALL3, slowPathQueue: true }, ["--overlap"], 3);
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
      [join(lab, "funnel.ts"), "--preset", "NEWL", "--baseline", base, "--", "--reader", "stub"],
      { encoding: "utf8", env: noKey },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refused");
    expect(r.stderr).toContain("baseline's intent is off and this run's is inert");
  });

  test("--time shards: --jobs is honoured, and rows match one process's without their timing fields", async () => {
    // Both runs at once (they are sleeps mostly), each in its own scratch directory.
    const run = async (jobs: string) => {
      const out = join(scratch(), "f.json");
      const p = Bun.spawn(
        [
          "bun",
          join(lab, "funnel.ts"),
          ...["--suite", "train1", "--seeds", "41,42", "--jobs", jobs, "--json", out],
          ...["--", "--time", "0.05", "--limit", "2"],
        ],
        { env: noKey, stdout: "ignore", stderr: "pipe" },
      );
      const stderr = await new Response(p.stderr).text();
      expect(await p.exited).toBe(0);
      return { stderr, rows: (JSON.parse(readFileSync(out, "utf8")) as { perTask: object[] }).perTask };
    };
    // Timing fields, and `beforeModel` (whether a delivery beat the observe's wait is a matter of timing too).
    const timing = new Set(["ms", "askMs", "deliveryMs", "beforeModel"]);
    const strip = (rows: object[]) =>
      rows.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !timing.has(k))));
    const [solo, sharded] = await Promise.all([run("1"), run("2")]);
    expect(sharded.stderr).not.toContain("running one job");
    expect(sharded.stderr).toContain("2 at a time");
    expect(strip(sharded.rows)).toEqual(strip(solo.rows));
  }, 120_000);
});
