/**
 * M50.4 honest claims. PROTOCOL + RESULTS + public README.
 * Fails if a ship claim uses Table 3 overall without four avgs, a BrainMemory
 * product column, k=40 as MCC, EventQA-64k as Table 3, LoCoMo 92 as an Eden
 * score, a memory UI / memory_search default loop, or bare SOTA.
 * Does not retune the ranker. Does not import protocol.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { claimDenied, NOT_PRODUCT_LINE } from "./inject-gate";

const ROOT = join(import.meta.dir, "../..");
const BENCH = join(ROOT, "benchmarks");
// lme-v2/RESULTS.smoke.md is gitignored, so CI and fresh clones lack it and the test that
// needs it skips there (quarantined in P0.-1: https://github.com/Knihalani/Eden/issues/12).
const HAS_SMOKE_RESULTS = existsSync(join(BENCH, "lme-v2/RESULTS.smoke.md"));
const COMPETENCIES = ["AR", "TTL", "LRU", "SF"] as const;

const PUBLIC_README = [
  "README.md",
  "packages/cli/README.md",
  "packages/sdk-js/README.md",
  "plugins/eden-memory/README.md",
] as const;

const DEFAULT_PATH = [
  "packages/wrap/src/proxy.ts",
  "packages/wrap/src/know-inject.ts",
  "packages/wrap/src/anthropic.ts",
  "packages/wrap/src/tool-observe.ts",
  "packages/cli/src/hook.ts",
  "packages/cli/src/memory-hook.ts",
  "packages/cli/src/setup.ts",
  "packages/cli/src/doctor.ts",
] as const;

function rel(file: string): string {
  return relative(ROOT, file);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** True when a denial word governs this match. A later "not" does not. */
export function matchDenied(line: string, re: RegExp): boolean {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const scan = new RegExp(re.source, flags);
  const m = scan.exec(line);
  if (!m || m.index === undefined) return false;
  return claimDenied(line, m.index, m.index + m[0].length);
}

function walkResults(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "archived" || ent.name.startsWith(".")) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkResults(p, acc);
    else if (/results/i.test(ent.name) && ent.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

export function claimsTable3Overall(src: string): boolean {
  return /table\s*3/i.test(src) && /\boverall\b/i.test(src);
}

export function missingTable3CompetencyAvgs(src: string): string[] {
  return COMPETENCIES.filter((c) => {
    const tableRow = new RegExp(`\\|\\s*(?:Table 3\\s+)?${c}\\s*\\|[^\\n]*\\d`).test(src);
    const labeled = new RegExp(`\\b${c}\\b\\s*[:=]\\s*-?\\d`).test(src);
    return !(tableRow || labeled);
  });
}

export function assertTable3OverallHasFourAvgs(src: string, label = "RESULTS"): void {
  if (!claimsTable3Overall(src)) return;
  const missing = missingTable3CompetencyAvgs(src);
  if (missing.length) {
    throw new Error(`${label} claims Table 3 overall without four competency avgs (missing ${missing.join(", ")})`);
  }
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}[-|:\s]*$/;
const BRAIN_CELL = /^(?:eden\s+)?brainmemory(?:\.retrieve)?$|^cortex\s*:\s*false$|^cortex-off$|^cortex\s+false$/i;

function cellCanon(cell: string): string {
  return cell.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
}

function splitCells(line: string): string[] {
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** Table cell that scores BrainMemory / cortex-off as a product column. */
export function brainMemoryProductColumnHits(src: string): string[] {
  const lines = src.split("\n");
  const hits: string[] = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (NOT_PRODUCT_LINE.test(line)) {
      if (!line.includes("|")) inTable = false;
      continue;
    }
    if (!line.includes("|")) {
      inTable = false;
      continue;
    }
    if (TABLE_SEP.test(line)) continue;
    const cells = splitCells(line);
    if (!cells.length) continue;
    const nextIsSep = TABLE_SEP.test(lines[i + 1] ?? "");
    const header = nextIsSep;
    if (header) inTable = true;
    if (!header && !inTable) continue;
    for (const cell of cells) {
      const c = cellCanon(cell);
      if (!c || NOT_PRODUCT_LINE.test(c) || claimDenied(c, 0, c.length)) continue;
      if (BRAIN_CELL.test(c)) hits.push(`${i + 1}: ${c}`);
      else if (header && /\bbrainmemory\b/i.test(c) && !/\b(?:bench|adapter|legacy|autopsy)\b/i.test(c)) {
        hits.push(`${i + 1}: ${c}`);
      }
    }
  }
  return hits;
}

/** k=40 published as MCC or Table 3. A denial ("not k=40") is not a claim. */
export function k40AsMccHits(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    if (/\bvs\b/i.test(line)) continue;
    const k40 = /\bk\s*=\s*40\b/.test(line) || /\bk\s*:\s*\**\s*40\b/.test(line);
    if (k40 && matchDenied(line, /\bk\s*=\s*40\b|\bk\s*:\s*\**\s*40\b/)) continue;
    if (!k40) continue;
    if (/\b(?:MCC|Table\s*3)\b/i.test(line)) hits.push(line.trim());
  }
  return hits;
}

/** EventQA-64k published as Table 3. "64k vs 534k" and sleep-byte 64k are not that claim. */
export function eventqa64AsTable3Hits(src: string): string[] {
  const hits: string[] = [];
  if (!/table\s*3/i.test(src)) return hits;
  for (const line of src.split("\n")) {
    if (/\bvs\b/i.test(line)) continue;
    if (!/EventQA/i.test(line)) continue;
    if (matchDenied(line, /EventQA/i)) continue;
    const has64 = /\b(?:64k|64[,_]?000|EventQA-64k)\b/i.test(line);
    const has534 = /\b534(?:k|000)\b/i.test(line);
    if (has64 && !has534) hits.push(line.trim());
  }
  return hits;
}

/** LoCoMo 92 on a line that is not a denial. That publishes it as an Eden score. */
export function locomo92EdenHits(src: string): string[] {
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

/** README sells a memory UI or dashboard as the product. */
export function memoryUiProductHits(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    if (
      (/memory\s+UI/i.test(line) || /memory\s+dashboard/i.test(line)) &&
      !matchDenied(line, /memory\s+(?:UI|dashboard)/i)
    ) {
      hits.push(line.trim());
    }
    if (/\bmemorable-cli\b/i.test(line) && !matchDenied(line, /memorable-cli/i)) hits.push(line.trim());
  }
  return hits;
}

/** README makes memory_search the default loop. "is not the default loop" is a denial. */
export function memorySearchDefaultHits(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    if (!/\bmemory_search\b/.test(line)) continue;
    if (matchDenied(line, /memory_search/)) continue;
    if (/\b(?:default|product|loop|hippocampus)\b/i.test(line)) hits.push(line.trim());
  }
  return hits;
}

const SOTA_NEEDLES: Array<[string, RegExp]> = [
  ["exam", /\b(?:exam|Table\s*3|MemoryAgentBench|LME(?:-V2)?|Terminal-Bench|LoCoMo)\b/i],
  ["metric", /\b(?:metric|acc(?:uracy)?|exact_match|substring|Δ|delta)\b/i],
  ["length", /\b(?:length|\d+\s*k|534(?:k|000)|262(?:k|000)|tokens)\b/i],
  ["k", /\bk\s*[=:]|\bk\b/i],
  ["backbone", /\b(?:backbone|gemma|4o-mini|GPT-4o)/i],
  ["inject", /\binject\b/i],
];

/** Positive SOTA sentence that omits exam, metric, length, k, backbone, or inject. */
export function sotaWithoutProtocolHits(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    if (!/\bSOTA\b/.test(line)) continue;
    if (matchDenied(line, /\bSOTA\b/)) continue;
    const missing = SOTA_NEEDLES.filter(([, re]) => !re.test(line)).map(([name]) => name);
    if (missing.length) hits.push(`missing ${missing.join("+")}: ${line.trim()}`);
  }
  return hits;
}

function claimSurfaces(): string[] {
  const named = [
    "benchmarks/memoryagentbench/PROTOCOL.md",
    "benchmarks/memoryagentbench/TABLE3-RESULTS.md",
    "benchmarks/memoryagentbench/M37-SCOREBOARD.md",
    "benchmarks/lme-v2/RESULTS.md",
    "benchmarks/terminal-bench/RESULTS.md",
    "benchmarks/memory-holdout/RESULTS.md",
    "benchmarks/memory-holdout/HELP.md",
    ...PUBLIC_README,
  ].map((p) => join(ROOT, p));
  const extra = walkResults(BENCH).filter((p) => !named.includes(p));
  const campaign = walkCampaign(join(BENCH, "campaign"));
  return [...named, ...extra, ...campaign];
}

function walkCampaign(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkCampaign(p, acc);
    else if (ent.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

describe("M50.4 honest claims", () => {
  test("detectors reject the seven banned claims", () => {
    expect(() => assertTable3OverallHasFourAvgs("Table 3 overall 99. Eden wins.", "fixture")).toThrow(
      /four competency avgs/,
    );
    expect(() =>
      assertTable3OverallHasFourAvgs(
        "Table 3 overall 44.8\n| AR | 57.3 |\n| TTL | 34.6 |\n| LRU | 53.8 |\n| SF | 33.5 |",
        "fixture",
      ),
    ).not.toThrow();

    const brain = "| System | BrainMemory |\n|---|---|\n| score | 90 |";
    expect(brainMemoryProductColumnHits(brain).length).toBeGreaterThan(0);
    expect(brainMemoryProductColumnHits("| BrainMemory | 90 | // not-product")).toEqual([]);
    expect(brainMemoryProductColumnHits("No BrainMemory column.")).toEqual([]);

    expect(k40AsMccHits("MCC k=40 is the Eden score").length).toBeGreaterThan(0);
    expect(k40AsMccHits("not k=40 MCC")).toEqual([]);
    expect(k40AsMccHits("Retrieve@40 ICL vs Table 7 MCC @ k=10")).toEqual([]);

    expect(eventqa64AsTable3Hits("Table 3 EventQA-64k scored 80.").length).toBeGreaterThan(0);
    expect(eventqa64AsTable3Hits("EventQA-64k vs Table 3 EventQA-534k")).toEqual([]);
    expect(eventqa64AsTable3Hits('Sleep `"64k"` bytes. Not Table 3.')).toEqual([]);

    expect(locomo92EdenHits("Eden LoCoMo 92").length).toBeGreaterThan(0);
    expect(locomo92EdenHits("Eden LoCoMo 92 is the published score, not a draft").length).toBeGreaterThan(0);
    expect(locomo92EdenHits("Do not claim LoCoMo 92.")).toEqual([]);
    expect(locomo92EdenHits("Not LoCoMo 92.")).toEqual([]);

    expect(memoryUiProductHits("Eden ships a memory UI.").length).toBeGreaterThan(0);
    expect(memoryUiProductHits("The product is a memory dashboard.").length).toBeGreaterThan(0);
    expect(memoryUiProductHits("Encode without a memory UI.").length).toEqual(0);
    expect(memorySearchDefaultHits("memory_search is the default loop").length).toBeGreaterThan(0);
    expect(memorySearchDefaultHits("`memory_search` is not the default loop.")).toEqual([]);

    expect(sotaWithoutProtocolHits("Eden memory is SOTA.").length).toBeGreaterThan(0);
    expect(sotaWithoutProtocolHits("Eden memory is SOTA. Do not use k=40.").length).toBeGreaterThan(0);
    expect(k40AsMccHits("MCC k=40 is the Eden score, not a toy").length).toBeGreaterThan(0);
    expect(memoryUiProductHits("Eden ships a memory UI without a login wall.").length).toBeGreaterThan(0);
    const qualified = "SOTA on exam Table 3, metric exact_match, length 534k, k=10, backbone gemma, inject.";
    expect(sotaWithoutProtocolHits(qualified)).toEqual([]);
    expect(sotaWithoutProtocolHits("4o-mini Table 3 SOTA: no")).toEqual([]);
  });

  test("RESULTS that claim Table 3 overall publish AR / TTL / LRU / SF", () => {
    const files = walkResults(BENCH);
    expect(files.some((p) => basename(p) === "TABLE3-RESULTS.md")).toBe(true);
    for (const p of files) assertTable3OverallHasFourAvgs(read(p), rel(p));
  });

  test.skipIf(!HAS_SMOKE_RESULTS)("PROTOCOL, RESULTS, HELP, and READMEs do not publish the banned scores", () => {
    const brain: string[] = [];
    const k40: string[] = [];
    const eventqa: string[] = [];
    const locomo: string[] = [];
    const sota: string[] = [];
    for (const p of claimSurfaces()) {
      expect(existsSync(p), rel(p)).toBe(true);
      const src = read(p);
      for (const hit of brainMemoryProductColumnHits(src)) brain.push(`${rel(p)}: ${hit}`);
      for (const hit of k40AsMccHits(src)) k40.push(`${rel(p)}: ${hit}`);
      for (const hit of eventqa64AsTable3Hits(src)) eventqa.push(`${rel(p)}: ${hit}`);
      for (const hit of locomo92EdenHits(src)) locomo.push(`${rel(p)}: ${hit}`);
      if (/\/README\.md$/i.test(p) || p.endsWith("/M50-SCOREBOARD.md")) {
        for (const hit of sotaWithoutProtocolHits(src)) sota.push(`${rel(p)}: ${hit}`);
      }
    }
    expect(brain).toEqual([]);
    expect(k40).toEqual([]);
    expect(eventqa).toEqual([]);
    expect(locomo).toEqual([]);
    expect(sota).toEqual([]);
    expect(claimSurfaces().some((p) => p.includes("/campaign/"))).toBe(true);
    expect(claimSurfaces().some((p) => p.endsWith("RESULTS.smoke.md"))).toBe(true);
    expect(claimSurfaces().some((p) => p.endsWith("RESULTS-SILENCE.md"))).toBe(true);
  });

  test("public READMEs do not sell a memory UI or memory_search as the product loop", () => {
    const ui: string[] = [];
    const search: string[] = [];
    for (const name of PUBLIC_README) {
      const p = join(ROOT, name);
      expect(existsSync(p), name).toBe(true);
      const src = read(p);
      for (const hit of memoryUiProductHits(src)) ui.push(`${name}: ${hit}`);
      for (const hit of memorySearchDefaultHits(src)) search.push(`${name}: ${hit}`);
    }
    expect(ui).toEqual([]);
    expect(search).toEqual([]);
    const cli = read(join(ROOT, "packages/cli/README.md"));
    expect(cli).toMatch(/memory_search` is not the default loop/);
    expect(cli).not.toMatch(/memorable-cli/);
  });

  test("public READMEs do not claim SOTA without exam, metric, length, k, backbone, and inject", () => {
    const hits: string[] = [];
    for (const name of ["README.md", "packages/cli/README.md", "packages/sdk-js/README.md"] as const) {
      const src = read(join(ROOT, name));
      for (const hit of sotaWithoutProtocolHits(src)) hits.push(`${name}: ${hit}`);
    }
    expect(hits).toEqual([]);
    expect(read(join(ROOT, "packages/sdk-js/README.md"))).not.toMatch(/\bmemory\b/i);
  });

  test("wrap, hook, setup, and doctor default path have zero memory_search", () => {
    const hits: string[] = [];
    for (const name of DEFAULT_PATH) {
      const src = read(join(ROOT, name));
      if (/\bmemory_search\b/.test(src)) hits.push(name);
    }
    expect(hits).toEqual([]);
  });
});
