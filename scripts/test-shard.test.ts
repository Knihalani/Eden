import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_LISTED_SECONDS,
  TIMES_PATH,
  UNLISTED_SECONDS,
  deal,
  formatTimes,
  parseShard,
  readTimes,
  timesFromLog,
} from "./test-shard";

const files = (count: number) => Array.from({ length: count }, (_, i) => `t/${String(i).padStart(3, "0")}.test.ts`);
const loads = (slices: string[][], times: Map<string, number>) =>
  slices.map((slice) => slice.reduce((sum, file) => sum + (times.get(file) ?? UNLISTED_SECONDS), 0));

describe("deal", () => {
  test("every file goes to exactly one slice", () => {
    const all = files(57);
    for (const n of [1, 2, 6, 7, 60]) {
      const slices = deal(all, new Map(), n);
      expect(slices).toHaveLength(n);
      expect(slices.flat().sort()).toEqual(all);
    }
  });

  test("each file, slowest first, goes to the slice with the least time so far", () => {
    const times = new Map([
      ["a", 10],
      ["b", 6],
      ["c", 5],
      ["d", 4],
    ]);
    expect(deal(["d", "c", "b", "a"], times, 2)).toEqual([
      ["a", "d"],
      ["b", "c"],
    ]);
  });

  test("the same slices whatever order the files come in, and duplicates count once", () => {
    const all = files(40);
    const times = new Map(all.slice(0, 10).map((file, i) => [file, 30 - i]));
    const reversed = [...all].reverse();
    expect(deal(reversed, times, 6)).toEqual(deal(all, times, 6));
    expect(deal([...all, ...all], times, 6)).toEqual(deal(all, times, 6));
  });

  test("unlisted files spread evenly", () => {
    const sizes = deal(files(60), new Map(), 6).map((slice) => slice.length);
    expect(sizes).toEqual([10, 10, 10, 10, 10, 10]);
  });

  test("on the committed table, no slice runs over a sixth of the suite by more than its slowest file", () => {
    const times = readTimes(readFileSync(TIMES_PATH, "utf8"));
    const all = [...times.keys(), ...files(300)];
    const perSlice = loads(deal(all, times, 6), times);
    const total = perSlice.reduce((sum, load) => sum + load, 0);
    expect(Math.max(...perSlice)).toBeLessThanOrEqual(total / 6 + Math.max(...times.values()));
  });
});

describe("parseShard", () => {
  test("reads k/N with 1 <= k <= N", () => {
    expect(parseShard("1/6")).toEqual({ k: 1, n: 6 });
    expect(parseShard("6/6")).toEqual({ k: 6, n: 6 });
  });

  test("rejects anything else", () => {
    for (const spec of ["0/6", "7/6", "1/0", "6", "a/b", "1/6x", " 1/6", ""]) {
      expect(() => parseShard(spec)).toThrow("a shard looks like k/N");
    }
  });
});

describe("readTimes", () => {
  test("reads `<seconds> <path>` lines and skips comments and blank lines", () => {
    const times = readTimes("# header\n\n134.3 benchmarks/campaign/edge.test.ts\n2 src/a.test.ts\n");
    expect([...times]).toEqual([
      ["benchmarks/campaign/edge.test.ts", 134.3],
      ["src/a.test.ts", 2],
    ]);
  });

  test("names a malformed line", () => {
    expect(() => readTimes("# header\nedge.test.ts 134.3\n")).toThrow("line 2");
  });

  test("every file the committed table lists exists", () => {
    const root = join(import.meta.dir, "..");
    const missing = [...readTimes(readFileSync(TIMES_PATH, "utf8")).keys()].filter(
      (file) => !existsSync(join(root, file)),
    );
    expect(missing).toEqual([]);
  });
});

describe("timesFromLog", () => {
  const line = (job: string, at: string, text: string) => `${job}\tRun bun run test\t2026-10-04T20:${at}Z ${text}`;
  const log = [
    line("test (1)", "39:50.9324141", "bun test v1.3.13 (bf2e2cec)"),
    line("test (1)", "39:51.0000000", "##[group]a/slow.test.ts:"),
    line("test (2)", "39:52.5000000", "##[group]b/one.test.ts:"),
    line("test (1)", "41:11.5000000", "##[group]a/fast.test.ts:"),
    line("test (1)", "41:12.0000000", "(pass) a fast test [0.40ms]"),
    line("test (2)", "39:55.0000000", "Ran 3 tests across 1 file. [4.00s]"),
    line("test (1)", "41:12.2500000", "Ran 9 tests across 2 files. [81.30s]"),
  ].join("\n");

  test("times each file from its start to the next file's start, or the end of the run", () => {
    expect(Object.fromEntries(timesFromLog(log))).toEqual({
      "a/slow.test.ts": 80.5,
      "a/fast.test.ts": 0.75,
      "b/one.test.ts": 2.5,
    });
  });

  test("the table keeps files of at least MIN_LISTED_SECONDS, slowest first", () => {
    expect(MIN_LISTED_SECONDS).toBe(2);
    const table = formatTimes(timesFromLog(log));
    expect(table.split("\n").filter((row) => row && !row.startsWith("#"))).toEqual([
      "80.5 a/slow.test.ts",
      "2.5 b/one.test.ts",
    ]);
    expect([...readTimes(table).keys()]).toEqual(["a/slow.test.ts", "b/one.test.ts"]);
  });
});
