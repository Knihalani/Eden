/**
 * `pi-ab --resume` (R4, D813), end to end at $0: pi-ab runs in its own process with `fake-openrouter.ts` preloaded in
 * place of OpenRouter (every call counted in a log, no network), is killed with SIGKILL partway through, has a line
 * torn as a kill mid-write would leave it, and is started again. The restart refuses without `--resume` and with a
 * changed configuration; with `--resume` it calls the agent and grader only for the units the journal lacks, and its
 * results file equals the one an unbroken run writes.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "./ab-common";
import { partialPath } from "./run-journal";

const LAB = import.meta.dir;

/** One pi-ab process (independent runs are started side by side: each is about a second of start-up). */
async function piAb(dir: string, name: string, out: string, extra: string[], killAfter = -1) {
  const log = join(dir, `${name}.log`);
  const run = Bun.spawn(
    [
      ...["bun", "--preload", join(LAB, "fake-openrouter.ts"), join(LAB, "pi-ab.ts")],
      ...["--suite", "train1", "--variants", "hidden", "--seeds", "41", "--limit", "3"],
      ...["--conditions", "tools,eden+nokey", "--time-scale", "0", "--out", join(dir, out)],
      ...extra,
    ],
    {
      env: { ...process.env, OPENROUTER_API_KEY: "fake", FAKE_LOG: log, FAKE_KILL_AFTER: String(killAfter) },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(run.stderr).text();
  await run.exited;
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return {
    status: run.exitCode,
    signal: run.signalCode,
    stderr,
    agent: calls.filter((c) => c.startsWith("agent")).length,
    grader: calls.filter((c) => c === "grader").length,
  };
}

type Report = {
  results: RunResult[];
  spent: number;
  days?: { seed: number; kind: string; recapUsd?: number }[];
  resumed?: { units: number; unitsUsd: number; spentBeforeUsd: number; biased: boolean };
};
const read = (dir: string, out: string) => JSON.parse(readFileSync(join(dir, out), "utf8")) as Report;
/** What a run decides, task by task (wall times and timelines differ between any two runs). */
const decided = (r: Report) =>
  r.results
    .map((x) => ({
      task: x.task,
      condition: x.condition,
      answer: x.answer,
      facts: x.facts,
      modelCalls: x.modelCalls,
      costUsd: x.costUsd,
      injectedItems: x.injectedItems,
      error: x.error,
    }))
    .sort((a, b) => `${a.condition} ${a.task}`.localeCompare(`${b.condition} ${b.task}`));
/** The journal's finished units, and the agent and grader calls they stand for (a task each, a recap each). */
function journalled(path: string) {
  const units = readFileSync(path, "utf8")
    .split("\n")
    .slice(1)
    .filter((l) => l.endsWith("}"))
    .map((l) => JSON.parse(l) as { data?: { results: RunResult[]; days: unknown[] } })
    .filter((l): l is { data: { results: RunResult[]; days: unknown[] } } => !!l.data);
  const tasks = units.reduce((n, u) => n + u.data.results.length, 0);
  return { units: units.length, agent: tasks + units.reduce((n, u) => n + u.data.days.length, 0), grader: tasks };
}

describe("pi-ab --resume (D813)", () => {
  for (const shape of [
    { name: "one request a session: a unit is a task", extra: [] as string[], killAfter: 3 },
    { name: "--day 2: a unit is a whole day, its recap included", extra: ["--day", "2"], killAfter: 4 },
  ]) {
    test(
      shape.name,
      async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-ab-resume-"));
        const [whole, cut] = await Promise.all([
          piAb(dir, "whole", "whole.json", shape.extra),
          piAb(dir, "cut", "cut.json", shape.extra, shape.killAfter),
        ]);
        expect(whole.status).toBe(0);
        // A finished run leaves no journal: its results file holds everything.
        expect(existsSync(partialPath(join(dir, "whole.json")))).toBe(false);
        expect(cut.signal).toBe("SIGKILL");
        const journal = partialPath(join(dir, "cut.json"));
        const done = journalled(journal);
        expect(done.units).toBeGreaterThan(0);
        appendFileSync(journal, '{"unit":"0|tools|w41:train1:x","data":{"results":[{"task"');

        // Without --resume the paid units are not overwritten; a changed configuration cannot reuse them.
        const [refused, changed] = await Promise.all([
          piAb(dir, "refused", "cut.json", shape.extra),
          piAb(dir, "changed", "cut.json", [...shape.extra, "--resume", "--tool-exec", "sequential"]),
        ]);
        expect(refused.status).toBe(2);
        expect(refused.stderr).toContain("pass --resume");
        expect(changed.status).toBe(2);
        expect(changed.stderr).toContain("changed: argv");
        expect(refused.agent + changed.agent).toBe(0);

        // Under --day an Eden arm resumed against an Eden that never saw the reused days: refused unless accepted.
        const days = shape.extra.includes("--day");
        if (days) {
          const biased = await piAb(dir, "biased", "cut.json", [...shape.extra, "--resume"]);
          expect(biased.status).toBe(2);
          expect(biased.stderr).toContain("--resume-biased");
          expect(biased.agent).toBe(0);
        }
        const again = [...shape.extra, "--resume", ...(days ? ["--resume-biased"] : [])];
        const resumed = await piAb(dir, "resumed", "cut.json", again);
        expect(resumed.status).toBe(0);
        expect(resumed.stderr).toContain(`${done.units} finished units reused at $0`);
        // (Under --day the refused attempt above already accepted the journal and cut the torn line off.)
        if (!days) expect(resumed.stderr).toContain("1 torn lines run again");
        // Only the units the journal lacked called the agent and the grader again.
        expect(resumed.agent).toBe(whole.agent - done.agent);
        expect(resumed.grader).toBe(whole.grader - done.grader);
        const a = read(dir, "whole.json");
        const b = read(dir, "cut.json");
        expect(decided(b)).toEqual(decided(a));
        // The tasks cost what they cost unbroken; `spent` also carries what the killed attempt paid for units it
        // never finished (its last spend note), so it is at least the unbroken run's.
        const cost = (r: Report) => r.results.reduce((n, x) => n + x.costUsd, 0);
        expect(cost(b)).toBeCloseTo(cost(a), 10);
        expect(b.spent).toBeGreaterThanOrEqual(a.spent - 1e-9);
        expect(b.resumed!.units).toBe(done.units);
        expect(b.resumed!.spentBeforeUsd).toBeGreaterThanOrEqual(b.resumed!.unitsUsd - 1e-9);
        expect(b.resumed!.biased).toBe(days);
        const report = Bun.spawnSync(["bun", join(LAB, "pi-ab-report.ts"), join(dir, "cut.json")]);
        expect(report.stdout.toString()).toContain("RESUMED (D813)");
        expect(report.stdout.toString().includes("BIASED")).toBe(days);
        expect((b.days ?? []).map((d) => [d.seed, d.kind, d.recapUsd]).sort()).toEqual(
          (a.days ?? []).map((d) => [d.seed, d.kind, d.recapUsd]).sort(),
        );
        expect(existsSync(journal)).toBe(false);
      },
      120_000,
    );
  }
});
