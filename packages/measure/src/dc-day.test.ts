import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { billedTokens, emptyTokenClasses } from "@eden/ir";
import { dcShare } from "./dc";
import {
  addTokenClasses,
  aggregateDc,
  asTokenClasses,
  detTokens,
  formatDcLine,
  parseDcJsonl,
  parseDcRun,
  utcDay,
  utcDaysEnding,
  type DcRun,
} from "./dc-day";

const ROOT = join(import.meta.dir, "../../..");
const JSONL = join(ROOT, ".gauntlet/refs/07-dc-repro.jsonl");
const SCRIPT = join(ROOT, "scripts/dc-from-runs.ts");

describe("aggregateDc", () => {
  test("empty input is empty, not NaN", () => {
    expect(aggregateDc([])).toEqual([]);
    expect(dcShare(emptyTokenClasses())).toBe(0);
  });

  test("sums classes per workspace+day and uses frozen dcShare", () => {
    const runs: DcRun[] = [
      {
        workspace: "ws_a",
        day: "2026-08-20",
        classes: { compiled: 10, memoized: 0, transparent: 0, steeredSkip: 2, frontier: 8, providerCache: 999 },
      },
      {
        workspace: "ws_a",
        day: "2026-08-20",
        classes: { compiled: 5, memoized: 1, transparent: 0, steeredSkip: 0, frontier: 4 },
      },
      {
        workspace: "ws_b",
        day: "2026-08-20",
        classes: { compiled: 3, memoized: 0, transparent: 1, steeredSkip: 0, frontier: 0, providerCache: 50 },
      },
    ];
    const rows = aggregateDc(runs);
    expect(rows.map((r) => r.workspace)).toEqual(["ws_a", "ws_b"]);
    const a = rows[0]!;
    expect(a.classes).toEqual({
      compiled: 15,
      memoized: 1,
      transparent: 0,
      steeredSkip: 2,
      frontier: 12,
      providerCache: 999,
    });
    expect(a.dcShare).toBe(18 / 30);
    expect(a.dcPct).toBe(60);
    expect(dcShare(a.classes)).toBe(a.dcShare);
    expect(rows[1]!.dcPct).toBe(100);
    expect(rows[1]!.classes.providerCache).toBe(50);
  });

  test("providerCache is summed and ignored by dcShare", () => {
    const [row] = aggregateDc([
      {
        workspace: "ws",
        day: "2026-08-01",
        classes: { compiled: 1, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 1, providerCache: 1_000_000 },
      },
    ]);
    expect(row!.dcShare).toBe(0.5);
    expect(row!.classes.providerCache).toBe(1_000_000);
  });

  test("all-zero classes are 0 not NaN", () => {
    const [row] = aggregateDc([
      { workspace: "ws", day: "2026-08-01", classes: emptyTokenClasses() },
    ]);
    expect(row!.dcShare).toBe(0);
    expect(row!.dcPct).toBe(0);
    expect(Number.isNaN(row!.dcPct)).toBe(false);
  });
});

describe("parseDcRun / jsonl", () => {
  test("accepts nested classes or flat keys, including steered-skip", () => {
    expect(
      parseDcRun({
        workspace: "ws",
        day: "2026-08-02",
        classes: { compiled: 2, "steered-skip": 1, frontier: 1 },
      })?.classes,
    ).toEqual({ compiled: 2, memoized: 0, transparent: 0, steeredSkip: 1, frontier: 1 });
    expect(
      parseDcRun({
        workspace: "ws",
        day: "2026-08-02",
        compiled: 1,
        memoized: 0,
        transparent: 0,
        steeredSkip: 0,
        frontier: 1,
        providerCache: 4,
      })?.classes.providerCache,
    ).toBe(4);
    expect(parseDcRun({ workspace: "ws", day: "nope", compiled: 1, frontier: 1 })).toBeNull();
    expect(asTokenClasses({})).toBeNull();
  });

  test("all-zero five-class object with no providerCache is unmeasured, not fake 0%", () => {
    const leftover = { compiled: 0, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 0 };
    expect(asTokenClasses(leftover)).toBeNull();
    expect(asTokenClasses(emptyTokenClasses())).toBeNull();
    expect(asTokenClasses({ compiled: 0, memoized: 0, transparent: 0, "steered-skip": 0, frontier: 0 })).toBeNull();
    expect(parseDcRun({ workspace: "ws", day: "2026-08-02", classes: leftover })).toBeNull();
    expect(asTokenClasses({ compiled: 0, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 8 })).toEqual({
      compiled: 0,
      memoized: 0,
      transparent: 0,
      steeredSkip: 0,
      frontier: 8,
    });
    expect(asTokenClasses({ compiled: 0, memoized: 0, transparent: 0, steeredSkip: 5, frontier: 0 })).toEqual({
      compiled: 0,
      memoized: 0,
      transparent: 0,
      steeredSkip: 5,
      frontier: 0,
    });
    expect(asTokenClasses({ ...leftover, providerCache: 40 })).toEqual({ ...leftover, providerCache: 40 });
  });

  test("jsonl skips blank and invalid lines", () => {
    const runs = parseDcJsonl(`
{"workspace":"ws","day":"2026-08-03","compiled":1,"frontier":1}
not json
{"workspace":"ws","day":"bad"}

`);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.day).toBe("2026-08-03");
  });
});

describe("utc day keys", () => {
  test("utcDay is YYYY-MM-DD from epoch ms", () => {
    expect(utcDay(Date.UTC(2026, 7, 20, 23, 30))).toBe("2026-08-20");
    expect(utcDay(0)).toBe("");
  });

  test("utcDaysEnding is oldest-first inclusive of today", () => {
    const days = utcDaysEnding(Date.UTC(2026, 7, 20, 15), 3);
    expect(days).toEqual(["2026-08-18", "2026-08-19", "2026-08-20"]);
  });
});

describe("independent script matches aggregateDc", () => {
  test("07-dc-repro.jsonl: aggregateDc === script stdout JSON", async () => {
    const text = await Bun.file(JSONL).text();
    const expected = aggregateDc(parseDcJsonl(text));
    expect(expected.length).toBeGreaterThan(0);

    const proc = Bun.spawn(["bun", SCRIPT, JSONL], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exit).toBe(0);
    expect(stderr).toBe("");
    const golden = await Bun.file(join(ROOT, ".gauntlet/refs/07-dc-repro.out.txt")).text();
    expect(stdout).toBe(golden);

    const lines = stdout.replace(/\n$/, "").split("\n").filter(Boolean);
    expect(lines).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const row = expected[i]!;
      const line = lines[i]!;
      expect(line.startsWith(formatDcLine(row).slice(0, row.workspace.length + 12))).toBe(true);
      const jsonStart = line.indexOf("{");
      expect(jsonStart).toBeGreaterThan(0);
      const parsed = JSON.parse(line.slice(jsonStart)) as {
        workspace: string;
        day: string;
        dcShare: number;
        dcPct: number;
        billed: number;
        det: number;
        frontier: number;
        classes: typeof row.classes;
      };
      expect(parsed.workspace).toBe(row.workspace);
      expect(parsed.day).toBe(row.day);
      expect(parsed.dcShare).toBe(row.dcShare);
      expect(parsed.dcPct).toBe(row.dcPct);
      expect(parsed.billed).toBe(billedTokens(row.classes));
      expect(parsed.det).toBe(detTokens(row.classes));
      expect(parsed.frontier).toBe(row.classes.frontier);
      expect(parsed.classes).toEqual(row.classes);
      const prefix = `${row.workspace} ${row.day} ${row.dcPct} ${parsed.billed} ${parsed.det} ${parsed.frontier}`;
      expect(line.startsWith(prefix)).toBe(true);
    }
  });
});

test("addTokenClasses does not invent cache when both sides omit it", () => {
  const a = emptyTokenClasses();
  addTokenClasses(a, { compiled: 1, memoized: 0, transparent: 0, steeredSkip: 0, frontier: 0 });
  expect(a.providerCache).toBeUndefined();
});
