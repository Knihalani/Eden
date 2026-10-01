/**
 * Wave 5.4 silent-drop host (R1 class) + Wave 5.2 oblivious-regime cents.
 *
 * A headless Claude Code analogue that **always drops** `updatedToolOutput`
 * even when the rewrite is shape-correct. `additionalContext` still lands, so
 * S1b PreToolUse remainder deny still fires and remainder tools (including the
 * island-cost analogue) must not execute.
 *
 *   bun test benchmarks/campaign/silent-drop.test.ts
 *   bun run benchmarks/campaign/silent-drop.ts --fast
 *   bun run benchmarks/campaign/bench-negative.ts --fast   # n9 cell
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { respondToHook, type HookIn } from "../../packages/cli/src/hook";
import {
  applyHookOutput,
  modelVisibleText,
  type AppliedHook,
  type HookResponse,
} from "../../packages/cli/src/transcript-diff";
import { nativeTextOf } from "../../packages/cli/src/shapes";
import { appendLedgerRow } from "../../packages/cli/src/remainder";
import type { LiveTool } from "../../packages/cli/src/transparent";
import { TURN_CENTS, ISLAND_CENTS, type SessionStats } from "./session";
import { runScenario, summarize, type ArmRun, type ScenarioOut } from "./gates";

export { TURN_CENTS, ISLAND_CENTS };

const THINK_MS = Number(process.env.CAMPAIGN_THINK_MS ?? 0);
const TOOL_SLEEP_MS = Number(process.env.SILENT_DROP_TOOL_MS ?? 30);

/** ≥3-step read-only program. Bash is the island-cost analogue (ISLAND_CENTS if executed). */
export const COMPILABLE_PROGRAM: LiveTool = {
  name: "pr_summary",
  sequence: ["Read", "Grep", "Bash"],
  id: "silent-drop-pr",
  read_only: true,
  envelope: { inputs: { issue: ["101", "102", "103"] } },
};

export const WRITE_PROGRAM: LiveTool = {
  name: "patch_pr",
  sequence: ["Write", "Read", "Bash"],
  id: "silent-drop-write",
  read_only: false,
};

/** Remainder tool that bills ISLAND_CENTS=0.3 if the host actually runs it. */
export const ISLAND_TOOL = "Bash";

export const SENTINEL_MARK = "[eden:";

export type SilentDropCall = { tool: string; args: Record<string, unknown> };

export function compilableCalls(issue = "101"): SilentDropCall[] {
  return [
    { tool: "Read", args: { issue, file_path: "/repo/pr.ts" } },
    { tool: "Grep", args: { issue, pattern: "TODO" } },
    { tool: "Bash", args: { issue, command: "gh pr view" } },
  ];
}

export function uniqueCalls(id = "U-1"): SilentDropCall[] {
  return [
    { tool: "alpha", args: { id } },
    { tool: "bravo", args: { id } },
    { tool: "charlie", args: { id } },
  ];
}

export const N9_EXPECT =
  "host drops rewrite; remainder deny must not corrupt; suppressions counted; cents WIN or " +
  "INDISTINGUISHABLE within ±1%";

export type StretchResult = {
  stats: SessionStats;
  suppressions: number;
  denies: number;
  executions: number;
  remainderExecutions: number;
  islands: number;
  droppedRewrites: number;
  visibleSentinelHits: number;
  additionalContextHits: number;
  ledgerTransparent: number;
  ledgerSteeredSkip: number;
  ledgerHostDrop: number;
  steps: Array<{
    tool: string;
    denied: boolean;
    executed: boolean;
    applied?: AppliedHook;
    visibleText: string;
    additionalContext: string;
  }>;
  home: string;
};

export type StretchOpts = {
  arm: "raw" | "eden";
  calls: SilentDropCall[];
  liveTools?: LiveTool[];
  session?: string;
  /** Reuse a prepared EDEN_HOME (multi-stretch / second-entity). */
  home?: string;
  /** R1: always drop updatedToolOutput. Default true on the eden arm. */
  forceDrop?: boolean;
  islandTools?: string[];
  thinkMs?: number;
  toolSleepMs?: number;
};

function nativeResult(tool: string, args: Record<string, unknown>): unknown {
  if (tool === "Read") {
    const filePath = String(args.file_path ?? "/repo/pr.ts");
    return {
      type: "text",
      file: { filePath, content: "export {}", numLines: 1, startLine: 1, totalLines: 1 },
    };
  }
  if (tool === "Grep") {
    return { mode: "content", numFiles: 1, filenames: ["pr.ts"], content: "TODO none", numLines: 1 };
  }
  if (tool === "Bash") {
    return { stdout: "reviews=6", stderr: "", interrupted: false, isImage: false };
  }
  if (tool === "Write") {
    return {
      type: "create",
      filePath: String(args.file_path ?? "/repo/pr.ts"),
      content: "x",
      structuredPatch: [],
      originalFile: "",
    };
  }
  return { tool, id: args.id ?? args.issue, ok: true };
}

/**
 * Host that always drops the rewrite (R1) even when shape-correct.
 * Uses applyHookOutput for additionalContext extraction, then forces visible = original.
 */
export function applySilentDrop(tool: string, original: unknown, hook: HookResponse | null | undefined): AppliedHook {
  const applied = applyHookOutput(tool, original, hook);
  const rewrite = hook?.hookSpecificOutput?.updatedToolOutput;
  if (rewrite === undefined) {
    return { visible: original, additionalContext: applied.additionalContext, droppedRewrite: applied.droppedRewrite };
  }
  return { visible: original, additionalContext: applied.additionalContext, droppedRewrite: true };
}

export function isPreDeny(out: Record<string, unknown> | null | undefined): boolean {
  const inner = out?.hookSpecificOutput as { permissionDecision?: string } | undefined;
  return inner?.permissionDecision === "deny";
}

function countLedger(home: string): { transparent: number; steeredSkip: number; hostDrop: number } {
  const path = join(home, "ledger.jsonl");
  if (!existsSync(path)) return { transparent: 0, steeredSkip: 0, hostDrop: 0 };
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return {
    transparent: lines.filter((l) => l.includes('"class":"transparent"')).length,
    steeredSkip: lines.filter((l) => l.includes('"class":"steered-skip"')).length,
    hostDrop: lines.filter((l) => l.includes('"class":"host-drop"')).length,
  };
}

let fetchDepth = 0;
let prevFetch: typeof fetch | undefined;

export function installPlayMock(): () => void {
  if (fetchDepth++ === 0) {
    prevFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        if (String(url).includes("/v1/play")) {
          return new Response(JSON.stringify({ ok: true, table: "reviews=6 | status=pending" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
      { preconnect: prevFetch?.preconnect },
    );
  }
  return () => {
    fetchDepth = Math.max(0, fetchDepth - 1);
    if (fetchDepth === 0 && prevFetch) globalThis.fetch = prevFetch;
  };
}

export function isolateHome(): { home: string; restore: () => void } {
  const prevHome = process.env.EDEN_HOME;
  const prevKey = process.env.EDEN_API_KEY;
  const prevSteer = process.env.EDEN_STEER_HOOKS;
  const prevT = process.env.EDEN_TRANSPARENT;
  const prevW = process.env.EDEN_TRANSPARENT_WRITES;
  const home = join(import.meta.dir, `../../.tmp-eden-silent-drop-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(join(home, "runs"), { recursive: true });
  process.env.EDEN_HOME = home;
  process.env.EDEN_API_KEY = "eden_dev";
  process.env.EDEN_TRANSPARENT = "1";
  delete process.env.EDEN_STEER_HOOKS;
  delete process.env.EDEN_TRANSPARENT_WRITES;
  return {
    home,
    restore: () => {
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      if (prevKey === undefined) delete process.env.EDEN_API_KEY;
      else process.env.EDEN_API_KEY = prevKey;
      if (prevSteer === undefined) delete process.env.EDEN_STEER_HOOKS;
      else process.env.EDEN_STEER_HOOKS = prevSteer;
      if (prevT === undefined) delete process.env.EDEN_TRANSPARENT;
      else process.env.EDEN_TRANSPARENT = prevT;
      if (prevW === undefined) delete process.env.EDEN_TRANSPARENT_WRITES;
      else process.env.EDEN_TRANSPARENT_WRITES = prevW;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function prepareHome(home: string, liveTools: LiveTool[]): void {
  mkdirSync(join(home, "runs"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8787" }));
  writeFileSync(join(home, "live-tools.json"), JSON.stringify(liveTools));
}

function remainderOf(seq: string[] | undefined): Set<string> {
  return new Set((seq ?? []).slice(1));
}

/**
 * One oblivious stretch through the silent-drop host.
 *
 * Eden: PreToolUse → deny? charge turn, skip execute/island. Else execute,
 * PostToolUse, applySilentDrop (visible = original, additionalContext kept).
 * Raw: no hooks; every tool runs; turns + islands billed.
 * Turns are charged on deny — the agent decided.
 */
export async function runObliviousStretch(opts: StretchOpts): Promise<StretchResult> {
  const owned = !opts.home;
  const iso = owned ? isolateHome() : null;
  const home = opts.home ?? iso!.home;
  const liveTools = opts.liveTools ?? [];
  const islandTools = new Set(opts.islandTools ?? [ISLAND_TOOL]);
  const forceDrop = opts.forceDrop ?? true;
  const thinkMs = opts.thinkMs ?? THINK_MS;
  const toolSleepMs = opts.toolSleepMs ?? TOOL_SLEEP_MS;
  const session = opts.session ?? `sd-${crypto.randomUUID().slice(0, 8)}`;
  const remainder = remainderOf(liveTools.find((t) => (t.sequence ?? []).length >= 2)?.sequence);

  if (owned || !existsSync(join(home, "config.json"))) prepareHome(home, liveTools);
  else if (liveTools.length) writeFileSync(join(home, "live-tools.json"), JSON.stringify(liveTools));
  process.env.EDEN_HOME = home;

  const uninstall = opts.arm === "eden" ? installPlayMock() : () => undefined;
  const t0 = performance.now();
  const steps: StretchResult["steps"] = [];
  let turns = 0;
  let cents = 0;
  let executions = 0;
  let remainderExecutions = 0;
  let islands = 0;
  let denies = 0;
  let droppedRewrites = 0;
  let visibleSentinelHits = 0;
  let additionalContextHits = 0;
  let ledger = { transparent: 0, steeredSkip: 0, hostDrop: 0 };
  const violations: string[] = [];

  try {
    for (const call of opts.calls) {
      if (thinkMs > 0) await Bun.sleep(thinkMs);
      turns++;
      cents += TURN_CENTS;

      if (opts.arm === "raw") {
        if (toolSleepMs > 0) await Bun.sleep(toolSleepMs);
        executions++;
        if (remainder.has(call.tool)) remainderExecutions++;
        if (islandTools.has(call.tool)) {
          islands++;
          cents += ISLAND_CENTS;
        }
        steps.push({
          tool: call.tool,
          denied: false,
          executed: true,
          visibleText: nativeTextOf(call.tool, nativeResult(call.tool, call.args)),
          additionalContext: "",
        });
        continue;
      }

      const pre = (await respondToHook({
        hook_event_name: "PreToolUse",
        session_id: session,
        tool_name: call.tool,
        tool_input: call.args,
      } as HookIn)) as Record<string, unknown>;

      if (isPreDeny(pre)) {
        denies++;
        steps.push({
          tool: call.tool,
          denied: true,
          executed: false,
          visibleText: "",
          additionalContext: "",
        });
        continue;
      }

      if (toolSleepMs > 0) await Bun.sleep(toolSleepMs);
      const original = nativeResult(call.tool, call.args);
      executions++;
      if (remainder.has(call.tool)) remainderExecutions++;
      if (islandTools.has(call.tool)) {
        islands++;
        cents += ISLAND_CENTS;
      }

      const post = (await respondToHook({
        hook_event_name: "PostToolUse",
        session_id: session,
        tool_name: call.tool,
        tool_input: call.args,
        tool_response: original,
      } as HookIn)) as HookResponse;

      const applied = forceDrop
        ? applySilentDrop(call.tool, original, post)
        : applyHookOutput(call.tool, original, post);
      if (applied.droppedRewrite) {
        droppedRewrites++;
        const hit = liveTools.find((t) => (t.sequence ?? [])[0] === call.tool) ?? liveTools[0];
        appendLedgerRow({
          session,
          class: "host-drop",
          program: hit?.name,
          programId: hit?.id,
          tool: call.tool,
        });
      }
      const vis = nativeTextOf(call.tool, applied.visible);
      if (vis.includes(SENTINEL_MARK)) visibleSentinelHits++;
      if (applied.additionalContext.includes(SENTINEL_MARK)) additionalContextHits++;
      const combined = modelVisibleText(call.tool, applied);
      if (forceDrop && vis.includes(SENTINEL_MARK)) {
        violations.push(`${call.tool}: silent-drop failed — sentinel still in visible original`);
      }
      if (
        !combined.includes(SENTINEL_MARK) &&
        post?.hookSpecificOutput?.updatedToolOutput !== undefined &&
        !applied.additionalContext
      ) {
        violations.push(`${call.tool}: additionalContext missing after drop`);
      }
      steps.push({
        tool: call.tool,
        denied: false,
        executed: true,
        applied,
        visibleText: vis,
        additionalContext: applied.additionalContext,
      });
    }

    if (opts.arm === "eden" && liveTools.some((t) => t.name === COMPILABLE_PROGRAM.name) && remainderExecutions > 0) {
      violations.push(`remainder tools executed ${remainderExecutions}x under silent-drop (S1b deny must hold)`);
    }
    ledger = countLedger(home);
  } finally {
    uninstall();
    if (owned) iso!.restore();
  }

  const wall = performance.now() - t0;
  const stats: SessionStats = {
    turns,
    cents,
    wall_ms: wall,
    rawExecutions: executions,
    islands,
    stretches: 1,
    completed: 1,
    violations,
  };

  return {
    stats,
    suppressions: denies,
    denies,
    executions,
    remainderExecutions,
    islands,
    droppedRewrites,
    visibleSentinelHits,
    additionalContextHits,
    ledgerTransparent: ledger.transparent,
    ledgerSteeredSkip: ledger.steeredSkip,
    ledgerHostDrop: ledger.hostDrop,
    steps,
    home,
  };
}

/** Alias: ledger is always counted before a temp home is deleted. */
export async function runCountedStretch(opts: StretchOpts): Promise<StretchResult> {
  return runObliviousStretch(opts);
}

export async function n9Scenario(repeats: number): Promise<ScenarioOut> {
  const calls = compilableCalls("101");
  const live = [COMPILABLE_PROGRAM];
  return await runScenario({
    name: "silent-drop",
    question: "host always drops updatedToolOutput (R1); S1b remainder deny still holds",
    expect: N9_EXPECT,
    tasks: ["s"],
    repeats,
    run: async (arm): Promise<ArmRun> => {
      const r = await runCountedStretch({ arm, calls, liveTools: live, forceDrop: true });
      const notes =
        arm === "eden"
          ? [
              `suppressions=${r.suppressions}`,
              `executions=${r.executions}`,
              `islands=${r.islands}`,
              `droppedRewrites=${r.droppedRewrites}`,
              `ledger transparent=${r.ledgerTransparent} steered-skip=${r.ledgerSteeredSkip} ` +
                `host-drop=${r.ledgerHostDrop}`,
            ]
          : [`raw executions=${r.executions} islands=${r.islands}`];
      if (arm === "eden" && r.suppressions < 1) {
        r.stats.violations.push("eden arm recorded zero suppressions");
      }
      return { stats: r.stats, notes };
    },
  });
}

function relPct(ctrl: number, trt: number): number {
  if (!ctrl) return 0;
  return ((trt - ctrl) / ctrl) * 100;
}

export function writeSilentDropMd(
  out: ScenarioOut,
  unique?: { rawCents: number; edenCents: number; denies: number },
  path = join(import.meta.dir, "SILENT-DROP.md"),
): void {
  const cents = out.decisions.cents;
  const turns = out.decisions.turns;
  const wall = out.decisions.wall_ms;
  const ctrl = out.controlMeans.cents ?? 0;
  const trt = out.treatmentMeans.cents ?? 0;
  const d = relPct(ctrl, trt);
  const breakEven = trt <= ctrl * 1.01;
  const suppressNote = out.notes.find((n) => n.startsWith("suppressions=")) ?? "";
  const lines = [
    "# Silent-drop host (Wave 5.4) + oblivious cents (Wave 5.2)",
    "",
    `Measured ${new Date().toISOString()} via \`bun run benchmarks/campaign/silent-drop.ts --fast\`.`,
    "Headless host **always drops** \`updatedToolOutput\` (R1); \`additionalContext\` kept; S1b " +
      "PreToolUse deny still fires.",
    "",
    "## Oblivious compilable stretch (S1b on)",
    "",
    "Agent issues the full 3-call sequence (Read → Grep → Bash). Bash is the island-cost analogue " +
      "(ISLAND_CENTS=0.3 if executed).",
    "Eden: first call executes + transparent serve; remainder denied (no island). Raw: all three " +
      "execute, island billed.",
    "",
    "| Meter | Raw (ctrl) | Eden (trt) | Δ | Verdict |",
    "|---|---|---|---|---|",
    `| cents | ${ctrl.toFixed(4)} | ${trt.toFixed(4)} | ${d.toFixed(2)}% | ${cents?.verdict ?? "—"} |`,
    `| turns | ${(out.controlMeans.turns ?? 0).toFixed(2)} ` +
      `| ${(out.treatmentMeans.turns ?? 0).toFixed(2)} ` +
      `| ${relPct(out.controlMeans.turns ?? 0, out.treatmentMeans.turns ?? 0).toFixed(2)}% ` +
      `| ${turns?.verdict ?? "—"} |`,
    `| wall_ms | ${(out.controlMeans.wall_ms ?? 0).toFixed(2)} ` +
      `| ${(out.treatmentMeans.wall_ms ?? 0).toFixed(2)} ` +
      `| ${relPct(out.controlMeans.wall_ms ?? 0, out.treatmentMeans.wall_ms ?? 0).toFixed(2)}% ` +
      `| ${wall?.verdict ?? "—"} |`,
    "",
    `Break-even: Eden cents ≤ raw (or INDISTINGUISHABLE within ±1% **and** suppressions > 0). ` +
      `**${breakEven ? "PASS" : "FAIL"}** (Δcents ${d.toFixed(2)}% vs raw; ` +
      `${suppressNote || "suppressions counted in notes"}).`,
    "",
    `Pre-registered expect: ${N9_EXPECT}`,
    "",
    "## Unique-sequence red-team (no live program)",
    "",
  ];
  if (unique) {
    lines.push(
      `| arm | cents | denies |`,
      `|---|---|---|`,
      `| raw | ${unique.rawCents.toFixed(4)} | 0 |`,
      `| eden | ${unique.edenCents.toFixed(4)} | ${unique.denies} |`,
      "",
      unique.rawCents === unique.edenCents && unique.denies === 0
        ? "Exact cents parity, zero denies."
        : `GAP: raw=${unique.rawCents} eden=${unique.edenCents} denies=${unique.denies}`,
    );
  } else {
    lines.push("Not run in this invocation.");
  }
  lines.push(
    "",
    "## Materiality",
    "",
    "Negative-control band unchanged: ±1% (`summarize(..., { lossTolerancePct: 1 })`).",
    "",
  );
  writeFileSync(path, lines.join("\n"));
}

async function main(): Promise<void> {
  const FAST = process.argv.includes("--fast");
  // Cell is cheap (hook I/O, no wrap compile). n≥6 is required for a cents
  // WIN/LOSS; --fast still uses 8 so 5.2 can quote a real verdict.
  const reps = 8;
  console.log(`Silent-drop host — fast=${FAST} reps=${reps}`);
  console.log(`  expect: ${N9_EXPECT}`);

  const n9 = await n9Scenario(reps);

  console.log("\n[red-team] unique sequence — no live program, exact parity, zero denies");
  const uniqRaw = await runCountedStretch({ arm: "raw", calls: uniqueCalls(), liveTools: [] });
  const uniqEden = await runCountedStretch({ arm: "eden", calls: uniqueCalls(), liveTools: [], forceDrop: true });
  const uniqOk =
    uniqRaw.stats.cents === uniqEden.stats.cents &&
    uniqEden.denies === 0 &&
    uniqRaw.stats.turns === uniqEden.stats.turns;
  console.log(
    `  raw cents=${uniqRaw.stats.cents} eden cents=${uniqEden.stats.cents} denies=${uniqEden.denies} ` +
      `${uniqOk ? "OK" : "FAIL"}`,
  );
  if (!uniqOk) n9.ok = false;

  writeSilentDropMd(n9, {
    rawCents: uniqRaw.stats.cents,
    edenCents: uniqEden.stats.cents,
    denies: uniqEden.denies,
  });
  console.log("  wrote benchmarks/campaign/SILENT-DROP.md");

  summarize([n9], { lossTolerancePct: 1 });
  if (!uniqOk) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
