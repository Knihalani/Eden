/**
 * M6.1 Gate 1 coding-holdout runner (hook inject).
 *
 *   bun benchmarks/memory-holdout/run-holdout.ts
 *
 * Product path only: respondToHook (live CLI hook) + memoryHookResponse + openMemory.
 * k = product default (EDEN_MEMORY_CAP unset → 6). No BrainMemory. No ranker tune.
 *
 * Also re-runs M2.4 via runHoldout() and writes TOOLS-RESULTS.md + RESULTS.md.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respondToHook } from "../../packages/cli/src/hook.ts";
import { memoryHookResponse } from "../../packages/cli/src/memory-hook.ts";
import { MEMORY_MARK, openMemory } from "../../src/index.ts";
import {
  additionalContextOf,
  formatResults,
  hitsIn,
  jsonlBody,
  loadFixture as loadToolsFixture,
  runHoldout as runToolsHoldout,
  withEnv,
  writeResults as writeToolsResults,
  type CaseRow as ToolCaseRow,
  type HoldoutRun as ToolsHoldoutRun,
} from "./run-tools.ts";

export const HOLD_DIR = import.meta.dir;
export const FIXTURE_PATH = join(HOLD_DIR, "holdout-fixture.json");
export const RESULTS_PATH = join(HOLD_DIR, "RESULTS.md");
export const PROTOCOL_PATH = join(HOLD_DIR, "holdout.md");

export const REQUIRED_CASE_IDS = ["flake", "adr", "file-rule", "version", "junk"] as const;
export const PRODUCT_APIS = { respondToHook, memoryHookResponse, openMemory } as const;

type Rec = Record<string, unknown>;

export type HookEvent = {
  hook_event_name: string;
  session_id?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Rec;
  tool_response?: unknown;
  tool_output?: unknown;
  is_error?: boolean;
  cwd?: string;
};

export type HoldoutCase = {
  id: string;
  title: string;
  gate1?: string;
  source?: string;
  expect?: string;
  session_id?: string;
  observe: HookEvent[];
  cue: HookEvent;
  gold_needles: string[];
  stale_needles?: string[];
  keep_needles?: string[];
  junk_needles?: string[];
};

export type HoldoutFixture = {
  id: string;
  schema: number;
  part?: string;
  api_under_test: string;
  product: string[];
  k: string;
  k_default?: number;
  expect: string;
  bans?: string[];
  cases: HoldoutCase[];
};

export type Gate1 = "WIN" | "LOSS" | "FAIL";

export type HoldoutRow = {
  id: string;
  title: string;
  verdict: "PASS" | "FAIL";
  gate1: Gate1;
  stored_after_observe: boolean;
  jsonl_n_after_observe: number;
  jsonl_n: number;
  stored_hits: string[];
  inject_hits: string[];
  inject_miss: string[];
  additional_context: string;
  junk_leaked: boolean;
  stale_in_inject: boolean;
  keep_in_inject: boolean;
  notes: string;
};

export type CombinedRun = {
  date: string;
  bun: string;
  api_under_test: string;
  k: string;
  pre_registered_expect: string;
  overall: "PASS" | "FAIL";
  gate1_counts: { WIN: number; LOSS: number; FAIL: number };
  rows: HoldoutRow[];
  tools: ToolsHoldoutRun;
};

function asRec(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}

function injectEmpty(ctx: string): boolean {
  const t = ctx
    .replaceAll(MEMORY_MARK, "")
    .replace(/^[-•]\s*/gm, "")
    .trim();
  return !t;
}

export function loadHoldoutFixture(path = FIXTURE_PATH): HoldoutFixture {
  return JSON.parse(readFileSync(path, "utf8")) as HoldoutFixture;
}

export function holdoutFixtureIssues(fix: HoldoutFixture): string[] {
  const issues: string[] = [];
  if (fix.schema !== 1) issues.push(`schema ${fix.schema} !== 1`);
  if (fix.api_under_test !== "hook-inject") issues.push(`api_under_test ${fix.api_under_test} !== hook-inject`);
  if (fix.k !== "default") issues.push(`k ${fix.k} !== default`);
  if (fix.k_default != null && fix.k_default === 40) issues.push("k_default must not be 40");
  if (
    !Array.isArray(fix.product) ||
    !fix.product.includes("respondToHook") ||
    !fix.product.includes("memoryHookResponse") ||
    !fix.product.includes("openMemory")
  ) {
    issues.push("product must list respondToHook, memoryHookResponse, openMemory");
  }
  if (fix.expect !== "PASS" && fix.expect !== "FAIL") issues.push(`expect ${fix.expect} not PASS|FAIL`);
  const ids = new Set(fix.cases?.map((c) => c.id));
  for (const id of REQUIRED_CASE_IDS) if (!ids.has(id)) issues.push(`missing case ${id}`);
  for (const c of fix.cases ?? []) {
    if (!c.id) issues.push("case missing id");
    if (c.expect && c.expect !== "PASS" && c.expect !== "FAIL")
      issues.push(`${c.id}: expect ${c.expect} not PASS|FAIL`);
    if (!Array.isArray(c.gold_needles) || !c.gold_needles.length) issues.push(`${c.id}: gold_needles empty`);
    if (!c.cue || c.cue.hook_event_name !== "UserPromptSubmit") issues.push(`${c.id}: cue must be UserPromptSubmit`);
    if (!Array.isArray(c.observe) || !c.observe.length) issues.push(`${c.id}: observe empty`);
    const okEv = c.observe.every(
      (e) => e.hook_event_name === "UserPromptSubmit" || e.hook_event_name === "PostToolUse",
    );
    if (!okEv) issues.push(`${c.id}: observe events must be UserPromptSubmit or PostToolUse`);
    const sid = c.session_id || c.cue.session_id;
    if (!sid) issues.push(`${c.id}: session_id required`);
    else {
      for (const e of [...c.observe, c.cue]) {
        if (e.session_id && e.session_id !== sid) issues.push(`${c.id}: session_id mismatch`);
      }
    }
  }
  const blob = JSON.stringify(fix);
  if (/\bfrom\s+['"][^'"]*brain-memory|\bnew\s+BrainMemory\b|\.retrieve\s*\(/.test(blob)) {
    issues.push("fixture must not call BrainMemory / retrieve");
  }
  if (/"k"\s*:\s*40\b/.test(blob) || /"k_default"\s*:\s*40/.test(blob)) issues.push("fixture must not set k=40");
  if (/\brec5\b/.test(blob) && !/not bakeoff rec5/i.test(blob)) issues.push("fixture must not use bakeoff rec5 cases");
  return issues;
}

function scoreRow(c: HoldoutCase, ctx: string, storedHits: string[], afterObserve: string, jsonl: string): HoldoutRow {
  const injected = hitsIn(ctx, c.gold_needles);
  const junkHit = c.junk_needles?.length ? hitsIn(ctx, c.junk_needles).hit : [];
  const staleHit = c.stale_needles?.length ? hitsIn(ctx, c.stale_needles).hit : [];
  const keepHit = c.keep_needles?.length ? hitsIn(ctx, c.keep_needles).hit : [];
  const empty = injectEmpty(ctx);
  const goldOk = injected.miss.length === 0;
  const onlyJunk = Boolean(c.junk_needles?.length) && !goldOk && junkHit.length > 0;
  const sixteenWins = Boolean(c.stale_needles?.length) && staleHit.length > 0 && !goldOk;

  let verdict: "PASS" | "FAIL" = goldOk ? "PASS" : "FAIL";
  if (c.junk_needles?.length && (empty || onlyJunk)) verdict = "FAIL";
  if (sixteenWins) verdict = "FAIL";

  let gate1: Gate1;
  if (verdict === "PASS") gate1 = "WIN";
  else if (empty || onlyJunk || sixteenWins) gate1 = "FAIL";
  else gate1 = "LOSS";

  const notes: string[] = [];
  if (c.junk_needles?.length) notes.push(junkHit.length ? `junk leaked: ${junkHit.join("; ")}` : "junk not in inject");
  if (c.stale_needles?.length) {
    if (sixteenWins) notes.push("Node 16 still wins (18 absent)");
    else if (staleHit.length) notes.push(`stale still in packet: ${staleHit.join("; ")}`);
    else notes.push("stale Node 16 absent from inject");
  }
  if (c.keep_needles?.length)
    notes.push(keepHit.length ? `CI kept (${keepHit.join("; ")})` : "CI not in inject (not required)");
  if (empty) notes.push("inject empty");

  return {
    id: c.id,
    title: c.title,
    verdict,
    gate1,
    stored_after_observe: storedHits.length === c.gold_needles.length,
    jsonl_n_after_observe: afterObserve.split("\n").filter(Boolean).length,
    jsonl_n: jsonl.split("\n").filter(Boolean).length,
    stored_hits: storedHits,
    inject_hits: injected.hit,
    inject_miss: injected.miss,
    additional_context: ctx,
    junk_leaked: junkHit.length > 0,
    stale_in_inject: staleHit.length > 0,
    keep_in_inject: keepHit.length > 0,
    notes: notes.join("; ") || "—",
  };
}

export async function runHoldoutCase(c: HoldoutCase): Promise<HoldoutRow> {
  const home = join(tmpdir(), `eden-m61-holdout-${c.id}-${Math.random().toString(36).slice(2)}`);
  const memDir = join(home, "memory");
  mkdirSync(memDir, { recursive: true });
  return withEnv(
    {
      EDEN_HOME: home,
      EDEN_MEMORY_DIR: memDir,
      EDEN_KNOW: "0",
    },
    async () => {
      for (const ev of c.observe) await respondToHook(ev);
      const session = c.session_id || c.cue.session_id;
      const afterObserve = jsonlBody(memDir, session);
      const storedAfter = hitsIn(afterObserve, c.gold_needles);
      const memAfter = openMemory({ dir: memDir, session });
      const fromObject = hitsIn(
        memAfter
          .memories()
          .map((m) => m.text)
          .join("\n"),
        c.gold_needles,
      );
      const storedHits = [...new Set([...storedAfter.hit, ...fromObject.hit])];
      const cueOut = await respondToHook(c.cue);
      const ctx = additionalContextOf(asRec(cueOut));
      const jsonl = jsonlBody(memDir, session);
      rmSync(home, { recursive: true, force: true });
      return scoreRow(c, ctx, storedHits, afterObserve, jsonl);
    },
  );
}

function toolGate1(r: ToolCaseRow): Gate1 {
  if (r.verdict === "PASS") return "WIN";
  if (!r.additional_context.trim()) return "FAIL";
  return "LOSS";
}

export async function runCodingHoldout(fix = loadHoldoutFixture()): Promise<CombinedRun> {
  const rows: HoldoutRow[] = [];
  for (const c of fix.cases) rows.push(await runHoldoutCase(c));
  const tools = await runToolsHoldout(loadToolsFixture());
  const gate1_counts = { WIN: 0, LOSS: 0, FAIL: 0 };
  for (const r of rows) gate1_counts[r.gate1]++;
  for (const r of tools.rows) gate1_counts[toolGate1(r)]++;
  const holdoutPass = rows.every((r) => r.verdict === "PASS");
  const overall: "PASS" | "FAIL" = holdoutPass && tools.overall === "PASS" ? "PASS" : "FAIL";
  return {
    date: new Date().toISOString().slice(0, 10),
    bun: Bun.version,
    api_under_test: fix.api_under_test,
    k: `${fix.k} (product EDEN_MEMORY_CAP||${fix.k_default ?? 6})`,
    pre_registered_expect: fix.expect,
    overall,
    gate1_counts,
    rows,
    tools,
  };
}

function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Headings owned by later waves. A re-run must not wipe them. */
const PRESERVED_SECTION = /^## (?:Multi-session|Silence|M33\.4|M34\.2|M48)\b/;

export function preservedHoldoutTail(existing: string): string {
  const lines = existing.replace(/^\uFEFF/, "").split("\n");
  const start = lines.findIndex((line) => PRESERVED_SECTION.test(line));
  if (start < 0) return "";
  return lines.slice(start).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

export function formatHoldoutResults(run: CombinedRun): string {
  const g = run.gate1_counts;
  const lines = [
    "# M6.1 Hook holdout RESULTS",
    "",
    `**Date:** ${run.date}`,
    `**Bun:** ${run.bun}`,
    `**API under test:** ${run.api_under_test} (\`respondToHook\` / \`memoryHookResponse\` + \`openMemory\`)`,
    `**k:** ${run.k}`,
    `**Pre-registered expect:** ${run.pre_registered_expect} (per-case FAIL in holdout-fixture.json; ` +
      `M2.4 tools-fixture expect FAIL)`,
    `**Overall:** ${run.overall}`,
    `**Gate 1:** WIN ${g.WIN} / LOSS ${g.LOSS} / FAIL ${g.FAIL}`,
    "**No-memory control:** `EDEN_MEMORY=0`. M35.2 (2026-09-22) off arm: `additionalContext` empty on " +
      "all 8 Gate 1 + AMA cases. Gate 1 WIN is on vs off (needles present only when memory is on). See " +
      "`SAVINGS.md`.",
    `**M48.1:** Live coding holdout re-run after M16–M47 (${run.date}). Same inject API. Ranker not retuned.`,
    "",
    "No BrainMemory column. No cortex-off column. Not LoCoMo 92. Not k=40. Not hay. Not bakeoff rec5. " +
      "Ranker not tuned. Dual-API forbidden. inject path only.",
    "",
    "Gate 1 acceptance: coding-holdout on inject path; commit surfaces test rule; ADR survives " +
      "paraphrase; Node 16→18 newest wins without deleting “CI”; tools persist.",
    "",
    "## Gate 1 coding-holdout (inject)",
    "",
    "| case | verdict | gate1 | inject hits | inject miss | notes |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of run.rows) {
    const hits = r.inject_hits.length ? r.inject_hits.join("; ") : "—";
    const miss = r.inject_miss.length ? r.inject_miss.join("; ") : "—";
    lines.push(`| ${r.id} | ${r.verdict} | ${r.gate1} | ${mdCell(hits)} | ${mdCell(miss)} | ${mdCell(r.notes)} |`);
  }
  lines.push("");
  lines.push("## M2.4 tool-trace (re-run)");
  lines.push("");
  lines.push(
    `**Tools overall:** ${run.tools.overall}. PostToolUse stored: ${run.tools.post_tool_stored ? "yes" : "no"}.`,
  );
  lines.push("");
  lines.push("| case | verdict | gate1 | stored after observe | JSONL n after observe | inject hits | inject miss |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of run.tools.rows) {
    const hits = r.inject_hits.length ? r.inject_hits.join("; ") : "—";
    const miss = r.inject_miss.length ? r.inject_miss.join("; ") : "—";
    lines.push(
      `| ${r.id} | ${r.verdict} | ${toolGate1(r)} | ${r.post_tool_stored ? "yes" : "no"} | ` +
        `${r.jsonl_n_after_observe} | ${mdCell(hits)} | ${mdCell(miss)} |`,
    );
  }
  lines.push("");
  if (run.overall === "PASS") {
    lines.push(
      "True verdict on this tree: every Gate 1 gold needle and every M2.4 gold needle was in " +
        "inject/additionalContext. Pre-registered expect was FAIL; this is not a forced FAIL. Ranker not " +
        "tuned.",
    );
  } else {
    const losses = [
      ...run.rows.filter((r) => r.verdict === "FAIL").map((r) => r.id),
      ...run.tools.rows.filter((r) => r.verdict === "FAIL").map((r) => r.id),
    ];
    lines.push(
      `Honest overall FAIL. Missed: ${losses.join(", ") || "—"}. Losses feed M10, not a silent ranker ` +
        `retune from this file.`,
    );
  }
  lines.push("");
  lines.push("## How to re-run");
  lines.push("");
  lines.push("```bash");
  lines.push("bun benchmarks/memory-holdout/run-holdout.ts");
  lines.push("bun benchmarks/memory-holdout/run-tools.ts");
  lines.push("```");
  lines.push("");
  lines.push(
    "Paste this table into this file. Score additionalContext only. Do not add a BrainMemory column. Do " +
      "not set k=40. Do not retune `src/index.ts` ranking.",
  );
  lines.push("");
  return lines.join("\n");
}

export function writeHoldoutResults(run: CombinedRun, path = RESULTS_PATH): string {
  const body = formatHoldoutResults(run).replace(/\s+$/, "");
  const tail = existsSync(path) ? preservedHoldoutTail(readFileSync(path, "utf8")) : "";
  const md = tail ? `${body}\n\n${tail}\n` : `${body}\n`;
  writeFileSync(path, md);
  return md;
}

function patchToolsMd(toolsMdPath: string, toolsRun: ToolsHoldoutRun): void {
  if (!existsSync(toolsMdPath)) return;
  const src = readFileSync(toolsMdPath, "utf8");
  const marker = "## RESULTS";
  const i = src.indexOf(marker);
  if (i < 0) return;
  const toolsTable = formatResults(toolsRun);
  const tableStart = toolsTable.indexOf("| case |");
  const how = toolsTable.indexOf("## How M6 re-runs");
  const paste = tableStart >= 0 ? toolsTable.slice(tableStart, how >= 0 ? how : undefined).trim() : "";
  const replacement = [
    "## RESULTS",
    "",
    `Copied from \`TOOLS-RESULTS.md\` after \`bun benchmarks/memory-holdout/run-tools.ts\` on ` +
      `${toolsRun.date} (bun ${toolsRun.bun}). k = default. Pre-registered expect was FAIL; M2.2 had ` +
      `landed.`,
    "",
    paste,
    "",
    toolsRun.overall === "PASS"
      ? "**Overall: PASS.** Inject/additionalContext contained every gold needle. Ranker not tuned."
      : "**Overall: FAIL.** Honest. Ranker not tuned.",
    "",
  ].join("\n");
  writeFileSync(toolsMdPath, src.slice(0, i) + replacement);
}

if (import.meta.main) {
  const issues = holdoutFixtureIssues(loadHoldoutFixture());
  if (issues.length) {
    console.error("fixture schema:\n" + issues.map((i) => `- ${i}`).join("\n"));
    process.exit(1);
  }
  const run = await runCodingHoldout();
  writeToolsResults(run.tools);
  patchToolsMd(join(HOLD_DIR, "tools.md"), run.tools);
  const md = writeHoldoutResults(run);
  process.stdout.write(md);
  const table = [
    ...run.rows.map((r) => `${r.id}\t${r.verdict}\t${r.gate1}`),
    ...run.tools.rows.map((r) => `${r.id}\t${r.verdict}\t${toolGate1(r)}`),
  ].join("\n");
  process.stdout.write(
    `\n${table}\n overall=${run.overall} gate1=WIN ${run.gate1_counts.WIN} / LOSS ` +
      `${run.gate1_counts.LOSS} / FAIL ${run.gate1_counts.FAIL}\n`,
  );
}
