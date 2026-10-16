#!/usr/bin/env bun
/**
 * A5 `abort_rate` at the budget that ships (A4 §5.1 step 0: 150 ms from a Submit's process start, P4.2): runs N
 * human Submits one after another through a plugin's UserPromptSubmit command, as Claude Code runs it (`/bin/sh -c`),
 * with no `EDEN_SUBMIT_BUDGET_MS` (the harness sets 1 s), against a copy of a store, and counts the Submits whose wide
 * event says `aborted`. Prints the abort rate, the handler's `ms` and the process wall time.
 *
 *   bun scripts/abort-rate.ts --plugin DIR --repo DIR --memory DIR --out DIR [--runs 500]
 *
 * `--repo` is the git checkout the Submits run in (a store is keyed by its repo, D1) and `--memory` a memory root
 * holding that repo's store, which is copied to `--out` first so the runs leave it as it was. Run it alone, with the
 * repo where a user's would be (not under macOS `os.tmpdir()`, which slows every Bun start by tens of ms).
 */
import { cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const PROMPTS = [
  "What's the storefront queue?",
  "which ticket moved last?",
  "how do background jobs run?",
  "what database do we use?",
  "where is the sprint board?",
  "what's the deploy target?",
];

function argument(args: string[], name: string, fallback?: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
}

async function main(args: string[]): Promise<number> {
  const plugin = argument(args, "--plugin");
  const repo = argument(args, "--repo");
  const memory = argument(args, "--memory");
  const out = argument(args, "--out");
  const runs = Number(argument(args, "--runs", "500"));
  if (!plugin || !repo || !memory || !out || !(runs > 0)) {
    console.error("usage: bun scripts/abort-rate.ts --plugin DIR --repo DIR --memory DIR --out DIR [--runs N]");
    return 2;
  }
  const root = join(resolve(out), "memory");
  rmSync(out, { recursive: true, force: true });
  cpSync(resolve(memory), root, { recursive: true });
  rmSync(join(root, "hook.log.d"), { recursive: true, force: true });
  const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")).hooks;
  const command = hooks.UserPromptSubmit[0].hooks[0].command as string;
  const env = {
    PATH: process.env.PATH!,
    HOME: resolve(out),
    EDEN_HOME: resolve(out),
    EDEN_MEMORY_DIR: root,
    EDEN_SLEEP_IDLE: "off",
    CLAUDE_PLUGIN_ROOT: resolve(plugin),
  };
  const wall: number[] = [];
  for (let i = 0; i < runs; i++) {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: `abort-rate-${i}`,
      cwd: resolve(repo),
      prompt: PROMPTS[i % PROMPTS.length],
    };
    const started = performance.now();
    const child = Bun.spawn({
      cmd: ["/bin/sh", "-c", command],
      cwd: resolve(repo),
      env,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    wall.push(performance.now() - started);
  }
  const events = readdirSync(join(root, "hook.log.d"))
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(root, "hook.log.d", name), "utf8").split("\n").filter(Boolean))
    .map((line) => JSON.parse(line) as { ev: string; aborted?: boolean; ms?: number })
    .filter((event) => event.ev === "UserPromptSubmit");
  const aborted = events.filter((event) => event.aborted).length;
  const ms = events.map((event) => event.ms ?? 0).sort((a, b) => a - b);
  wall.sort((a, b) => a - b);
  const pct = (n: number) => `${((100 * n) / Math.max(1, events.length)).toFixed(2)}%`;
  console.log(`Submits ${events.length} (of ${runs}), aborted ${aborted} (${pct(aborted)}; A5 gate <= 0.5%)`);
  console.log(`handler ms p50 ${quantile(ms, 0.5)} p99 ${quantile(ms, 0.99)} max ${ms.at(-1)}`);
  console.log(
    `process wall ms p50 ${quantile(wall, 0.5).toFixed(1)} p99 ${quantile(wall, 0.99).toFixed(1)} max ${wall.at(-1)!.toFixed(1)}`,
  );
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
