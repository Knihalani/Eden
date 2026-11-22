import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "@eden/primitives";

const file = join(import.meta.dir, "hidden-funnel.ts");
const run = (args: string[]) =>
  spawnSync("bun", [file, ...args], {
    encoding: "utf8",
    env: { ...process.env, OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "" },
  });

test("oracle/noisy CLI needs no key or replay cache and summarizes the actual pool", () => {
  for (const mode of ["oracle", "noisy"]) {
    const json = join(tmpDir("oracle-cli-"), "result.json");
    const r = run([
      "--check",
      mode,
      "--suite",
      "hidden",
      "--seeds",
      "41",
      "--limit",
      "1",
      "--time",
      "0",
      "--serial",
      "--no-record",
      "--config",
      '{"syncMaxItems":100,"syncLocalComplete":false}',
      "--json",
      json,
    ]);
    expect(r.status).toBe(0);
    const data = JSON.parse(readFileSync(json, "utf8"));
    expect(data.check).toMatchObject({
      mode,
      proxy: true,
      tp: mode === "oracle" ? 1 : 0.85,
      fp: mode === "oracle" ? 0 : 0.05,
      costUsdAsMade: 0,
      failures: 0,
    });
    expect(data.check.calls).toBeGreaterThan(0);
    for (const variant of ["hidden", "control"]) {
      const pooled = data.perTask.filter(
        (t: { variant: string; pushPoolAt?: number }) => t.variant === variant && (t.pushPoolAt ?? -1) >= 0,
      ).length;
      expect(data.total[variant].pool).toBe(pooled);
    }
    expect(r.stdout).toContain("POOL hidden:");
    expect(r.stdout).not.toContain("recorded ");
  }
}, 30000);

test("CLI refuses invalid rates and rates on a non-noisy mode", () => {
  for (const args of [
    ["--check", "noisy", "--check-tp", "2"],
    ["--check", "noisy", "--check-fp", "NaN"],
    ["--check", "oracle", "--check-tp", ".5"],
  ]) {
    const r = run([...args, "--no-record"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/check (TP|FP) must be|need --check noisy/);
  }
});
