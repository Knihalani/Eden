/**
 * M47.4 — HELP.md ledger + the same no-memory control gate as RESULTS.
 * Does not retune the ranker. Does not score BrainMemory.
 *
 *   bun test benchmarks/memory-holdout/help.test.ts
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classRowIssues,
  classRows,
  hasBannedProductColumn,
  liftWithoutControl,
  liveLiftOffenders,
  namesNoMemoryControl,
  productResultsFiles,
} from "./savings.test";

const HELP = join(import.meta.dir, "HELP.md");
const TOKENS = join(import.meta.dir, "HELP-TOKENS.md");
const CASES = ["flake", "adr", "file-rule", "version", "junk", "silent-math"] as const;

function caseHit(name: string, id: string): boolean {
  const n = name.toLowerCase();
  if (id === "file-rule") return /file[- ]rule/.test(n);
  return n.includes(id);
}

/** Tokens increased and accuracy did not. That class must be called silent. */
function tokensUpAccuracyFlat(src: string): boolean {
  const tokenUp = /token[^\n]{0,80}\+\s*\d+/i.test(src) || /\+\s*\d+[^\n]{0,40}token/i.test(src);
  const flat = /accuracy[^\n]{0,80}(?:Δ|delta)?[^\n]{0,24}(?:≤\s*0|<=\s*0|\+\s*0(?:\.0+)?\b|-\s*\d)/i.test(src);
  return tokenUp && flat;
}

describe("M47.4 HELP ledger", () => {
  test("HELP.md is dated, names the control, and totals match the counted table", () => {
    expect(existsSync(HELP)).toBe(true);
    const md = readFileSync(HELP, "utf8");
    expect(md).toMatch(/\*\*Date:\*\*\s+\d{4}-\d{2}-\d{2}/);
    expect(md).toMatch(/EDEN_MEMORY\s*=\s*0/);
    expect(md).toMatch(/\bhelped\b/);
    expect(md).toMatch(/\bno-lift\b/);
    expect(md).toMatch(/\bharmed\b/);
    expect(namesNoMemoryControl(md)).toBe(true);
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
    expect(helped).toBeGreaterThan(harmed);
    const wins = md.match(/\| WIN \|/g) ?? [];
    const losses = md.match(/\| LOSS \|/g) ?? [];
    expect(wins.length).toBe(helped);
    expect(losses.length).toBe(harmed);
    expect(md).toMatch(/no-lift is junk-silent, not a LOSS/);
  });

  test("counted rows name wrap and hook and the required cases", () => {
    const md = readFileSync(HELP, "utf8");
    const table = md.split("\n").filter((l) => l.includes("|")).join("\n");
    expect(table).toMatch(/\bwrap\b/i);
    expect(table).toMatch(/\bhook\b/i);
    const names = classRows(md).map((r) => r.caseName);
    for (const id of CASES) {
      expect(names.some((n) => caseHit(n, id)), id).toBe(true);
    }
  });

  test("no BrainMemory column and no Memorable / Mem0 / LoCoMo helped row", () => {
    const md = readFileSync(HELP, "utf8");
    expect(hasBannedProductColumn(md)).toBe(false);
    for (const row of classRows(md)) {
      if (row.klass === "helped") expect(row.caseName).not.toMatch(/memorable|mem0|locomo|454\s*\/\s*454/i);
    }
    expect(classRowIssues(md)).toEqual([]);
  });

  test("HELP.md names the control, so lift without a control is false", () => {
    const md = readFileSync(HELP, "utf8");
    expect(liftWithoutControl(md)).toBe(false);
    expect(namesNoMemoryControl(md)).toBe(true);
  });

  test("product RESULTS scan is clean and includes HELP.md", () => {
    expect(liveLiftOffenders()).toEqual([]);
    expect(productResultsFiles().some((f) => f.endsWith("/HELP.md") || f.endsWith("\\HELP.md"))).toBe(true);
  });

  test("Gate 1: WIN without a no-memory control still fails", () => {
    const bare = "Gate 1: WIN";
    expect(liftWithoutControl(bare)).toBe(true);
    expect(namesNoMemoryControl(bare)).toBe(false);
    expect(liftWithoutControl("**Gate 1:** WIN 8 / LOSS 0 / FAIL 0\n")).toBe(true);
    expect(liftWithoutControl("Accuracy +12.0 pp.\n")).toBe(true);
    expect(liftWithoutControl("Memory lift on the coding holdout.\n")).toBe(true);
    expect(liftWithoutControl("Gate 1: WIN\nNo-memory control: EDEN_MEMORY=0\n")).toBe(false);
    expect(liftWithoutControl("Gate 1: WIN\noff arm\n")).toBe(false);
    expect(liftWithoutControl("Gate 1: WIN\nno-memory\n")).toBe(false);
  });

  test("HELP-TOKENS.md names injectBody, the control, and a numeric delta", () => {
    expect(existsSync(TOKENS)).toBe(true);
    const md = readFileSync(TOKENS, "utf8");
    expect(md).toMatch(/injectBody/);
    expect(md).toMatch(/EDEN_MEMORY\s*=\s*0/);
    expect(md).toMatch(/\b(?:bytes|tokens)\b/i);
    expect(md).toMatch(/(?:Δ|∆|\bdelta\b)/i);
    expect(md).toMatch(/[+-]?\d+(?:\.\d+)?/);
    if (tokensUpAccuracyFlat(md)) expect(md).toMatch(/\bsilent\b/i);
  });
});
