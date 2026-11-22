import { describe, expect, test } from "bun:test";
import { tmpDir } from "@eden/primitives";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { main, type DaysCallsOptions, type DaysCallsUser, type PlantedRow } from "./days-calls";
import { JournalRefused, partialPath } from "./run-journal";

// R4 (D813): with `--json F`, each user lands in F.partial.jsonl as it finishes; a restart with `--resume` runs only
// the users missing from it (a torn last line included) and writes the same report as a run never stopped. $0: the user
// run is a stand-in that counts its calls.
describe("days-calls --resume (D813)", () => {
  /** A stand-in for `daysCalls`: a user made from the seed alone, every call counted, killed at `killAt`. */
  const fake =
    (calls: number[], killAt = -1) =>
    async (seed: number, o: DaysCallsOptions): Promise<DaysCallsUser> => {
      if (seed === killAt) throw new Error("killed");
      calls.push(seed);
      o.onPlanted?.({ seed, task: `t${seed}`, kind: "hidden", day: 0, poolSize: 3, rank: 1 } as PlantedRow);
      const n = seed % 7;
      return {
        seed,
        requests: 10 + n,
        days: o.days,
        counts: { "request gmail search": n + 1, "backfill gmail list": 3 },
        freshness: { calls: n },
        fetchedItems: n,
        refetched: 0,
        updatePackets: 1,
        changed: 1,
        fates: { unhanded: 0, updated: 1, unpolled: 0, unseen: 0, undelivered: 0 },
        staleHeld: 0,
        surfaced: { hidden: { n: 2, got: 1 } },
        requestCallsByDay: [n + 1],
        requestsByDay: [10 + n],
        midFates: { unhanded: 0, updated: 0, unpolled: 0, unseen: 0, undelivered: 0 },
        midDelays: [],
        bySource: {},
        surfacedBy: {},
      };
    };
  const quiet = () => {};
  const argv = (out: string, ...more: string[]) => [
    ...["--seeds", "41,42,43,44", "--days", "2", "--json", out, "--pool-diag", `${out}.diag`],
    ...more,
  ];

  test("a killed run resumes with only the users it had not finished, and reports as an unbroken one", async () => {
    const dir = tmpDir("days-resume-");
    const whole = join(dir, "whole.json");
    const wholeCalls: number[] = [];
    await main(argv(whole), fake(wholeCalls), quiet);
    expect(wholeCalls).toEqual([41, 42, 43, 44]);
    // A finished run leaves no journal.
    expect(existsSync(partialPath(whole))).toBe(false);

    const cut = join(dir, "cut.json");
    const first: number[] = [];
    await expect(main(argv(cut), fake(first, 43), quiet)).rejects.toThrow("killed");
    expect(first).toEqual([41, 42]);
    // The kill also tore a line mid-write.
    appendFileSync(partialPath(cut), '{"unit":"w43","data":{"user":{"seed"');
    // The same command again without --resume is refused: the finished users are not overwritten.
    await expect(main(argv(cut), fake([]), quiet)).rejects.toBeInstanceOf(JournalRefused);
    // A changed configuration cannot reuse them.
    await expect(main([...argv(cut, "--resume"), "--ask"], fake([]), quiet)).rejects.toThrow(/changed: argv/);
    const second: number[] = [];
    const lines: string[] = [];
    await main(argv(cut, "--resume"), fake(second), (l) => void lines.push(l));
    expect(second).toEqual([43, 44]);
    expect(lines.at(-1)).toContain("resumed: 2 of 4 users");
    expect(lines.at(-1)).toContain("1 torn lines");
    expect(readFileSync(cut, "utf8")).toBe(readFileSync(whole, "utf8"));
    expect(readFileSync(`${cut}.diag`, "utf8")).toBe(readFileSync(`${whole}.diag`, "utf8"));
    expect(existsSync(partialPath(cut))).toBe(false);
  });

  test("another seed list after a kill reuses the finished users: the key leaves --seeds out", async () => {
    const dir = tmpDir("days-resume-");
    const out = join(dir, "out.json");
    await expect(main(argv(out), fake([], 42), quiet)).rejects.toThrow("killed");
    const calls: number[] = [];
    await main(
      ["--seeds", "41,42", "--days", "2", "--json", out, "--pool-diag", `${out}.diag`, "--resume"],
      fake(calls),
      quiet,
    );
    expect(calls).toEqual([42]);
  });

  test("--pool-diag on the resume only still has every user's rows: they are journalled either way", async () => {
    const dir = tmpDir("days-resume-");
    const whole = join(dir, "whole.json");
    await main(argv(whole), fake([]), quiet);
    const cut = join(dir, "cut.json");
    const plain = ["--seeds", "41,42,43,44", "--days", "2", "--json", cut];
    await expect(main(plain, fake([], 43), quiet)).rejects.toThrow("killed");
    await main([...plain, "--pool-diag", `${cut}.diag`, "--resume"], fake([]), quiet);
    expect(readFileSync(`${cut}.diag`, "utf8")).toBe(readFileSync(`${whole}.diag`, "utf8"));
  });
});
