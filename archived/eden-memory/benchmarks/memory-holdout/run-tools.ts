/**
 * M2.4 AMA-shaped tool-trace holdout runner.
 *
 *   bun benchmarks/memory-holdout/run-tools.ts
 *
 * Product path only: respondToHook (live CLI hook; PostToolUse forwards to
 * memoryHookResponse) + openMemory. k = product default (EDEN_MEMORY_CAP unset → 6).
 * No BrainMemory. No ranker tune.
 *
 * M6 re-runs this file and pastes the table into tools.md / TOOLS-RESULTS.md.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { respondToHook } from "../../packages/cli/src/hook.ts";
import { memoryHookResponse } from "../../packages/cli/src/memory-hook.ts";
import { openMemory } from "../../src/index.ts";

export const HOLD_DIR = import.meta.dir;
export const FIXTURE_PATH = join(HOLD_DIR, "tools-fixture.json");
export const RESULTS_PATH = join(HOLD_DIR, "TOOLS-RESULTS.md");

export const REQUIRED_CASE_IDS = ["test-exit", "git-sha", "flake-log"] as const;
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

export type ToolCase = {
  id: string;
  title: string;
  ama_type?: string;
  ama_ability?: string;
  source?: string;
  session_id?: string;
  observe: HookEvent[];
  cue: HookEvent;
  gold_needles: string[];
};

export type ToolFixture = {
  id: string;
  schema: number;
  part?: string;
  api_under_test: string;
  product: string[];
  k: string;
  k_default?: number;
  expect: string;
  bans?: string[];
  cases: ToolCase[];
};

export type CaseRow = {
  id: string;
  title: string;
  verdict: "PASS" | "FAIL";
  post_tool_stored: boolean;
  jsonl_n_after_observe: number;
  jsonl_n: number;
  stored_hits: string[];
  inject_hits: string[];
  inject_miss: string[];
  additional_context: string;
};

export type HoldoutRun = {
  date: string;
  bun: string;
  api_under_test: string;
  k: string;
  pre_registered_expect: string;
  overall: "PASS" | "FAIL";
  post_tool_stored: boolean;
  rows: CaseRow[];
};

function asRec(v: unknown): Rec {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {};
}

export function additionalContextOf(out: Rec | null | undefined): string {
  if (!out) return "";
  const hook = asRec(out.hookSpecificOutput);
  return [out.additional_context, out.additionalContext, hook.additionalContext, hook.additional_context]
    .filter((x) => typeof x === "string" && x)
    .join("\n");
}

export function hitsIn(text: string, needles: string[]): { hit: string[]; miss: string[] } {
  const hay = text.toLowerCase();
  const hit: string[] = [];
  const miss: string[] = [];
  for (const n of needles) (hay.includes(n.toLowerCase()) ? hit : miss).push(n);
  return { hit, miss };
}

export function loadFixture(path = FIXTURE_PATH): ToolFixture {
  return JSON.parse(readFileSync(path, "utf8")) as ToolFixture;
}

export function fixtureIssues(fix: ToolFixture): string[] {
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
    if (!Array.isArray(c.gold_needles) || !c.gold_needles.length) issues.push(`${c.id}: gold_needles empty`);
    if (!c.cue || c.cue.hook_event_name !== "UserPromptSubmit") issues.push(`${c.id}: cue must be UserPromptSubmit`);
    if (!Array.isArray(c.observe) || !c.observe.length) issues.push(`${c.id}: observe empty`);
    if (!c.observe.some((e) => e.hook_event_name === "PostToolUse"))
      issues.push(`${c.id}: observe must include PostToolUse`);
  }
  const blob = JSON.stringify(fix);
  if (/\bfrom\s+['"][^'"]*brain-memory|\bnew\s+BrainMemory\b|\.retrieve\s*\(/.test(blob)) {
    issues.push("fixture must not call BrainMemory / retrieve");
  }
  if (/"k"\s*:\s*40\b/.test(blob) || /"k_default"\s*:\s*40/.test(blob)) issues.push("fixture must not set k=40");
  if (/\brec5\b/.test(blob) && !/not bakeoff rec5/i.test(blob)) issues.push("fixture must not use bakeoff rec5 cases");
  return issues;
}

export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  const keys = [...Object.keys(vars), "EDEN_MEMORY_CAP"];
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.EDEN_MEMORY_CAP;
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** JSONL after M5 lives at `<dir>/<session>/memories.jsonl` when session_id is set. */
export function jsonlBody(memDir: string, session?: string): string {
  const paths: string[] = [];
  if (session) paths.push(join(memDir, session, "memories.jsonl"));
  paths.push(join(memDir, "memories.jsonl"));
  try {
    for (const ent of readdirSync(memDir, { withFileTypes: true })) {
      if (ent.isDirectory()) paths.push(join(memDir, ent.name, "memories.jsonl"));
    }
  } catch {}
  const seen = new Set<string>();
  const chunks: string[] = [];
  for (const p of paths) {
    if (seen.has(p) || !existsSync(p)) continue;
    seen.add(p);
    chunks.push(readFileSync(p, "utf8"));
  }
  return chunks.join("\n");
}

export async function runCase(c: ToolCase): Promise<CaseRow> {
  const home = join(tmpdir(), `eden-m24-tools-${c.id}-${Math.random().toString(36).slice(2)}`);
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
      const injected = hitsIn(ctx, c.gold_needles);
      rmSync(home, { recursive: true, force: true });
      return {
        id: c.id,
        title: c.title,
        verdict: injected.miss.length ? "FAIL" : "PASS",
        post_tool_stored: storedHits.length === c.gold_needles.length,
        jsonl_n_after_observe: afterObserve.split("\n").filter(Boolean).length,
        jsonl_n: jsonl.split("\n").filter(Boolean).length,
        stored_hits: storedHits,
        inject_hits: injected.hit,
        inject_miss: injected.miss,
        additional_context: ctx,
      };
    },
  );
}

export async function runHoldout(fix = loadFixture()): Promise<HoldoutRun> {
  const rows: CaseRow[] = [];
  for (const c of fix.cases) rows.push(await runCase(c));
  return {
    date: new Date().toISOString().slice(0, 10),
    bun: Bun.version,
    api_under_test: fix.api_under_test,
    k: `${fix.k} (product EDEN_MEMORY_CAP||${fix.k_default ?? 6})`,
    pre_registered_expect: fix.expect,
    overall: rows.every((r) => r.verdict === "PASS") ? "PASS" : "FAIL",
    post_tool_stored: rows.every((r) => r.post_tool_stored),
    rows,
  };
}

export function formatResults(run: HoldoutRun): string {
  const lines = [
    "# M2.4 tool-trace holdout RESULTS",
    "",
    `**Date:** ${run.date}`,
    `**Bun:** ${run.bun}`,
    `**API under test:** ${run.api_under_test} (\`respondToHook\` / \`memoryHookResponse\` + \`openMemory\`)`,
    `**k:** ${run.k}`,
    `**Pre-registered expect:** ${run.pre_registered_expect}`,
    `**Overall:** ${run.overall}`,
    `**PostToolUse stored (all gold needles in JSONL after observe):** ${run.post_tool_stored ? "yes" : "no"}`,
    "",
    "No BrainMemory column. No cortex-off column. Not LoCoMo 92. Not bakeoff rec5. Ranker not tuned.",
    "",
    "| case | verdict | stored after observe | JSONL n after observe | inject hits | inject miss |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of run.rows) {
    const hits = r.inject_hits.length ? r.inject_hits.join("; ") : "—";
    const miss = r.inject_miss.length ? r.inject_miss.join("; ") : "—";
    lines.push(
      `| ${r.id} | ${r.verdict} | ${r.post_tool_stored ? "yes" : "no"} | ${r.jsonl_n_after_observe} | ` +
        `${hits} | ${miss} |`,
    );
  }
  lines.push("");
  if (!run.post_tool_stored) {
    lines.push(
      "PostToolUse did not store gold needles. If `memoryHookResponse` still returns null *without* " +
        "writing JSONL, the live hook is dropping tools (M2.2 not landed). FAIL is honest. Do not retune the " +
        "ranker.",
    );
  } else if (run.overall === "FAIL") {
    lines.push(
      "PostToolUse stored the trace, but inject/additionalContext still missed gold needles. FAIL is " +
        "honest. Do not retune the ranker from this file.",
    );
  } else {
    lines.push(
      "True verdict on this tree: inject/additionalContext contained every gold needle. `respondToHook` " +
        "PostToolUse forwards to `memoryHookResponse`, which observes tool name + result (returns null; " +
        "inject is the later UserPromptSubmit). Pre-registered expect was FAIL until tools were observed; " +
        "M2.2 had landed, so this is not a forced FAIL.",
    );
  }
  lines.push("");
  lines.push("## How M6 re-runs");
  lines.push("");
  lines.push("```bash");
  lines.push("bun benchmarks/memory-holdout/run-tools.ts");
  lines.push("```");
  lines.push("");
  lines.push(
    "Paste the table into this file and into `tools.md` § RESULTS. Score additionalContext only. Do not " +
      "add a BrainMemory column. Do not set k=40.",
  );
  lines.push("");
  return lines.join("\n");
}

export function writeResults(run: HoldoutRun, path = RESULTS_PATH): string {
  const md = formatResults(run);
  writeFileSync(path, md);
  return md;
}

if (import.meta.main) {
  const issues = fixtureIssues(loadFixture());
  if (issues.length) {
    console.error("fixture schema:\n" + issues.map((i) => `- ${i}`).join("\n"));
    process.exit(1);
  }
  const run = await runHoldout();
  const md = writeResults(run);
  process.stdout.write(md);
  const table = run.rows.map((r) => `${r.id}\t${r.verdict}`).join("\n");
  process.stdout.write(`\n${table}\n overall=${run.overall}\n`);
}
