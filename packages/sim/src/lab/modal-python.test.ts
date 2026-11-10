import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * The Modal lab apps' Python unit tests (`packages/sim/modal/tests`: the fan-out's sharding and cap split, result
 * merging, the distillation's data checks, the embedding screen's scoring), run from here so `bun run check` covers
 * them. No Modal and no token: those modules import neither. Skipped when the machine has no python3.
 */
const dir = join(import.meta.dir, "..", "..", "modal");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

test.skipIf(!hasPython)("packages/sim/modal's Python unit tests pass", () => {
  // -I: isolated (no user site, no cwd on the path); -B: no __pycache__ left in the tree.
  const run = spawnSync("python3", ["-I", "-B", "-m", "unittest"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  if (run.status !== 0) console.error(run.stdout, run.stderr);
  expect(run.status).toBe(0);
  expect(run.stderr).toMatch(/Ran \d+ tests/);
});

test.skipIf(!hasPython)(
  "the fan-out presets' `default minus <part>` variants are PARTS' own settings (D487)",
  async () => {
    const { PARTS } = await import("@eden/engine");
    const run = spawnSync("python3", ["-I", "-B", "fanout_plan.py", "presets"], { cwd: dir, encoding: "utf8" });
    expect(run.status).toBe(0);
    const { partVariants } = JSON.parse(run.stdout) as { partVariants: Record<string, Record<string, unknown>> };
    expect(Object.keys(partVariants).length).toBeGreaterThan(0);
    for (const [name, settings] of Object.entries(partVariants)) {
      const part = name.replace(/^minus-/, "") as keyof typeof PARTS;
      expect(settings, name).toEqual({ ...PARTS[part] });
    }
  },
);
