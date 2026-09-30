/**
 * M6.2 dual-API CI gate. Product scores are wrap/hook inject (`openMemory`).
 * Bench `BrainMemory` / `cortex: false` stays adapter-only (`// not-product`).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isBrainMemoryConstruct, isBrainMemoryImport, NOT_PRODUCT_LINE } from "./inject-gate";

// Quarantined tests are marked test.failing (P0.-1): https://github.com/Knihalani/Eden/issues/11

const ROOT = join(import.meta.dir, "../..");
const BENCH = join(ROOT, "benchmarks");
const MAB = join(BENCH, "memoryagentbench");
const HOLDOUT = join(BENCH, "memory-holdout");
const INJECT_API = join(MAB, "INJECT-API.md");
const ADAPTER = new Set(["mab-bridge.ts", "eden.py", "retrieve-eval.py"]);
const GATE_TESTS = new Set(["inject-only.test.ts", "inject-api.test.ts", "inject-gate.ts"]);
const INJECT_API_NAME = /hook-inject|openMemory|memoryHookResponse|respondToHook/;
const BAN_CELL = /\bnot-product\b|\b(?:not|no|never|ban|banned|forbid|forbidden|without|versus|vs\.?)\b/i;
const BRAIN_CELL = /^(?:eden\s+)?brainmemory(?:\.retrieve)?$|^cortex\s*:\s*false$|^cortex-off$|^cortex\s+false$/i;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}[-|:\s]*$/;

function walkSource(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules") continue;
    const next = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkSource(next));
    else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".py"))) out.push(next);
  }
  return out;
}

function mabMarkdown(): string[] {
  return readdirSync(MAB)
    .filter((name) => name.endsWith(".md") && name !== "SOTA-GAP-REPORT.md")
    .map((name) => join(MAB, name));
}

function holdoutResults(): string[] {
  if (!existsSync(HOLDOUT)) return [];
  return readdirSync(HOLDOUT)
    .filter((name) => name.endsWith(".md") && (name === "RESULTS.md" || /RESULTS/i.test(name)))
    .map((name) => join(HOLDOUT, name));
}

function rel(file: string): string {
  return relative(ROOT, file);
}

function cellCanon(cell: string): string {
  return cell.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

function scoresBrainProductCell(cell: string, isHeader: boolean): boolean {
  const c = cellCanon(cell);
  if (!c || BAN_CELL.test(c)) return false;
  if (BRAIN_CELL.test(c)) return true;
  if (isHeader && /\bbrainmemory\b/i.test(c) && !/\b(?:bench|adapter|legacy|autopsy)\b/i.test(c)) return true;
  if (isHeader && /cortex\s*:\s*false|cortex-off/i.test(c)) return true;
  return false;
}

function splitCells(line: string): string[] {
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function parseTableRows(src: string): Array<{ line: number; header: boolean; cells: string[] }> {
  const lines = src.split("\n");
  const rows: Array<{ line: number; header: boolean; cells: string[] }> = [];
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
      rows.push({ line: i + 1, header: true, cells });
      continue;
    }
    if (inTable) rows.push({ line: i + 1, header: false, cells });
  }
  return rows;
}

function brainProductTableHits(file: string, src: string): string[] {
  const hits: string[] = [];
  for (const row of parseTableRows(src)) {
    for (const cell of row.cells) {
      if (scoresBrainProductCell(cell, row.header)) hits.push(`${rel(file)}:${row.line}: ${cellCanon(cell)}`);
    }
  }
  return hits;
}

describe("M6.2 dual-API CI gate", () => {
  test("MAB BrainMemory imports need // not-product or # not-product on the same line", () => {
    const offenders: string[] = [];
    for (const file of walkSource(MAB)) {
      if (GATE_TESTS.has(file.split("/").pop() ?? "")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!isBrainMemoryImport(line)) continue;
        if (NOT_PRODUCT_LINE.test(line)) continue;
        offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("legacy MAB adapter stays not-product (stricter on construct + file banner)", () => {
    const missingBanner: string[] = [];
    const constructs: string[] = [];
    for (const name of ADAPTER) {
      const file = join(MAB, name);
      expect(existsSync(file), `${name} missing`).toBe(true);
      const src = readFileSync(file, "utf8");
      if (!src.includes("not-product")) missingBanner.push(rel(file));
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!(isBrainMemoryImport(line) || isBrainMemoryConstruct(line))) continue;
        if (NOT_PRODUCT_LINE.test(line)) continue;
        constructs.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(missingBanner).toEqual([]);
    expect(constructs).toEqual([]);
  });

  test("product RESULTS cannot publish a BrainMemory / cortex: false column", () => { // not-product
    const offenders: string[] = [];
    for (const file of [...mabMarkdown(), ...holdoutResults()]) {
      offenders.push(...brainProductTableHits(file, readFileSync(file, "utf8")));
    }
    expect(offenders).toEqual([]);
  });

  test("holdout RESULTS name the inject API (skip missing RESULTS.md)", () => {
    const missingName: string[] = [];
    for (const file of holdoutResults()) {
      // readdir omits RESULTS.md when M6.1 has not written it yet.
      if (!INJECT_API_NAME.test(readFileSync(file, "utf8"))) missingName.push(rel(file));
    }
    expect(missingName).toEqual([]);
  });

  test("M48 RESULTS name hook-inject and publish no BrainMemory column", () => {
    const missingHook: string[] = [];
    const brain: string[] = [];
    for (const file of holdoutResults()) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("hook-inject")) missingHook.push(rel(file));
      brain.push(...brainProductTableHits(file, src));
    }
    expect(missingHook).toEqual([]);
    expect(brain).toEqual([]);
  });

  test.failing("INJECT-API.md matches hookMemory session file; wrap stays processMemory()", () => {
    const freeze = readFileSync(INJECT_API, "utf8");
    expect(freeze).toContain("hookMemory");
    expect(freeze).toContain("session_id");
    expect(freeze).toMatch(/<dir>\/<session>\/memories\.jsonl/);
    expect(freeze).toContain("processMemory()");
    expect(freeze).not.toMatch(/TCM\/`ep` do not survive spawn/);
    expect(freeze).not.toMatch(/ep do not survive spawn/);
    const hook = readFileSync(join(ROOT, "packages/cli/src/memory-hook.ts"), "utf8");
    expect(hook).toMatch(/function hookMemory/);
    expect(hook).toMatch(/raw\.session_id/);
    expect(hook).toMatch(/raw\.sessionID/);
    expect(hook).toMatch(/raw\.sessionId/);
    expect(hook).toMatch(/openMemory\(\{[\s\S]*?\bsession,/);
  });
});
