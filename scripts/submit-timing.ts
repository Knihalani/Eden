#!/usr/bin/env bun
/**
 * Times the UserPromptSubmit hook process of two plugins, interleaved run by run, so both sides share the
 * machine's load (A5 §2 wants 1,000 samples for a p99). The soak (`harness/replay.ts --soak`) stays the guard's
 * instrument; this resolves a smaller Submit cost on a quiet machine. Run it with an A/A pair (the same plugin
 * on both sides) to see its own noise at the current load.
 *
 *   bun scripts/submit-timing.ts --base PLUGIN_DIR --new PLUGIN_DIR [--runs 1000] [--transcript small|big]
 *
 * The transcript holds 200 typed notes (about 20 KB), or with `big` 200 tool results of about 10 KB each as
 * well. The prompts state no retraction or revocation. Prints p50, p90 and p99 per side, then the deltas.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function argument(args: string[], name: string, fallback?: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
}

function transcriptLines(big: boolean): string[] {
  const lines: string[] = [];
  for (let i = 0; i < 200; i++) {
    if (big) {
      const result = { type: "tool_result", tool_use_id: `t${i}`, content: "log line ".repeat(1200) };
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [result] } }));
    }
    const note = `Note ${i}: the billing service retries ${i} times before paging.`;
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: note } }));
    const reply = [{ type: "text", text: `Recorded note ${i}.` }];
    lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: reply } }));
  }
  return lines;
}

/** The q-th quantile of a sample, by the nearest-rank rule. */
export function quantile(sample: readonly number[], q: number): number {
  const sorted = [...sample].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const plugins = { base: argument(args, "--base"), next: argument(args, "--new") };
  if (!plugins.base || !plugins.next) {
    console.error(
      "usage: bun scripts/submit-timing.ts --base PLUGIN_DIR --new PLUGIN_DIR [--runs N] [--transcript small|big]",
    );
    process.exit(2);
  }
  const runs = Number(argument(args, "--runs", "1000"));
  const big = argument(args, "--transcript", "small") === "big";
  const homes = {
    base: mkdtempSync(join(tmpdir(), "eden-timing-base-")),
    next: mkdtempSync(join(tmpdir(), "eden-timing-new-")),
  };
  const transcript = join(homes.base, "t.jsonl");
  writeFileSync(transcript, transcriptLines(big).join("\n") + "\n");

  const submit = (side: "base" | "next", i: number): number => {
    const home = homes[side];
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "s-timing",
      prompt_id: `p${i}`,
      transcript_path: transcript,
      cwd: home,
      prompt: `how many times does the billing service retry, case ${i % 7}?`,
    };
    const started = performance.now();
    Bun.spawnSync(["/bin/sh", "-c", `bun --no-install "${plugins[side]}/scripts/hook.ts" || echo '{}'`], {
      env: {
        PATH: process.env.PATH!,
        HOME: home,
        TMPDIR: tmpdir(),
        EDEN_HOME: home,
        EDEN_MEMORY_DIR: join(home, "memory"),
      },
      stdin: new TextEncoder().encode(JSON.stringify(payload)),
    });
    return performance.now() - started;
  };

  try {
    // Warm both sides' module caches, then alternate which side goes first.
    for (let i = 0; i < 5; i++) {
      submit("base", i);
      submit("next", i);
    }
    const ms = { base: [] as number[], next: [] as number[] };
    for (let i = 0; i < runs; i++) {
      const order: ("base" | "next")[] = i % 2 ? ["base", "next"] : ["next", "base"];
      for (const side of order) ms[side].push(submit(side, i));
    }
    const stats = (side: "base" | "next") => [0.5, 0.9, 0.99].map((q) => quantile(ms[side], q));
    const [base, next] = [stats("base"), stats("next")];
    const fixed = (xs: number[]) => xs.map((x) => x.toFixed(1)).join(" / ");
    console.log(`transcript ${big ? "big" : "small"}, n ${runs} per side, p50 / p90 / p99 ms`);
    console.log(`base ${fixed(base)}`);
    console.log(`new  ${fixed(next)}`);
    console.log(
      `Δ    ${next.map((x, i) => `${x - base[i]! >= 0 ? "+" : "−"}${Math.abs(x - base[i]!).toFixed(1)}`).join(" / ")}`,
    );
  } finally {
    for (const home of Object.values(homes)) rmSync(home, { recursive: true, force: true });
  }
}
