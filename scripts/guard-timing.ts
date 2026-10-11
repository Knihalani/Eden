#!/usr/bin/env bun
/**
 * Times the PreToolUse guard's hook process (A5 `p99_hook_ms`: guard < 80 ms; P2.3's target 2), as Claude Code runs
 * it: the handler's shell command from `hooks/hooks.json`, a fresh process per call, the payload on stdin. A5 §2 wants
 * 1,000 samples for a p99. Run it alone on a quiet machine: it prints the 1-minute load before and after.
 *
 *   bun scripts/guard-timing.ts --plugin PLUGIN_DIR [--runs 1000] [--rules 100] [--rows 2000] [--dir DIR]
 *
 * `--dir` holds the temporary home and project (default `os.tmpdir()`). On macOS, a hook whose cwd is under
 * `os.tmpdir()` (`/var/folders/…`) starts about 20 ms slower than one under `/private/tmp` or a checkout (P0.1, P2.3),
 * so time it where real projects live.
 *
 * The store is a repo's, planted through the memory hook: `--rules` typed rules (one of them "Don't merge PRs
 * yourself.", the rest of other classes and objects) and `--rows` plain notes. `guard.context` and `guard.ask` are on,
 * so an answered call takes the whole path: the re-check, the index and validity reads, `guard.log` under its lock,
 * the ledger and the wide event. Four cases, interleaved:
 * - `gh pr merge N` through the `gh *` handler: a rule applies, it asks;
 * - `git push origin feature-N` through `git *`: a class, no rule that applies;
 * - `git status` through `git *`: no class, so `hook.ts` exits before the guard loads;
 * - `echo $(date +%Y)`: every handler whose rule starts with a wildcard fires on a `$()` (the hooks reference), in
 *   parallel; its time is the slowest of them, what Claude Code waits for.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { quantile } from "./submit-timing";

function argument(args: string[], name: string, fallback?: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
}

type Handler = { command: string; if?: string };

/** The PreToolUse handlers `hooks.json` registers for Bash. */
function bashHandlers(pluginDir: string): Handler[] {
  const groups = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")).hooks.PreToolUse as {
    matcher?: string;
    hooks: Handler[];
  }[];
  return groups.filter((group) => group.matcher === "Bash").flatMap((group) => group.hooks);
}

/** The command of the handler whose `if` is `rule`. */
function handlerFor(handlers: readonly Handler[], rule: string): string {
  const command = handlers.find((handler) => handler.if === `Bash(${rule})`)?.command;
  if (!command) throw new Error(`no PreToolUse handler for Bash(${rule})`);
  return command;
}

const OTHER_RULES = [
  "Never force-push to {o}.",
  "Don't delete the {o} folder.",
  "Never deploy {o} on a Friday.",
  "Don't add {o} as a dependency.",
  "Never commit {o}.env files.",
  "Don't drop the {o} table.",
];

if (import.meta.main) {
  const args = process.argv.slice(2);
  const given = argument(args, "--plugin");
  if (!given) {
    console.error(
      "usage: bun scripts/guard-timing.ts --plugin PLUGIN_DIR [--runs N] [--rules N] [--rows N] [--dir DIR]",
    );
    process.exit(2);
  }
  // The hooks run in the project, so a relative plugin path would find no hook script.
  const plugin = resolve(given);
  const runs = Number(argument(args, "--runs", "1000"));
  const rules = Number(argument(args, "--rules", "100"));
  const rows = Number(argument(args, "--rows", "2000"));
  const home = mkdtempSync(join(argument(args, "--dir", tmpdir())!, "eden-guard-timing-"));
  const project = join(home, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q"], { cwd: project });
  const env = {
    PATH: process.env.PATH!,
    CLAUDE_PLUGIN_ROOT: plugin,
    HOME: home,
    TMPDIR: tmpdir(),
    EDEN_HOME: join(home, ".eden"),
    EDEN_MEMORY_DIR: join(home, ".eden", "memory"),
  };
  mkdirSync(env.EDEN_HOME, { recursive: true });
  writeFileSync(join(env.EDEN_HOME, "flags.json"), JSON.stringify({ "guard.context": "on", "guard.ask": "on" }));
  /** Asks seen per case: a sample counts only if the guard answered as the case expects. */
  const asks: Record<string, number> = { merge: 0, push: 0, status: 0, subst: 0 };
  const run = (command: string, payload: Record<string, unknown>, side?: string): number => {
    const started = performance.now();
    const out = Bun.spawnSync(["/bin/sh", "-c", command], {
      cwd: project,
      env,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
    });
    const ms = performance.now() - started;
    if (side && out.stdout.toString().includes('"permissionDecision":"ask"')) asks[side] = (asks[side] ?? 0) + 1;
    return ms;
  };
  /** Runs handlers at once, as Claude Code runs an event's matching handlers; the time until the last exits. */
  const runAll = async (handlerCommands: readonly string[], payload: Record<string, unknown>): Promise<number> => {
    const started = performance.now();
    const outs = await Promise.all(
      handlerCommands.map(async (command) => {
        const child = Bun.spawn(["/bin/sh", "-c", command], {
          cwd: project,
          env,
          stdin: new TextEncoder().encode(JSON.stringify(payload)),
          stdout: "pipe",
        });
        const out = await new Response(child.stdout).text();
        await child.exited;
        return out;
      }),
    );
    const ms = performance.now() - started;
    asks.subst = (asks.subst ?? 0) + outs.filter((out) => out.includes('"permissionDecision":"ask"')).length;
    return ms;
  };
  try {
    const submitCommand = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8")).hooks
      .UserPromptSubmit[0].hooks[0].command as string;
    const typed = [
      "Don't merge PRs yourself.",
      ...Array.from({ length: rules - 1 }, (_, i) => OTHER_RULES[i % 6]!.replace("{o}", `area${i}`)),
    ];
    const notes = Array.from({ length: rows }, (_, i) => `Note ${i}: the billing service retries ${i % 9} times.`);
    // One prompt per rule, so each is its own rule row; the notes in prompts of 50.
    const prompts = [
      ...typed,
      ...Array.from({ length: Math.ceil(rows / 50) }, (_, i) => notes.slice(i * 50, i * 50 + 50).join("\n")),
    ];
    prompts.forEach((prompt, i) =>
      run(submitCommand, {
        hook_event_name: "UserPromptSubmit",
        session_id: "s-plant",
        prompt_id: `p${i}`,
        cwd: project,
        prompt,
      }),
    );
    const handlers = bashHandlers(plugin);
    const commands = { merge: handlerFor(handlers, "gh *"), push: handlerFor(handlers, "git *") };
    const wildcards = handlers.filter((handler) => handler.if?.startsWith("Bash(*")).map((handler) => handler.command);
    const pre = (command: string, i: number, side: string) => ({
      hook_event_name: "PreToolUse",
      session_id: "s-timing",
      cwd: project,
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: `toolu_timing_${side}_${i}`,
      permission_mode: "default",
    });
    const cases = {
      merge: (i: number) => run(commands.merge, pre(`gh pr merge ${i}`, i, "merge"), "merge"),
      push: (i: number) => run(commands.push, pre(`git push origin feature-${i}`, i, "push"), "push"),
      status: (i: number) => run(commands.push, pre("git status", i, "status"), "status"),
      subst: (i: number) => runAll(wildcards, pre("echo $(date +%Y)", i, "subst")),
    };
    type Case = keyof typeof cases;
    const order = Object.keys(cases) as Case[];
    for (let i = 0; i < 5; i++) for (const side of order) await cases[side](-i - 1);
    for (const side of order) asks[side] = 0;
    const before = loadavg()[0]!;
    const ms = Object.fromEntries(order.map((side) => [side, [] as number[]])) as Record<Case, number[]>;
    for (let i = 0; i < runs; i++)
      for (let k = 0; k < order.length; k++) {
        const side = order[(i + k) % order.length]!;
        ms[side].push(await cases[side](i));
      }
    const after = loadavg()[0]!;
    // A sample that never reached the guard times nothing: refuse to report it.
    const wrong = order.filter((side) => asks[side] !== (side === "merge" ? runs : 0));
    if (wrong.length) throw new Error(`asks: ${order.map((side) => `${side} ${asks[side]}`).join(", ")}`);
    const fixed = (xs: number[]) => [0.5, 0.9, 0.99].map((q) => quantile(xs, q).toFixed(1)).join(" / ");
    console.log(
      `store: ${rules} typed rules, ${rows} notes; n ${runs} per case; load ${before.toFixed(2)} → ${after.toFixed(2)}`,
    );
    console.log(`p50 / p90 / p99 ms, max; asks`);
    const label: Record<Case, string> = {
      merge: "gh pr merge (a rule applies)",
      push: "git push (no rule applies)",
      status: "git status (no class: hook.ts exits)",
      subst: `echo $(...) (${wildcards.length} handlers at once)`,
    };
    for (const side of order)
      console.log(`${label[side].padEnd(40)} ${fixed(ms[side])}, ${Math.max(...ms[side]).toFixed(1)}; ${asks[side]}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
