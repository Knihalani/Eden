#!/usr/bin/env bun
/**
 * Times the PreToolUse guard's hook process (A5 `p99_hook_ms`: guard < 80 ms; P2.3's target 2), as Claude Code runs
 * it: the handler's shell command from `hooks/hooks.json`, a fresh process per call, the payload on stdin. A5 §2 wants
 * 1,000 samples for a p99. Run it alone on a quiet machine: it prints the 1-minute load before and after.
 *
 *   bun scripts/guard-timing.ts --plugin PLUGIN_DIR [--runs 1000] [--rules 100] [--rows 2000]
 *
 * The store is a repo's, planted through the memory hook: `--rules` typed rules (one of them "Don't merge PRs
 * yourself.", the rest of other classes and objects) and `--rows` plain notes. `guard.context` and `guard.ask` are on,
 * so every sample takes the whole path: the re-check, the index and validity reads, `guard.log` under its lock, the
 * ledger and the wide event. Two cases, interleaved: `gh pr merge N` (a rule applies: it asks), and
 * `git push origin feature-N` (the push-upstream handler; no rule applies).
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

/** The command `hooks.json` registers for a class's first `if` rule. */
function guardCommand(pluginDir: string, cls: string): string {
  const groups = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")).hooks.PreToolUse as {
    hooks: { command: string }[];
  }[];
  const command = groups
    .flatMap((group) => group.hooks)
    .find((handler) => handler.command.includes(` guard ${cls} 1 `))?.command;
  if (!command) throw new Error(`${pluginDir}: no PreToolUse handler for ${cls}`);
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
    console.error("usage: bun scripts/guard-timing.ts --plugin PLUGIN_DIR [--runs N] [--rules N] [--rows N]");
    process.exit(2);
  }
  // The hooks run in the project, so a relative plugin path would find no hook script.
  const plugin = resolve(given);
  const runs = Number(argument(args, "--runs", "1000"));
  const rules = Number(argument(args, "--rules", "100"));
  const rows = Number(argument(args, "--rows", "2000"));
  const home = mkdtempSync(join(tmpdir(), "eden-guard-timing-"));
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
  const asks = { merge: 0, push: 0 };
  const run = (command: string, payload: Record<string, unknown>, side?: keyof typeof asks): number => {
    const started = performance.now();
    const out = Bun.spawnSync(["/bin/sh", "-c", command], {
      cwd: project,
      env,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
    });
    const ms = performance.now() - started;
    if (side && out.stdout.toString().includes('"permissionDecision":"ask"')) asks[side]++;
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
    const commands = { merge: guardCommand(plugin, "integrate"), push: guardCommand(plugin, "push-upstream") };
    const call = (side: "merge" | "push", i: number) =>
      run(
        commands[side],
        {
          hook_event_name: "PreToolUse",
          session_id: "s-timing",
          cwd: project,
          tool_name: "Bash",
          tool_input: { command: side === "merge" ? `gh pr merge ${i}` : `git push origin feature-${i}` },
          tool_use_id: `toolu_timing_${side}_${i}`,
          permission_mode: "default",
        },
        side,
      );
    for (let i = 0; i < 5; i++) call("merge", -i - 1);
    asks.merge = 0;
    const before = loadavg()[0]!;
    const ms = { merge: [] as number[], push: [] as number[] };
    for (let i = 0; i < runs; i++)
      for (const side of i % 2 ? (["merge", "push"] as const) : (["push", "merge"] as const))
        ms[side].push(call(side, i));
    const after = loadavg()[0]!;
    // A sample that never reached the guard times nothing: refuse to report it.
    if (asks.merge !== runs || asks.push !== 0) throw new Error(`asks: merge ${asks.merge}/${runs}, push ${asks.push}`);
    const fixed = (xs: number[]) => [0.5, 0.9, 0.99].map((q) => quantile(xs, q).toFixed(1)).join(" / ");
    console.log(
      `store: ${rules} typed rules, ${rows} notes; n ${runs} per case; load ${before.toFixed(2)} → ${after.toFixed(2)}`,
    );
    console.log(`p50 / p90 / p99 ms, max; asks`);
    console.log(`gh pr merge (a rule applies)  ${fixed(ms.merge)}, ${Math.max(...ms.merge).toFixed(1)}; ${asks.merge}`);
    console.log(`git push (no rule applies)    ${fixed(ms.push)}, ${Math.max(...ms.push).toFixed(1)}; ${asks.push}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
