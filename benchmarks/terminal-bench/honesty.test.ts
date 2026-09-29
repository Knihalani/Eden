/**
 * M32.4 Terminal-Bench honesty (protocol-style asserts).
 * Does not launch Harbor. No NVIDIA keys. Does not pin live Δ (M15 −20.0 pp
 * is frozen on M15-EVIDENCE.md so M32 can file a new number).
 *
 *   bun test benchmarks/terminal-bench/honesty.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MEMORY_MARK, openMemory } from "../../src/index.ts";
import { JOBS_DIR, jobName, pendingResultsReport, renderResults, shouldSkipHarborForHttp } from "./run.ts";

const HERE = import.meta.dir;
const RESULTS = join(HERE, "RESULTS.md");
const SUBSET = join(HERE, "subset.json");
const RUNNER = join(HERE, "run.ts");
const M15_EVIDENCE = join(HERE, "../memoryagentbench/M15-EVIDENCE.md");

const GLM_UNTAGGED = "eden-m153-off";
const GLM_MODEL = "z-ai/glm-5.3";
const GEMMA = "google/gemma-4-31b-it";

type SubsetFile = {
  public_board?: boolean;
  tasks?: unknown[];
  note?: string;
  k?: number;
  agent?: string;
};

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function extractBrace(src: string, openAt: number): string {
  let depth = 0;
  for (let i = openAt; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(openAt, i + 1);
    }
  }
  return src.slice(openAt);
}

function extractNamedFn(src: string, name: string): string {
  const re = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::[^{]*)?\\{`,
  );
  const m = src.match(re);
  if (!m || m.index == null) return "";
  return extractBrace(src, m.index + m[0].length - 1);
}

function tableRows(src: string): Array<{ header: boolean; cells: string[] }> {
  const lines = src.split("\n");
  const rows: Array<{ header: boolean; cells: string[] }> = [];
  let inTable = false;
  const sep = /^\s*\|?\s*:?-{2,}[-|:\s]*$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("|")) {
      inTable = false;
      continue;
    }
    if (sep.test(line)) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length && cells[0] === "") cells.shift();
    if (cells.length && cells[cells.length - 1] === "") cells.pop();
    if (!cells.length) continue;
    const nextIsSep = sep.test(lines[i + 1] ?? "");
    if (nextIsSep) {
      inTable = true;
      rows.push({ header: true, cells });
      continue;
    }
    if (inTable) rows.push({ header: false, cells });
  }
  return rows;
}

function cellCanon(cell: string): string {
  return cell.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

/** True when a markdown table scores BrainMemory / cortex-off as a product column. */
export function hasBannedProductColumn(src: string): boolean {
  const ban = /\b(?:not|no|never|ban|banned|forbid|forbidden|without|versus|vs\.?)\b/i;
  const brain = /^(?:eden\s+)?brainmemory(?:\.retrieve)?$|^cortex\s*:\s*false$|^cortex-off$|^cortex\s+false$/i;
  for (const row of tableRows(src)) {
    for (const raw of row.cells) {
      const c = cellCanon(raw);
      if (!c || ban.test(c)) continue;
      if (brain.test(c)) return true;
      if (row.header && /\bbrainmemory\b/i.test(c) && !/\b(?:bench|adapter|legacy)\b/i.test(c)) {
        return true;
      }
      if (row.header && /cortex-off|cortex\s*:\s*false/i.test(c)) return true;
    }
  }
  return false;
}

function nTasksCell(src: string): string | null {
  const m = src.match(/\|\s*n\s*\(\s*tasks\s*\)\s*\|\s*([^|\n]+)\|/i);
  return m ? m[1]!.replace(/[`*_]/g, "").trim() : null;
}

function publicBoardCell(src: string): string | null {
  const m = src.match(/\|\s*public board\s*\(\s*89 tasks\s*\)\s*\|\s*([^|\n]+)\|/i);
  return m ? m[1]!.trim() : null;
}

/**
 * Throws if RESULTS claims the public 89-task tbench.ai board, or n≠2.
 * Locked-subset / "not 89-task" denials are required.
 */
export function assertNotPublicBoard(
  src: string,
  subset: SubsetFile,
  label = "RESULTS",
): void {
  const errors: string[] = [];
  if (subset.public_board !== false) {
    errors.push(`${label}: subset.json public_board must be false`);
  }
  const nTasks = Array.isArray(subset.tasks) ? subset.tasks.length : NaN;
  if (nTasks !== 2) {
    errors.push(`${label}: subset.json n tasks is ${nTasks} not 2`);
  }
  const nCell = nTasksCell(src);
  if (nCell === "89") errors.push(`${label}: n (tasks) is 89`);
  if (nCell != null && nCell !== "2") errors.push(`${label}: n (tasks) is ${nCell} not 2`);
  const board = publicBoardCell(src);
  if (board && /(?:^|\s)yes\b/i.test(board.replace(/\*/g, "")) && !/\bno\b/i.test(board)) {
    errors.push(`${label}: public board (89 tasks) claimed yes`);
  }
  const locked = /locked subset/i.test(src) || /not(?: the)? 89-task/i.test(src);
  if (!locked) errors.push(`${label}: must say locked subset / not 89-task`);
  const claims89 =
    /\b89-task (?:public )?(?:tbench\.ai )?board\b/i.test(src) &&
    !/not(?: the)? 89-task/i.test(src) &&
    !/no public-board/i.test(src);
  if (claims89) errors.push(`${label}: claims public 89-task board`);
  if (/\bn\s*=\s*89\b/.test(src) && !/not 89/.test(src)) {
    errors.push(`${label}: n=89 public-board claim`);
  }
  if (errors.length) throw new Error(errors.join("; "));
}

/** Throws if RESULTS uses BrainMemory / cortex-off columns, k=40 as MCC, or LoCoMo 92. */
export function assertTbProductHonesty(src: string, label = "RESULTS"): void {
  const errors: string[] = [];
  if (hasBannedProductColumn(src)) {
    errors.push(`${label}: BrainMemory / cortex-off product column`);
  }
  if (/\|\s*BrainMemory\s*\|/i.test(src)) errors.push(`${label}: BrainMemory table column`);
  if (/\|\s*cortex-off\s*\|/i.test(src)) errors.push(`${label}: cortex-off table column`);
  if (/\bBrainMemory\.retrieve\b/.test(src)) {
    errors.push(`${label}: names BrainMemory.retrieve`);
  }
  const k40mcc =
    /\bk\s*=\s*40\b[\s\S]{0,80}\bMCC\b/i.test(src) ||
    /\bMCC\b[\s\S]{0,80}\bk\s*=\s*40\b/i.test(src);
  if (k40mcc && !/not k=40|not .*k=40|k=40 is forbidden|do not k=40/i.test(src)) {
    errors.push(`${label}: k=40 as MCC`);
  }
  if (/\bLoCoMo(?:-10)?\s*92\b/i.test(src) && !/do not claim LoCoMo 92|not LoCoMo 92/i.test(src)) {
    errors.push(`${label}: LoCoMo 92`);
  }
  if (errors.length) throw new Error(errors.join("; "));
}

/** Throws if absolute % is not the agent / memory claim is not Δ. */
export function assertAgentPctIsDelta(src: string, label = "RESULTS"): void {
  const errors: string[] = [];
  if (!/terminus-2/.test(src)) errors.push(`${label}: missing agent terminus-2`);
  const absIsAgent =
    /Absolute % is the \*\*agent\*\*/.test(src) ||
    /Absolute % is \*\*terminus-2\*\*/.test(src) ||
    /Absolute % is the agent/.test(src);
  if (!absIsAgent) {
    errors.push(`${label}: absolute % must be labeled as the agent (terminus-2)`);
  }
  if (!/Memory claim is \*\*Δ\*\*/.test(src) && !/memory claim is \*\*Δ\*\*/i.test(src)) {
    errors.push(`${label}: memory claim must be **Δ**`);
  }
  if (!/\binject\b/i.test(src)) errors.push(`${label}: missing inject path`);
  if (!/\bwrap\b/i.test(src)) errors.push(`${label}: missing wrap path`);
  if (errors.length) throw new Error(errors.join("; "));
}

describe("M32.4 Terminal-Bench honesty — no public-board 89-task claim", () => {
  test("subset.json is a locked 2-task subset, public_board false, not 89", () => {
    expect(existsSync(SUBSET)).toBe(true);
    const raw = JSON.parse(readFileSync(SUBSET, "utf8")) as SubsetFile;
    expect(raw.public_board).toBe(false);
    expect(Array.isArray(raw.tasks)).toBe(true);
    expect(raw.tasks).toHaveLength(2);
    expect(raw.tasks).not.toHaveLength(89);
    expect(String(raw.note ?? "")).toMatch(/not the 89-task|locked subset/i);
    expect(raw.agent).toBe("terminus-2");
    expect(raw.k).toBe(5);
  });

  test("RESULTS.md does not claim the public 89-task tbench.ai board", () => {
    expect(existsSync(RESULTS)).toBe(true);
    const src = readFileSync(RESULTS, "utf8");
    const subset = JSON.parse(readFileSync(SUBSET, "utf8")) as SubsetFile;
    expect(() => assertNotPublicBoard(src, subset, "RESULTS.md")).not.toThrow();
    expect(src).toMatch(/locked subset/i);
    expect(src).toMatch(/not(?: the)? 89-task/i);
    expect(nTasksCell(src)).toBe("2");
    expect(nTasksCell(src)).not.toBe("89");
    const board = publicBoardCell(src);
    expect(board, "public board row").toBeTruthy();
    expect(board!).toMatch(/\bno\b/i);
    expect(board!).not.toMatch(/^\s*yes\b/i);
    expect(src).toMatch(/tbench\.ai/);
    expect(src).toMatch(/Not the 89-task tbench\.ai board|not the 89-task/i);
  });

  test("M37.3 recert note exists; M32 title and wave stay", () => {
    const src = readFileSync(RESULTS, "utf8");
    expect(src).toMatch(/^# M32 Terminal-Bench 2\.1 Δ RESULTS/m);
    expect(src).toMatch(/\| wave \| M32 \|/);
    expect(src).toMatch(
      /\*\*M37\.3 recert:\*\* \d{4}-\d{2}-\d{2} — after M16–M36; locked subset k=5; not 89-task; backbone `google\/gemma-4-31b-it`\./,
    );
    const md = renderResults(pendingResultsReport("2026-09-21"));
    expect(md).toMatch(/^# M32 Terminal-Bench 2\.1 Δ RESULTS/m);
    expect(md).toContain("| wave | M32 |");
    expect(md).toContain(
      "**M37.3 recert:** 2026-09-21 — after M16–M36; locked subset k=5; not 89-task; backbone `google/gemma-4-31b-it`.",
    );
    expect(md).not.toMatch(/89-task public/);
  });

  test("forged 89-task public-board RESULTS is rejected", () => {
    const fake = [
      "# Terminal-Bench RESULTS",
      "| public board (89 tasks) | yes |",
      "| n (tasks) | 89 |",
      "This is the 89-task tbench.ai board.",
    ].join("\n");
    expect(() =>
      assertNotPublicBoard(fake, { public_board: true, tasks: Array.from({ length: 89 }) }, "fake"),
    ).toThrow(/89|public_board|locked subset/);
    expect(() =>
      assertNotPublicBoard(fake, { public_board: false, tasks: ["a", "b"] }, "fake-board"),
    ).toThrow(/89|public board|locked subset/i);
  });
});

describe("M32.4 RESULTS product path — inject/wrap, not BrainMemory", () => {
  test("RESULTS has no BrainMemory product column, no cortex-off column, no k=40 as MCC, no LoCoMo 92", () => {
    const src = readFileSync(RESULTS, "utf8");
    expect(() => assertTbProductHonesty(src, "RESULTS.md")).not.toThrow();
    expect(src).not.toMatch(/\|\s*BrainMemory\s*\|/i);
    expect(src).not.toMatch(/\|\s*cortex-off\s*\|/i);
    expect(src).not.toMatch(/BrainMemory\.retrieve/);
    expect(src).toMatch(/No BrainMemory column/i);
    expect(src).toMatch(/No cortex-off/i);
    expect(src).not.toMatch(/\bLoCoMo(?:-10)?\s*92\b/i);
    expect(src).not.toMatch(/\bk\s*=\s*40\b.*\bMCC\b|\bMCC\b.*\bk\s*=\s*40\b/i);
  });

  test("RESULTS names inject/wrap path, not BrainMemory.retrieve", () => {
    const src = readFileSync(RESULTS, "utf8");
    expect(src).toMatch(/inject/i);
    expect(src).toMatch(/wrap/i);
    expect(src).toMatch(/injectBodyThenObserveTools|handleChatCompletions|processMemory/);
    expect(src).not.toMatch(/BrainMemory\.retrieve/);
    expect(src).not.toMatch(/API under test:\s*`?BrainMemory/i);
  });

  test("absolute % is the agent (terminus-2); memory claim is Δ", () => {
    const src = readFileSync(RESULTS, "utf8");
    expect(() => assertAgentPctIsDelta(src, "RESULTS.md")).not.toThrow();
    expect(src).toMatch(/Absolute % is (?:the \*\*agent\*\*|\*\*terminus-2\*\*)/);
    expect(src).toMatch(/terminus-2/);
    expect(src).toMatch(/Memory claim is \*\*Δ\*\*/);
    expect(src).toMatch(/## Δ \(on − off\)|# Δ /);
  });

  test("forged BrainMemory / k=40 MCC / LoCoMo 92 RESULTS is rejected", () => {
    const fake = [
      "| BrainMemory | cortex-off | score |",
      "|---|---|---|",
      "| BrainMemory.retrieve | 92 | k=40 MCC |",
      "LoCoMo 92 as this exam. Absolute % is Eden.",
    ].join("\n");
    expect(() => assertTbProductHonesty(fake, "fake")).toThrow(/BrainMemory|cortex-off|k=40|LoCoMo/);
    expect(hasBannedProductColumn(fake)).toBe(true);
    expect(() => assertAgentPctIsDelta(fake, "fake")).toThrow(/agent|Δ|terminus-2|inject|wrap/i);
  });

  test("frozen M15 −20.0 pp stays on M15-EVIDENCE.md (live RESULTS may change in M32)", () => {
    const ev = readFileSync(M15_EVIDENCE, "utf8");
    expect(ev).toMatch(/−20\.0 pp|-20\.0 pp/);
    expect(ev).toMatch(/Locked subset, not 89-task board/);
    expect(ev).toMatch(/TB 2\.1 Δ/);
    expect(ev).toMatch(/Table 3 overall[^\n]*\*\*30\.0\*\*/);
  });
});

describe("M32.4 job dirs are model-tagged — GLM untagged is not the Gemma job", () => {
  test("run.ts jobName includes the model id; GLM dir names are not a gemma fallback", () => {
    const src = readFileSync(RUNNER, "utf8");
    const live = codeWithoutComments(src);
    const jobNameFn = extractNamedFn(live, "jobName");
    expect(jobNameFn.length).toBeGreaterThan(0);
    expect(jobNameFn).toMatch(/modelId\s*\(/);
    expect(jobNameFn).toMatch(/sanitizeModelId|replaceAll\(\s*["']\/["']/);
    expect(jobNameFn).not.toMatch(/return\s+`eden-m\d+-\$\{arm\}`\s*;/);
    expect(jobName("off")).toContain(GEMMA.replaceAll("/", "-"));
    expect(jobName("off")).not.toBe(GLM_UNTAGGED);
    expect(jobName("on")).not.toBe("eden-m153-on");
    expect(jobName("off")).not.toMatch(/glm/i);

    const findJob = extractNamedFn(live, "findJobDir");
    expect(findJob.length).toBeGreaterThan(0);
    expect(findJob).toMatch(/jobName\s*\(\s*arm\s*\)/);
    expect(findJob).not.toContain("`eden-m153-${arm}`");
    expect(findJob).not.toContain("`eden-m32-${arm}`");
    expect(findJob).not.toContain(GLM_UNTAGGED);
    expect(findJob).not.toMatch(/z-ai\/glm-5\.3|glm-5\.3/);
    expect(live).toMatch(/google\/gemma-4-31b-it/);
  });

  test("findJobDir (if exported) does not treat jobs/eden-m153-off as the Gemma job", async () => {
    const mod = (await import("./run.ts")) as Record<string, unknown>;
    const findJobDir = mod.findJobDir as ((arm: "off" | "on") => string | null) | undefined;
    const gemmaOff = join(JOBS_DIR, "eden-m153-off-google-gemma-4-31b-it");
    const glmOff = join(JOBS_DIR, GLM_UNTAGGED);
    if (typeof findJobDir === "function") {
      const hit = findJobDir("off");
      expect(hit).not.toBe(glmOff);
      expect(String(hit ?? "")).not.toMatch(new RegExp(`${GLM_UNTAGGED}$`));
      expect(String(hit ?? "")).not.toMatch(/glm-5\.3|z-ai/i);
      if (hit) expect(String(hit)).toMatch(/google-gemma-4-31b-it/);
    } else {
      expect(existsSync(gemmaOff)).toBe(true);
      expect(basename(gemmaOff)).toContain(GEMMA.replaceAll("/", "-"));
      expect(basename(gemmaOff)).not.toBe(GLM_UNTAGGED);
      const src = codeWithoutComments(readFileSync(RUNNER, "utf8"));
      const findJob = extractNamedFn(src, "findJobDir");
      expect(findJob).toMatch(/jobName\s*\(\s*arm\s*\)/);
      expect(findJob).not.toContain("`eden-m153-${arm}`");
      expect(src).not.toMatch(/join\(\s*JOBS_DIR\s*,\s*[`'"]eden-m\d+-\$\{arm\}[`'"]/);
    }
    void GLM_MODEL;
  });
});

describe("M32.4 NIM 504 is not TB_SKIP_HARBOR", () => {
  test("run.ts does not skip Harbor solely because probeNim/wrap returned 504", () => {
    const src = readFileSync(RUNNER, "utf8");
    const live = codeWithoutComments(src);
    expect(live).toMatch(/TB_SKIP_HARBOR === ["']1["']/);
    expect(live).not.toMatch(/process\.env\.TB_SKIP_HARBOR\s*=(?!=)/);

    const skipAssign = live.match(/const skip\s*=\s*([^;]+);/);
    expect(skipAssign?.[1]).toMatch(/process\.env\.TB_SKIP_HARBOR === ["']1["']/);
    expect(skipAssign?.[1]).not.toMatch(/504/);
    expect(skipAssign?.[1]).not.toMatch(/probeNim|probeWrap/);

    expect(live).not.toMatch(/if\s*\([^)]*504[^)]*\)[\s\S]{0,160}(?:skip\s*=\s*true|TB_SKIP_HARBOR)/);
    expect(shouldSkipHarborForHttp(504)).toBe(false);
    expect(shouldSkipHarborForHttp(502)).toBe(false);

    const probeNim = extractNamedFn(live, "probeNim");
    expect(probeNim.length).toBeGreaterThan(0);
    expect(probeNim).not.toMatch(/TB_SKIP_HARBOR/);

    const probeWrap = extractNamedFn(live, "probeWrap");
    expect(probeWrap.length).toBeGreaterThan(0);
    expect(probeWrap).not.toMatch(/TB_SKIP_HARBOR/);

    const main = extractNamedFn(live, "main");
    expect(main).toMatch(/Harbor still launched/);
    expect(main).toMatch(/504\/BadGateway is not (?:TB_SKIP_HARBOR|a skip)/);
    expect(main).not.toMatch(/if\s*\(\s*nim\.error\s*\)\s*\{[\s\S]{0,80}skip\s*=\s*true/);
    expect(main).not.toMatch(/504[\s\S]{0,80}canRun\s*=\s*false/);
    const canRun = main.match(/const canRun\s*=\s*([\s\S]*?);/);
    expect(canRun?.[1]).not.toMatch(/504/);
    expect(canRun?.[1]).not.toMatch(/nim\.error|probeNim|probeWrap/);
  });
});

describe("M32.4 remain-silent: on-cue still injects; math omit is allowed/required", () => {
  test("on-cue postgres still injects; math cue with a sqlite store is identity", () => {
    const prevMin = process.env.EDEN_MEMORY_MIN;
    const prevMem = process.env.EDEN_MEMORY;
    const prevKnow = process.env.EDEN_KNOW;
    const prevDir = process.env.EDEN_MEMORY_DIR;
    const prevHome = process.env.EDEN_HOME;
    const dir = mkdtempSync(join(tmpdir(), "eden-m324-tb-"));
    try {
      delete process.env.EDEN_MEMORY_MIN;
      process.env.EDEN_MEMORY = "on";
      process.env.EDEN_KNOW = "0";
      process.env.EDEN_MEMORY_DIR = dir;
      delete process.env.EDEN_HOME;
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: "Postgres is the session store." }]);
      mem.observe([{ role: "user", content: "Use sqlite." }]);
      const retrieved = mem.notesFor("What store is postgres?", 10);
      expect(retrieved.length).toBeGreaterThan(0);
      const cue = [{ role: "user" as const, content: "What store is postgres?" }];
      const out = mem.inject(cue);
      const blob = (Array.isArray(out) ? out : [])
        .map((m) =>
          m && typeof m === "object" ? String((m as { content?: unknown }).content ?? "") : "",
        )
        .join("\n");
      expect(blob).toContain(MEMORY_MARK);
      expect(blob).toMatch(/postgres/i);
      expect(out).not.toEqual(cue);
      const math = [{ role: "user" as const, content: "what's 2+2?" }];
      const silent = mem.inject(math);
      const silentBlob = (Array.isArray(silent) ? silent : [])
        .map((m) =>
          m && typeof m === "object" ? String((m as { content?: unknown }).content ?? "") : "",
        )
        .join("\n");
      expect(silent).toEqual(math);
      expect(silentBlob).not.toContain(MEMORY_MARK);
      mem.close();
    } finally {
      if (prevMin === undefined) delete process.env.EDEN_MEMORY_MIN;
      else process.env.EDEN_MEMORY_MIN = prevMin;
      if (prevMem === undefined) delete process.env.EDEN_MEMORY;
      else process.env.EDEN_MEMORY = prevMem;
      if (prevKnow === undefined) delete process.env.EDEN_KNOW;
      else process.env.EDEN_KNOW = prevKnow;
      if (prevDir === undefined) delete process.env.EDEN_MEMORY_DIR;
      else process.env.EDEN_MEMORY_DIR = prevDir;
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M32.4 suite is offline — no Harbor, no NVIDIA keys", () => {
  test("this file does not call main / reparseExisting / probeNim and does not read NVIDIA keys", () => {
    const self = readFileSync(join(HERE, "honesty.test.ts"), "utf8");
    expect(self).not.toMatch(/\bmain\s*\(/);
    expect(self).not.toMatch(/\breparseExisting\s*\(/);
    expect(self).not.toMatch(/\bprobeNim\s*\(/);
    expect(self).not.toMatch(/process\.env\.NVIDIA/);
    expect(self).not.toMatch(/nvidiaKey\s*\(/);
    expect(self).toMatch(/Does not launch Harbor/);
  });
});
