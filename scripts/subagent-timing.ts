#!/usr/bin/env bun
/**
 * Times P2.5's two subagent hooks as Claude Code runs them: each handler's shell command from `hooks/hooks.json`, a
 * fresh process per call, the payload on stdin (A5 §2 wants 1,000 samples for a p99). Run it alone on a quiet machine:
 * it prints the 1-minute load before and after.
 *
 *   bun scripts/subagent-timing.ts --plugin PLUGIN_DIR [--runs 1000] [--rules 100] [--rows 2000] [--dir DIR]
 *
 * `--dir` holds the temporary home and project (default `os.tmpdir()`; on macOS a hook whose cwd is under
 * `os.tmpdir()` starts about 20 ms slower than one under `/private/tmp` or a checkout, P2.3).
 *
 * The store is a repo's, planted through the memory hook: `--rules` typed rules (one of them "Don't merge PRs
 * yourself."), `--rows` plain notes and one fact about `apps/web`. `deliver.subagent` is on. Each run times, in turn:
 * - `PreToolUse(Agent)` (the `Agent` matcher's handler), a task that names `apps/web/app/login.ts` and a merge: A4
 *   §5.3 wants it context-free, < 20 ms. Its in-process time is read from its wide event (`ms`);
 * - the SubagentStart of that launch, a new agent each time, which takes the launch's record and briefs the scope's
 *   fact and the merge rule. A sample whose packet lacks either times nothing, and the run refuses to report.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { quantile } from "./submit-timing";

function argument(args: string[], name: string, fallback?: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
}

type Group = { matcher?: string; hooks: { command: string }[] };

/** The command of an event's handler; for PreToolUse, the one whose matcher is `matcher`. */
function commandOf(pluginDir: string, event: string, matcher?: string): string {
  const groups = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8")).hooks[event] as Group[];
  const command = groups.find((group) => group.matcher === matcher)?.hooks[0]?.command;
  if (!command) throw new Error(`no ${event} handler${matcher ? ` for ${matcher}` : ""}`);
  return command;
}

/** The in-process `ms` of every wide event of `ev` that has `field`. */
function eventMs(memory: string, ev: string, field: string): number[] {
  const dir = join(memory, "hook.log.d");
  return readdirSync(dir)
    .flatMap((file) => readFileSync(join(dir, file), "utf8").split("\n"))
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.ev === ev && field in event && typeof event.ms === "number" ? [event.ms] : [];
      } catch {
        return [];
      }
    });
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
    console.error("usage: bun scripts/subagent-timing.ts --plugin DIR [--runs N] [--rules N] [--rows N] [--dir DIR]");
    process.exit(2);
  }
  const plugin = resolve(given);
  const runs = Number(argument(args, "--runs", "1000"));
  const rules = Number(argument(args, "--rules", "100"));
  const rows = Number(argument(args, "--rows", "2000"));
  const home = mkdtempSync(join(argument(args, "--dir", tmpdir())!, "eden-subagent-timing-"));
  const project = join(home, "project");
  mkdirSync(join(project, "apps", "web", "app"), { recursive: true });
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
  writeFileSync(join(env.EDEN_HOME, "flags.json"), JSON.stringify({ "deliver.subagent": "on" }));
  const run = (command: string, payload: Record<string, unknown>): { ms: number; out: string } => {
    const started = performance.now();
    const out = Bun.spawnSync(["/bin/sh", "-c", command], {
      cwd: project,
      env,
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
    });
    return { ms: performance.now() - started, out: out.stdout.toString() };
  };
  try {
    const submit = commandOf(plugin, "UserPromptSubmit");
    const typed = [
      "Don't merge PRs yourself.",
      "In apps/web the auth provider is Clerk.",
      ...Array.from({ length: rules - 1 }, (_, i) => OTHER_RULES[i % 6]!.replace("{o}", `area${i}`)),
    ];
    const notes = Array.from({ length: rows }, (_, i) => `Note ${i}: the billing service retries ${i % 9} times.`);
    const prompts = [
      ...typed,
      ...Array.from({ length: Math.ceil(rows / 50) }, (_, i) => notes.slice(i * 50, i * 50 + 50).join("\n")),
    ];
    prompts.forEach((prompt, i) =>
      run(submit, {
        hook_event_name: "UserPromptSubmit",
        session_id: "s-plant",
        prompt_id: `p${i}`,
        cwd: project,
        prompt,
      }),
    );
    const spawnCommand = commandOf(plugin, "PreToolUse", "Agent");
    const startCommand = commandOf(plugin, "SubagentStart");
    const transcript = join(home, "s-timing.jsonl");
    writeFileSync(transcript, "");
    const base = { session_id: "s-timing", cwd: project, transcript_path: transcript };
    const task = "merge the PR once you fix the redirect in apps/web/app/login.ts";
    const spawn = (i: number) =>
      run(spawnCommand, {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        tool_use_id: `toolu_timing_${i}`,
        tool_input: { description: "fix the redirect", prompt: task, subagent_type: "general-purpose" },
      });
    const start = (i: number) =>
      run(startCommand, {
        ...base,
        hook_event_name: "SubagentStart",
        agent_id: `a${i}`,
        agent_type: "general-purpose",
      });
    for (let i = 0; i < 5; i++) {
      spawn(-i - 1);
      start(-i - 1);
    }
    const before = loadavg()[0]!;
    const ms = { spawn: [] as number[], start: [] as number[] };
    let briefed = 0;
    for (let i = 0; i < runs; i++) {
      ms.spawn.push(spawn(i).ms);
      const started = start(i);
      ms.start.push(started.ms);
      if (started.out.includes("Clerk") && started.out.includes("merge PRs yourself")) briefed++;
    }
    const after = loadavg()[0]!;
    if (briefed !== runs)
      throw new Error(`SubagentStart briefed the scope's fact and the rule in ${briefed} of ${runs}`);
    const spawnIn = eventMs(env.EDEN_MEMORY_DIR, "PreToolUse", "spawn").slice(-runs);
    const startIn = eventMs(env.EDEN_MEMORY_DIR, "SubagentStart", "scope").slice(-runs);
    const fixed = (xs: number[]) => [0.5, 0.9, 0.99].map((q) => quantile(xs, q).toFixed(1)).join(" / ");
    console.log(
      `store: ${rules} typed rules, ${rows} notes; n ${runs} per hook; load ${before.toFixed(2)} → ${after.toFixed(2)}`,
    );
    console.log("p50 / p90 / p99 ms, max");
    const line = (label: string, xs: number[]) =>
      console.log(`${label.padEnd(44)} ${fixed(xs)}, ${Math.max(...xs).toFixed(1)} (n ${xs.length})`);
    line("PreToolUse(Agent), process", ms.spawn);
    line("PreToolUse(Agent), in-process (wide event)", spawnIn);
    line("SubagentStart, process", ms.start);
    line("SubagentStart, in-process (wide event)", startIn);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
