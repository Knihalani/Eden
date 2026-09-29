/**
 * M35.2 — helped / no-lift / harmed annex.
 * Product RESULTS that claim lift, WIN, or +Δ accuracy without a no-memory
 * control fail. Does not retune ranking. Does not launch Harbor.
 *
 *   bun test benchmarks/memory-holdout/savings.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const BENCH = join(ROOT, "benchmarks");
const SAVINGS = join(import.meta.dir, "SAVINGS.md");
const SCAN_DIRS = ["memory-holdout", "memoryagentbench", "lme-v2", "terminal-bench"].map((d) => join(BENCH, d));
const TABLE_SEP = /^\s*\|?\s*:?-{2,}[-|:\s]*$/;
const CLASSES = new Set(["helped", "no-lift", "harmed"]);

function rel(file: string): string {
  return relative(ROOT, file);
}

function isProductResultsName(name: string): boolean {
  return name.endsWith(".md") && /results/i.test(name);
}

/** Autopsy, plus evidence locks that already state the protocol. */
export function shouldSkipResultsGate(name: string, src: string): boolean {
  if (name === "SOTA-GAP-REPORT.md") return true;
  const head = src.slice(0, 800);
  const lock = /evidence lock/i.test(head) || /EVIDENCE/i.test(name);
  if (!lock) return false;
  const discloses =
    /protocol/i.test(src) &&
    (/\bk\s*=\s*10\b/.test(src) || /official lengths/i.test(src) || /534k/.test(src) || /EDEN_MEMORY\s*=\s*0/.test(src));
  return discloses;
}

/** Strip denials so "No EDEN_MEMORY=0" is not a control. Keep "No-memory control: EDEN_MEMORY=0". */
function withoutControlDenials(src: string): string {
  return src
    .replace(/[`*]/g, "")
    .replace(/\bno\s+EDEN_MEMORY\s*=\s*["']?0\b/gi, " ")
    .replace(/\bnot\s+(?:an?\s+)?EDEN_MEMORY\s*=\s*["']?0\b/gi, " ")
    .replace(/\b(?:never|without|absent|missing)\s+(?:an?\s+)?EDEN_MEMORY\s*=\s*["']?0\b/gi, " ")
    .replace(/\b(?:did|does|do|has|have|had)\s+not\s+(?:run|include|have|use|name|record)\b[^.\n]{0,24}?\bEDEN_MEMORY\s*=\s*["']?0\b/gi, " ")
    .replace(/\bwithout\s+(?:an?\s+)?(?:EDEN_MEMORY\s*=\s*["']?0|off(?:\s+arm)?|no-memory(?:\s+control)?)\b/gi, " ")
    .replace(/\bno\s+off(?:\s+arm)?\b/gi, " ")
    .replace(/\b(?:absent|missing)\s+(?:an?\s+)?off(?:\s+arm)?\b/gi, " ")
    .replace(/\boff(?:\s+arm)?\s+is\s+(?:absent|missing|not\s+run|not\s+present)\b/gi, " ")
    .replace(/\bnot a no-memory(?:\s+lift)?\b/gi, " ")
    .replace(/\bno no-memory\b/gi, " ");
}

export function namesNoMemoryControl(src: string): boolean {
  const t = withoutControlDenials(src);
  if (/EDEN_MEMORY\s*=\s*["']?0\b/.test(t)) return true;
  if (/\bno-memory\b/i.test(t) || /\bno memory\b/i.test(t)) return true;
  const stripped = t.replace(/cortex-off/gi, " ").replace(/\bofficial\b/gi, " ");
  return /\boff\b/i.test(stripped);
}

export function claimsLift(src: string): boolean {
  const text = src
    .replace(/\bno-lift\b/gi, " ")
    .replace(/\bnot a (?:no-memory )?lift\b/gi, " ")
    .replace(/\bWIN only if\b/gi, " ")
    .replace(/\bboth rows WIN\b/gi, " ")
    .replace(/\bWIN\s+vs\s+(?:HippoRAG|BM25|RAG|AgentRunbook|assembly|Mem0|Zep|Letta)/gi, " ");
  if (/\bWIN\b/.test(text)) return true;
  if (/(?<![\w-])\+\s*\d+(?:\.\d+)?\s*pp\b/.test(text)) return true;
  return /\blift\b/i.test(text);
}

export function liftWithoutControl(src: string): boolean {
  return claimsLift(src) && !namesNoMemoryControl(src);
}

function walkResults(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "jobs" || ent.name === "fixtures") continue;
    const next = join(dir, ent.name);
    if (ent.isDirectory()) walkResults(next, out);
    else if (ent.isFile() && isProductResultsName(ent.name)) out.push(next);
  }
}

export function productResultsFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCAN_DIRS) walkResults(dir, out);
  // M47 HELP.md is a product ledger, not a *RESULTS* filename. Same lift gate.
  const help = join(import.meta.dir, "HELP.md");
  if (existsSync(help)) out.push(help);
  return out;
}

function splitCells(line: string): string[] {
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function cellCanon(cell: string): string {
  return cell.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

/** Keep underscores so `EDEN_MEMORY=0` survives. Still drops markdown emphasis. */
function cellText(cell: string): string {
  return cell.replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
}

function tableRows(src: string): Array<{ header: boolean; cells: string[] }> {
  const lines = src.split("\n");
  const rows: Array<{ header: boolean; cells: string[] }> = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("|")) {
      inTable = false;
      continue;
    }
    if (TABLE_SEP.test(line)) continue;
    const cells = splitCells(line);
    if (!cells.length) continue;
    const nextIsSep = TABLE_SEP.test(lines[i + 1] ?? "");
    if (nextIsSep) {
      inTable = true;
      rows.push({ header: true, cells });
      continue;
    }
    if (inTable) rows.push({ header: false, cells });
  }
  return rows;
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
      if (row.header && /\bbrainmemory\b/i.test(c) && !/\b(?:bench|adapter|legacy|autopsy)\b/i.test(c)) return true;
      if (row.header && /cortex-off|cortex\s*:\s*false/i.test(c)) return true;
    }
  }
  return false;
}

type ClassRow = { line: number; caseName: string; klass: string; control: string };

export function classRows(src: string): ClassRow[] {
  const lines = src.split("\n");
  const rows: ClassRow[] = [];
  let header: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("|")) {
      header = null;
      continue;
    }
    if (TABLE_SEP.test(line)) continue;
    const cells = splitCells(line).map(cellText);
    if (TABLE_SEP.test(lines[i + 1] ?? "")) {
      const keys = cells.map((c) => c.toLowerCase());
      header = keys.includes("class") && keys.some((c) => c.includes("control")) ? keys : null;
      continue;
    }
    if (!header) continue;
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      rec[h] = cells[idx] ?? "";
    });
    rows.push({
      line: i + 1,
      caseName: rec.case ?? "",
      klass: (rec.class ?? "").toLowerCase(),
      control: rec.control ?? "",
    });
  }
  return rows;
}

export function classRowIssues(src: string): string[] {
  const issues: string[] = [];
  const rows = classRows(src);
  if (!rows.length) issues.push("counted table missing (header must include class and control)");
  for (const row of rows) {
    if (!CLASSES.has(row.klass)) issues.push(`line ${row.line}: class ${row.klass || "∅"} is not helped|no-lift|harmed`);
    if (!namesNoMemoryControl(row.control)) issues.push(`line ${row.line}: ${row.caseName || "row"} has no no-memory control`);
    if (row.klass === "helped" && /memorable|mem0|locomo|454\s*\/\s*454/i.test(row.caseName)) {
      issues.push(`line ${row.line}: ${row.caseName} cannot be helped`);
    }
  }
  return issues;
}

export function liveLiftOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of productResultsFiles()) {
    const src = readFileSync(file, "utf8");
    const name = basename(file);
    if (shouldSkipResultsGate(name, src)) continue;
    if (hasBannedProductColumn(src)) offenders.push(`${rel(file)}: BrainMemory product column`);
    if (liftWithoutControl(src)) offenders.push(`${rel(file)}: lift/WIN/+Δ without no-memory control`);
  }
  return offenders;
}

describe("M35.2 savings control gate", () => {
  test("lift, WIN, or +pp without a no-memory control is a failure", () => {
    const bareWin = "**Gate 1:** WIN 8 / LOSS 0 / FAIL 0\nNo cortex-off column.\n";
    expect(liftWithoutControl(bareWin)).toBe(true);
    expect(namesNoMemoryControl(bareWin)).toBe(false);
    const plus = "Accuracy +12.0 pp. No arm named.\n";
    expect(liftWithoutControl(plus)).toBe(true);
    const word = "Memory lift on the coding holdout.\n";
    expect(liftWithoutControl(word)).toBe(true);
  });

  test("EDEN_MEMORY=0, off, or no-memory satisfies the control; denials and baseline-alone do not", () => {
    expect(liftWithoutControl("| off (EDEN_MEMORY=0) | on | Δ |\n| 40% | 50% | +10.0 pp |\n")).toBe(false);
    expect(namesNoMemoryControl("control: no-memory")).toBe(true);
    expect(namesNoMemoryControl("Δ = on − off")).toBe(true);
    expect(namesNoMemoryControl("No-memory control: EDEN_MEMORY=0")).toBe(true);
    expect(namesNoMemoryControl("baseline")).toBe(false);
    expect(namesNoMemoryControl("No cortex-off column.")).toBe(false);
    expect(namesNoMemoryControl("No EDEN_MEMORY=0 arm.")).toBe(false);
    expect(namesNoMemoryControl("We did not run EDEN_MEMORY=0.")).toBe(false);
    expect(namesNoMemoryControl("The off arm is missing.")).toBe(false);
    expect(liftWithoutControl("**Gate 1:** WIN 8 / LOSS 0 / FAIL 0\nNo EDEN_MEMORY=0 arm.\n")).toBe(true);
    expect(liftWithoutControl("**Gate 1:** WIN 8\nWe did not run EDEN_MEMORY=0.\n")).toBe(true);
    expect(liftWithoutControl("**Gate 1:** WIN 8\nThe off arm is missing.\n")).toBe(true);
    expect(liftWithoutControl("**Gate 1:** WIN\nbaseline 40 vs probe 50 +10.0 pp\n")).toBe(true);
    expect(liftWithoutControl("WIN vs HippoRAG-v2 41.6. No EDEN_MEMORY=0 arm.\n")).toBe(false);
  });

  test("helped row without a control fails; Memorable / Mem0 / LoCoMo cannot be helped", () => {
    const bad = [
      "| case | class | on | off | Δ | control | notes |",
      "|---|---|---|---|---|---|---|",
      "| invented | helped | 90% | | +40 pp | | |",
      "| Memorable 454/454 | helped | 454/454 | | | EDEN_MEMORY=0 | |",
      "| Mem0 92 | helped | 92 | | | off | |",
    ].join("\n");
    const issues = classRowIssues(bad);
    expect(issues.some((i) => i.includes("invented"))).toBe(true);
    expect(issues.some((i) => i.includes("Memorable"))).toBe(true);
    expect(issues.some((i) => i.includes("Mem0"))).toBe(true);
  });

  test("BrainMemory product column is banned; a denial is not a column", () => {
    expect(hasBannedProductColumn("| case | BrainMemory |\n|---|---|\n| a | 92 |\n")).toBe(true);
    expect(hasBannedProductColumn("No BrainMemory column. No cortex-off column.\n")).toBe(false);
  });

  test("scanner sees product RESULTS and skips the autopsy plus the M15 evidence lock", () => {
    const names = productResultsFiles().map(rel).sort();
    expect(names).toContain("benchmarks/memory-holdout/RESULTS.md");
    expect(names).toContain("benchmarks/memory-holdout/TOOLS-RESULTS.md");
    expect(names).toContain("benchmarks/memoryagentbench/TABLE3-RESULTS.md");
    expect(names).toContain("benchmarks/lme-v2/RESULTS.md");
    expect(names).toContain("benchmarks/lme-v2/RESULTS.smoke.md");
    expect(names).toContain("benchmarks/terminal-bench/RESULTS.md");
    expect(names.some((n) => n.endsWith("SOTA-GAP-REPORT.md"))).toBe(false);
    expect(names.some((n) => n.endsWith("M15-EVIDENCE.md"))).toBe(false);
    const autopsy = readFileSync(join(BENCH, "memoryagentbench/SOTA-GAP-REPORT.md"), "utf8");
    expect(shouldSkipResultsGate("SOTA-GAP-REPORT.md", autopsy)).toBe(true);
    const lock = readFileSync(join(BENCH, "memoryagentbench/M15-EVIDENCE.md"), "utf8");
    expect(shouldSkipResultsGate("M15-EVIDENCE.md", lock)).toBe(true);
    expect(shouldSkipResultsGate("RESULTS.md", readFileSync(join(import.meta.dir, "RESULTS.md"), "utf8"))).toBe(false);
  });

  test("SAVINGS.md is dated, names EDEN_MEMORY=0, and totals match the counted table", () => {
    expect(existsSync(SAVINGS)).toBe(true);
    const md = readFileSync(SAVINGS, "utf8");
    expect(md).toMatch(/2026-09-22/);
    expect(md).toMatch(/EDEN_MEMORY\s*=\s*0/);
    expect(md).toMatch(/\bhelped\b/);
    expect(md).toMatch(/\bno-lift\b/);
    expect(md).toMatch(/\bharmed\b/);
    expect(md).toMatch(/§11\.2/);
    expect(hasBannedProductColumn(md)).toBe(false);
    expect(classRowIssues(md)).toEqual([]);
    const rows = classRows(md);
    const helped = rows.filter((r) => r.klass === "helped").length;
    const noLift = rows.filter((r) => r.klass === "no-lift").length;
    const harmed = rows.filter((r) => r.klass === "harmed").length;
    const totals = md.match(/helped\s+(\d+)\s*\/\s*no-lift\s+(\d+)\s*\/\s*harmed\s+(\d+)/i);
    expect(totals, "totals line").not.toBeNull();
    expect(Number(totals?.[1])).toBe(helped);
    expect(Number(totals?.[2])).toBe(noLift);
    expect(Number(totals?.[3])).toBe(harmed);
    expect(helped + noLift + harmed).toBe(rows.length);
  });

  test("product RESULTS that claim lift / WIN / +Δ name a no-memory control", () => {
    expect(liveLiftOffenders()).toEqual([]);
  });
});
