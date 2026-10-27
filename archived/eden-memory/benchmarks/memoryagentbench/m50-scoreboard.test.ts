/**
 * M50.2 scoreboard honesty. Does not re-run Table 3, LME-V2, or Harbor.
 * Disjoint from protocol.test.ts (M50.4).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimDenied } from "./inject-gate";

const HERE = import.meta.dir;
const SCOREBOARD = join(HERE, "M50-SCOREBOARD.md");
const TABLE3 = join(HERE, "TABLE3-RESULTS.md");
const CONFIG = join(HERE, "table3-inject.config.json");
const LME = join(HERE, "../lme-v2/RESULTS.md");
const TB = join(HERE, "../terminal-bench/RESULTS.md");

function matchDenied(line: string, re: RegExp): boolean {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const m = new RegExp(re.source, flags).exec(line);
  if (!m || m.index === undefined) return false;
  return claimDenied(line, m.index, m.index + m[0].length);
}

/** LoCoMo 92 on a line that is not a denial. That is a product claim. */
function locomo92ClaimLines(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    const loc = line.search(/locomo/i);
    const n92 = line.search(/\b92(?:\.\d+)?\b/);
    if (loc < 0 || n92 < 0) continue;
    const span = line.slice(Math.min(loc, n92), Math.max(loc, n92));
    if (/(?<!\d)[.!?](?!\d)/.test(span)) continue;
    if (claimDenied(line, loc, loc + 6) || claimDenied(line, n92, n92 + 2)) continue;
    hits.push(line.trim());
  }
  return hits;
}

/** Affirmative SOTA. A denial line ("Not claimed", "only if") is not a sentence. */
function sotaClaimLines(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    if (!/\bSOTA\b/.test(line)) continue;
    if (matchDenied(line, /\bSOTA\b/)) continue;
    if (/\*\*Not claimed\.\*\*|\*\*Not met\b|\*\*Not this file\.\*\*/.test(line)) continue;
    hits.push(line.trim());
  }
  return hits;
}

describe("M50.2 scoreboard", () => {
  const board = readFileSync(SCOREBOARD, "utf8");
  const table3 = readFileSync(TABLE3, "utf8");
  const lme = readFileSync(LME, "utf8");
  const tb = readFileSync(TB, "utf8");
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as {
    k: number;
    eventqa: number;
    fc: number;
    sh: number;
    mh: number;
    labelStrip: boolean;
    reader: string;
    api: string;
  };

  test("dates today and certifies the M37 inject column", () => {
    expect(board).toMatch(/\*\*Date:\*\*\s*2026-09-25/);
    expect(board).toMatch(/Filed\. SOTA sentences only if §9\.2 holds/);
    expect(board).toMatch(/certifies/i);
    expect(board).toMatch(/M38–M49 were help-path/);
    expect(board).toMatch(/did not retune extract\/ranker for MAB leaves/);
    expect(board).toMatch(/Remain-silent can change Table 3/);
    expect(board).toMatch(/certified column is the pre-silence M37 run/);
    expect(board).toMatch(/not a post-silence re-run/);
    expect(locomo92ClaimLines("Eden LoCoMo 92 is official, not a draft").length).toBeGreaterThan(0);
    expect(board).toContain("google/gemma-4-31b-it");
    expect(board).toMatch(/\*\*not\*\*\s*GPT-4o-mini/);
  });

  test("copies four avgs, overall 44.8, LME 1.8%, and TB Δ −10.0 pp", () => {
    expect(board).toMatch(/\|\s*AR\s*\|\s*57\.3\s*\|/);
    expect(board).toMatch(/\|\s*TTL\s*\|\s*34\.6\s*\|/);
    expect(board).toMatch(/\|\s*LRU\s*\|\s*53\.8\s*\|/);
    expect(board).toMatch(/\|\s*SF\s*\|\s*33\.5\s*\|/);
    expect(board).toMatch(/\|\s*\*\*overall\*\*\s*\|\s*\*\*44\.8\*\*/);
    expect(board).toMatch(/acc \*\*1\.8%\*\*/);
    expect(board).toMatch(/Δ \*\*−10\.0 pp\*\*/);
    expect(table3).toMatch(/\|\s*\*\*overall\*\*\s*\|\s*\*\*44\.8\*\*/);
    expect(lme).toMatch(/\|\s*\*\*acc\*\*\s*\|\s*\*\*1\.8%\*\*/);
    expect(tb).toMatch(/-10\.0 pp/);
  });

  test("does not claim LoCoMo 92 or SOTA", () => {
    expect(locomo92ClaimLines(board)).toEqual([]);
    expect(sotaClaimLines(board)).toEqual([]);
    expect(board).toMatch(/No LoCoMo 92/);
    expect(board).toMatch(/\*\*Not claimed\.\*\*/);
    expect(board).toMatch(/Bar ≥ 50/);
    expect(board).toMatch(/\*\*Not met\*\* \(44\.8\)/);
    expect(board).toMatch(/FC-SH 58 \/ FC-MH 9/);
    expect(board).toMatch(/1\.8% vs 74\.9/);
    expect(board).toMatch(/honest \*\*LOSS\*\*/);
    expect(board).toMatch(/Δ \*\*−10\.0 pp\*\*/);
    expect(board).toMatch(/M50\.3 `benchmarks\/memory-holdout\/HELP\.md`/);
    expect(board).not.toMatch(/\|\s*BrainMemory\s*\|/i);
    expect(board).not.toMatch(/EventQA-64k as|k=40 as MCC|k=40-as-MCC:\s*yes/i);
  });

  test("certified protocol knobs still match the live config", () => {
    expect(config.k).toBe(10);
    expect(config.eventqa).toBe(534000);
    expect(config.fc).toBe(262000);
    expect(config.sh).toBe(197000);
    expect(config.mh).toBe(421000);
    expect(config.labelStrip).toBe(false);
    expect(config.reader).toBe("google/gemma-4-31b-it");
    expect(config.api).toBe("openMemory inject");
    expect(board).toMatch(/TABLE3-RESULTS\.md/);
    expect(board).toMatch(/lme-v2\/RESULTS\.md/);
    expect(board).toMatch(/terminal-bench\/RESULTS\.md/);
    expect(board).toMatch(/PROTOCOL\.md/);
  });
});
