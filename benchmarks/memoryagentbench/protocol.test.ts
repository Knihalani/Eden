/**
 * Gate 0 auditor (M1.2, M15.4, M16.1, M37.4).
 * M16.1: freeze M15-EVIDENCE.md; fail RESULTS that claim Table 3 overall
 * without AR / TTL / LRU / SF competency averages.
 * M37.4: honest-claim headers (backbone, no BrainMemory column, no 92 /
 * k=40-as-MCC / 64k-as-534k). Competency scores stay live — not a frozen overall.
 * Does not run the MemoryAgentBench dataset. No API keys.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openMemory } from "../../src/index.ts";
import { claimDenied } from "./inject-gate";
import { splitIcl } from "./atoms.ts";
import { badLabelStrip } from "./fixtures/bad-label-strip.example.ts";
import { badTable3 } from "./fixtures/bad-protocol.example.ts";

const HERE = import.meta.dir;
const BENCHMARKS = join(HERE, "..");
const PROTOCOL_MD = join(HERE, "PROTOCOL.md");
const M15_EVIDENCE = join(HERE, "M15-EVIDENCE.md");
const FIXTURE = join(HERE, "fixtures", "bad-protocol.example.json");
const FIXTURE_NESTED = join(HERE, "fixtures", "bad-protocol-nested.example.json");
const FIXTURE_OVERALL_NO_AVGS = join(HERE, "fixtures", "bad-table3-overall-no-avgs.example.json");

const TABLE3_COMPETENCIES = ["AR", "TTL", "LRU", "SF"] as const;

const TABLE3_EXAM = /table\s*3|\bmab\b|memoryagentbench|\bmcc\b/i;

export type MabProtocolCfg = {
  exam?: string;
  k?: number;
  eventqa?: number | string;
  fc?: number | string;
  sh?: number | string;
  mh?: number | string;
  labelStrip?: boolean;
  /** Published claim — Memorable 454/454 must not appear on Table 3. */
  claim?: string;
  memorable?: number | string;
  /** Retrieve/method field — GraphRAG EventQA is banned as Table 3. */
  method?: string;
  retrieve?: string;
};

export const MAB_TABLE3 = {
  exam: "Table 3",
  k: 10,
  eventqa: 534_000,
  fc: 262_000,
  sh: 197_000,
  mh: 421_000,
  reader: "GPT-4o-mini",
  chunks: "512/4096",
  labelStrip: false,
} as const;

export function parseLength(v: number | string | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  const s = String(v).trim().toLowerCase().replace(/,/g, "").replace(/^~/, "");
  const m = s.match(/^([\d.]+)\s*(k|m)?$/);
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  if (m[2] === "k") return Math.round(n * 1000);
  if (m[2] === "m") return Math.round(n * 1_000_000);
  return n;
}

function claimsTable3(exam?: string): boolean {
  return exam != null && TABLE3_EXAM.test(exam);
}

function protocolBlob(cfg: MabProtocolCfg | Record<string, unknown>): string {
  const rec = cfg as Record<string, unknown>;
  return [rec.claim, rec.memorable, rec.note, rec.score, JSON.stringify(cfg)]
    .map((x) => (x == null ? "" : String(x)))
    .join(" ");
}

/**
 * Memorable 454/454 is a fixture-completion exam, not MemoryAgentBench Table 3.
 * Throws on Table 3 + 454/454, or Table 3 + memorable 454.
 */
export function assertNotMemorableTable3(cfg: MabProtocolCfg | Record<string, unknown>): void {
  const exam = typeof cfg.exam === "string" ? cfg.exam : undefined;
  if (!claimsTable3(exam)) return;
  const blob = protocolBlob(cfg);
  const table3Plus454over454 = /454\s*\/\s*454/.test(blob);
  const table3PlusMemorable454 = /memorable/i.test(blob) && /\b454\b/.test(blob);
  if (table3Plus454over454 || table3PlusMemorable454) {
    throw new Error("Memorable 454/454 cannot be published as Table 3");
  }
}

/**
 * GraphRAG EventQA is banned as Table 3 (§0 / M18.4).
 * A note that says "not GraphRAG" is allowed. Using GraphRAG as retrieve/method is not.
 */
export function assertNotGraphRagEventQA(cfg: MabProtocolCfg | Record<string, unknown>): void {
  const exam = typeof cfg.exam === "string" ? cfg.exam : undefined;
  if (!claimsTable3(exam)) return;
  const rec = cfg as Record<string, unknown>;
  const methodish = [rec.method, rec.retrieve, rec.backend, rec.rag, rec.graph, rec.impl, rec.system]
    .map((x) => (x == null ? "" : typeof x === "string" ? x : JSON.stringify(x)))
    .join(" ");
  const rest = methodish.replace(/\b(?:do\s+)?not\s+graphrag\b/gi, "");
  const usesGraphRag = /\bgraphrag\b/i.test(rest) || /\bgraph[-_]?rag\b/i.test(rest);
  const eventqa = /eventqa/i.test(protocolBlob(cfg)) || rec.eventqa != null || rec.eventqa_length != null;
  if (usesGraphRag && eventqa) {
    throw new Error("GraphRAG EventQA cannot be published as Table 3");
  }
}

/** Throws if a Table 3 / MAB / MCC claim uses 64k, k=40, 6k FC, or a `label:` strip. */
export function assertMabProtocol(cfg: MabProtocolCfg): void {
  if (!claimsTable3(cfg.exam)) return;
  assertNotMemorableTable3(cfg);
  assertNotGraphRagEventQA(cfg);
  const errors: string[] = [];
  if (cfg.k !== 10) {
    errors.push(`k=${cfg.k ?? "missing"} is forbidden for Table 3 / MCC (must be 10, not 40)`);
  }
  const eventqa = parseLength(cfg.eventqa);
  if (eventqa !== 534_000) {
    errors.push(`EventQA ${cfg.eventqa ?? "missing"} is forbidden (must be 534k / 534000, not 64k / 64000)`);
  }
  const fc = parseLength(cfg.fc);
  if (cfg.fc !== undefined && fc !== 262_000) {
    errors.push(`FC ${cfg.fc} is forbidden (must be 262k, not 6k)`);
  }
  const sh = parseLength(cfg.sh);
  if (cfg.sh !== undefined && sh !== 197_000) {
    errors.push(`SH-QA ${cfg.sh} is forbidden (must be 197k)`);
  }
  const mh = parseLength(cfg.mh);
  if (cfg.mh !== undefined && mh !== 421_000) {
    errors.push(`MH-QA ${cfg.mh} is forbidden (must be 421k)`);
  }
  if (cfg.labelStrip === true) {
    errors.push("`label:` strip is forbidden");
  }
  if (errors.length) throw new Error(errors.join("; "));
}

export function runnerToCfg(raw: Record<string, unknown>): MabProtocolCfg {
  return {
    exam: typeof raw.exam === "string" ? raw.exam : undefined,
    k: typeof raw.k === "number" ? raw.k : undefined,
    eventqa: (raw.eventqa as number | string | undefined) ?? (raw.eventqa_length as number | string | undefined),
    fc: (raw.fc as number | string | undefined) ?? (raw.fc_length as number | string | undefined),
    sh: (raw.sh as number | string | undefined) ?? (raw.sh_length as number | string | undefined),
    mh: (raw.mh as number | string | undefined) ?? (raw.mh_length as number | string | undefined),
    labelStrip:
      typeof raw.labelStrip === "boolean"
        ? raw.labelStrip
        : typeof raw.label_strip === "boolean"
          ? raw.label_strip
          : undefined,
    claim: typeof raw.claim === "string" ? raw.claim : undefined,
    memorable:
      typeof raw.memorable === "number" || typeof raw.memorable === "string"
        ? raw.memorable
        : typeof raw.memorable_score === "number" || typeof raw.memorable_score === "string"
          ? raw.memorable_score
          : undefined,
    method: typeof raw.method === "string" ? raw.method : raw.method != null ? JSON.stringify(raw.method) : undefined,
    retrieve:
      typeof raw.retrieve === "string" ? raw.retrieve : raw.retrieve != null ? JSON.stringify(raw.retrieve) : undefined,
  };
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === "node_modules") continue;
      walkFiles(p, acc);
    } else {
      acc.push(p);
    }
  }
  return acc;
}

function collectTable3Cfgs(raw: unknown, acc: MabProtocolCfg[] = []): MabProtocolCfg[] {
  if (Array.isArray(raw)) {
    for (const x of raw) collectTable3Cfgs(x, acc);
    return acc;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const cfg = runnerToCfg(o);
    if (claimsTable3(cfg.exam)) acc.push(cfg);
    for (const v of Object.values(o)) collectTable3Cfgs(v, acc);
  }
  return acc;
}

function isAuditorExemptDoc(path: string): boolean {
  const name = basename(path);
  return name === "PROTOCOL.md" || name === "SOTA-GAP-REPORT.md";
}

function isExampleFixture(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name.includes("example") || name.includes("bad-protocol");
}

function isOverallWithoutAvgsFixture(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name.includes("overall") && name.includes("no-avgs");
}

function isResultsMd(path: string): boolean {
  return /RESULTS\.md$/i.test(basename(path));
}

function asBlob(src: string | Record<string, unknown>): string {
  return typeof src === "string" ? src : JSON.stringify(src);
}

/** True when a RESULTS blob / runner JSON claims Table 3 overall. */
export function claimsTable3Overall(src: string | Record<string, unknown>): boolean {
  if (src && typeof src === "object" && !Array.isArray(src)) {
    const exam = typeof src.exam === "string" ? src.exam : "";
    const hasOverallKey = Object.keys(src).some((k) => k.toLowerCase() === "overall");
    return /table\s*3/i.test(exam) && hasOverallKey;
  }
  const text = String(src);
  return /table\s*3/i.test(text) && /\boverall\b/i.test(text);
}

export function missingTable3CompetencyAvgs(src: string | Record<string, unknown>): string[] {
  const text = asBlob(src);
  return TABLE3_COMPETENCIES.filter((c) => {
    // Word-in-file is not an avg: "AR hops" must not satisfy AR.
    const tableRow = new RegExp(`\\|\\s*(?:Table 3\\s+)?${c}\\s*\\|[^\\n]*\\d`).test(text);
    const jsonKey = new RegExp(`"${c}"\\s*:\\s*-?\\d`).test(text);
    const labeled = new RegExp(`\\b${c}\\b\\s*[:=]\\s*-?\\d`).test(text);
    return !(tableRow || jsonKey || labeled);
  });
}

/**
 * Table 3 overall is the mean of AR / TTL / LRU / SF.
 * Throws if a claim publishes overall without all four competency averages.
 */
export function assertTable3OverallHasFourAvgs(src: string | Record<string, unknown>, label = "RESULTS"): void {
  if (!claimsTable3Overall(src)) return;
  const missing = missingTable3CompetencyAvgs(src);
  if (missing.length) {
    throw new Error(
      `${label} claims Table 3 overall without four competency avgs (missing ${missing.join(", ")}; need AR / TTL / LRU / SF)`,
    );
  }
}

describe("MAB Table 3 protocol sheet (Gate 0)", () => {
  const sheet = readFileSync(PROTOCOL_MD, "utf8");

  test("PROTOCOL.md matches Report lengths, k=10, 4o-mini, no label: strip", () => {
    expect(sheet).toMatch(/EventQA[^\n]*\*\*534k\*\*/);
    expect(sheet).toMatch(/FC \(FactCon\)[^\n]*\*\*262k\*\*/);
    expect(sheet).toMatch(/SH-QA[^\n]*\*\*197k\*\*/);
    expect(sheet).toMatch(/MH-QA[^\n]*\*\*421k\*\*/);
    expect(sheet).toMatch(/k=\*\*10\*\*/);
    expect(sheet).toMatch(/4o-mini/);
    expect(sheet).toMatch(/GPT-4o-mini/);
    expect(sheet).toMatch(/no `label:` strip/);
    expect(sheet).toMatch(/openMemory/);
    expect(sheet).toMatch(/memoryHookResponse/);
    expect(sheet).toMatch(/NOT 64k/);
    expect(sheet).toMatch(/NOT 40/);
    expect(sheet).toMatch(/LoCoMo-10 is regression only/);
    expect(sheet).toMatch(/Do not claim LoCoMo 92/);

    expect(parseLength("534k")).toBe(534000);
    expect(parseLength("262k")).toBe(262000);
    expect(parseLength("197k")).toBe(197000);
    expect(parseLength("421k")).toBe(421000);
  });

  test("A: official constants from PROTOCOL pass", () => {
    expect(() =>
      assertMabProtocol({
        exam: MAB_TABLE3.exam,
        k: MAB_TABLE3.k,
        eventqa: MAB_TABLE3.eventqa,
        fc: MAB_TABLE3.fc,
        sh: MAB_TABLE3.sh,
        mh: MAB_TABLE3.mh,
        labelStrip: MAB_TABLE3.labelStrip,
      }),
    ).not.toThrow();
    expect(() =>
      assertMabProtocol({ exam: "Table 3", k: 10, eventqa: "534k", fc: "262k", labelStrip: false }),
    ).not.toThrow();
  });

  test("B: Table 3 + k=40 + EventQA 64000 fails", () => {
    expect(() => assertMabProtocol({ exam: "Table 3", k: 40, eventqa: 64000 })).toThrow();
  });

  test("C: example fixture is rejected by assertMabProtocol", () => {
    const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    expect(basename(FIXTURE)).toMatch(/example|bad-protocol/);
    expect(raw.eventqa_length).toBe(64000);
    expect(raw.k).toBe(40);
    expect(raw.exam).toBe("Table 3");
    expect(() => assertMabProtocol(runnerToCfg(raw))).toThrow();
  });
});

describe("later runner 64k / k=40 must fail protocol", () => {
  test("example and bad-protocol JSON claiming Table 3 is rejected (nested too)", () => {
    const files = walkFiles(HERE).filter(
      (p) => p.endsWith(".json") && isExampleFixture(p) && !isOverallWithoutAvgsFixture(p),
    );
    expect(files.some((p) => p === FIXTURE)).toBe(true);
    expect(files.some((p) => p === FIXTURE_NESTED)).toBe(true);
    for (const p of files) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      const cfgs = collectTable3Cfgs(raw);
      expect(cfgs.length).toBeGreaterThan(0);
      for (const cfg of cfgs) expect(() => assertMabProtocol(cfg)).toThrow();
    }
  });

  test("example TypeScript runner config is rejected", () => {
    expect(badTable3.k).toBe(40);
    expect(badTable3.eventqa).toBe(64000);
    expect(() => assertMabProtocol(badTable3)).toThrow();
  });

  test("live runner JSON claiming Table 3 / MCC cannot use 64k or k=40", () => {
    const files: string[] = [];
    for (const p of walkFiles(HERE)) {
      const liveJson =
        (p.endsWith(".json") || p.endsWith(".run.json")) && !isExampleFixture(p) && !isAuditorExemptDoc(p);
      if (liveJson) files.push(p);
    }
    for (const p of files) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      } catch {
        continue;
      }
      for (const cfg of collectTable3Cfgs(raw)) assertMabProtocol(cfg);
    }
  });

  test("live ts/py/yml runner in this folder cannot claim Table 3 at 64k or k=40", () => {
    const banned = /k\s*[:=]\s*40/;
    const eventqa64 = /eventqa[_a-z]*\s*[:=]\s*"?64(?:000|k)/i;
    for (const p of walkFiles(HERE)) {
      if (isExampleFixture(p) || isAuditorExemptDoc(p)) continue;
      if (p.endsWith(".test.ts")) continue;
      if (!/\.(ts|py|ya?ml)$/.test(p)) continue;
      const src = readFileSync(p, "utf8");
      if (src.includes("not-product")) continue;
      if (!TABLE3_EXAM.test(src)) continue;
      expect(banned.test(src), `${basename(p)} claims a Table 3 exam but sets k=40`).toBe(false);
      expect(eventqa64.test(src), `${basename(p)} claims Table 3 EventQA 64k`).toBe(false);
    }
  });

  test("PROTOCOL.md and SOTA-GAP-REPORT.md documenting 64k as forbidden do not fail", () => {
    expect(readFileSync(PROTOCOL_MD, "utf8")).toMatch(/64k is FORBIDDEN/);
    const report = join(HERE, "SOTA-GAP-REPORT.md");
    expect(readFileSync(report, "utf8")).toMatch(/EventQA-64k vs Table 3 EventQA/);
    expect(isAuditorExemptDoc(PROTOCOL_MD)).toBe(true);
    expect(isAuditorExemptDoc(report)).toBe(true);
  });
});

describe("M15.4 protocol auditor", () => {
  test("k=40 cannot be published as MCC / Table 3", () => {
    expect(() => assertMabProtocol({ exam: "MCC", k: 40, eventqa: 534000 })).toThrow(/k=40/);
    expect(() => assertMabProtocol({ exam: "Table 3 MCC", k: 40, eventqa: "534k" })).toThrow();
    expect(() => assertMabProtocol({ exam: "Table 3", k: 40, eventqa: 534000 })).toThrow(/k=40/);
  });

  test("EventQA 64k / 64000 cannot be published as Table 3", () => {
    expect(() => assertMabProtocol({ exam: "Table 3", k: 10, eventqa: 64000 })).toThrow(/64k|64000|534/);
    expect(() => assertMabProtocol({ exam: "Table 3", k: 10, eventqa: "64k" })).toThrow();
    expect(() => assertMabProtocol({ exam: "MCC", k: 10, eventqa: 64_000 })).toThrow();
  });

  test("labelStrip true cannot be published as Table 3", () => {
    expect(() =>
      assertMabProtocol({
        exam: "Table 3",
        k: 10,
        eventqa: 534000,
        fc: 262000,
        sh: 197000,
        mh: 421000,
        labelStrip: true,
      }),
    ).toThrow(/label/);
  });

  test("M15.1 inject config is green (k=10, official lengths, no label strip)", () => {
    const raw = JSON.parse(readFileSync(join(HERE, "table3-inject.config.json"), "utf8")) as Record<string, unknown>;
    const cfg = runnerToCfg(raw);
    expect(cfg.exam).toMatch(/Table 3/i);
    expect(cfg.k).toBe(10);
    expect(parseLength(cfg.eventqa)).toBe(534000);
    expect(parseLength(cfg.fc)).toBe(262000);
    expect(parseLength(cfg.sh)).toBe(197000);
    expect(parseLength(cfg.mh)).toBe(421000);
    expect(cfg.labelStrip).toBe(false);
    expect(String(raw.api)).toMatch(/openMemory inject/);
    expect(String(raw.reader)).not.toMatch(/BrainMemory/i);
    expect(() => assertMabProtocol(cfg)).not.toThrow();
    expect(() => assertNotMemorableTable3(cfg)).not.toThrow();
  });

  test("TABLE3-RESULTS.md has no BrainMemory product column and is not Memorable 454/454", () => {
    const results = join(HERE, "TABLE3-RESULTS.md");
    expect(existsSync(results)).toBe(true);
    const src = readFileSync(results, "utf8");
    expect(src).toMatch(/openMemory/);
    expect(src).toMatch(/inject/i);
    expect(src).not.toMatch(/\|\s*BrainMemory\s*\|/i);
    expect(src).not.toMatch(/cortex:\s*false/);
    expect(src).not.toMatch(/\|\s*454\s*\/\s*454\s*\|/);
    expect(src).toMatch(/not BrainMemory/i);
    // Honesty/structure only — overall may be FAIL/missing or a number while M15.1 rewrites.
    expect(src).toMatch(/\*\*overall\*\*/i);
    expect(src).toMatch(/Competency averages|Leaves/i);
  });

  test("Memorable 454/454 is not Table 3", () => {
    const p = join(HERE, "fixtures", "bad-memorable-table3.example.json");
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    expect(String(raw.claim)).toMatch(/454\/454/);
    expect(String(raw.exam)).toBe("Table 3");
    expect(String(raw.note)).toMatch(/not MemoryAgentBench Table 3/i);
    expect(() => assertNotMemorableTable3(raw)).toThrow(/454/);
    expect(() => assertMabProtocol(runnerToCfg(raw))).toThrow();
    expect(() =>
      assertNotMemorableTable3({
        exam: "Table 3",
        k: 10,
        eventqa: 534000,
        fc: 262000,
        sh: 197000,
        mh: 421000,
        labelStrip: false,
        claim: "Memorable 454/454",
      }),
    ).toThrow(/454/);
    expect(() => assertNotMemorableTable3({ exam: "Table 3", memorable: 454 })).toThrow();
    expect(() => assertNotMemorableTable3({ exam: "Table 3", k: 10, eventqa: 534000 })).not.toThrow();
  });
});

describe("M16.1 Table 3 overall requires four competency avgs", () => {
  test("fixture claiming Table 3 overall without AR/TTL/LRU/SF is rejected", () => {
    const raw = JSON.parse(readFileSync(FIXTURE_OVERALL_NO_AVGS, "utf8")) as Record<string, unknown>;
    expect(basename(FIXTURE_OVERALL_NO_AVGS)).toMatch(/example/);
    expect(raw.exam).toBe("Table 3");
    expect(raw.overall).toBe(30.0);
    expect(raw.k).toBe(10);
    expect(raw.AR).toBeUndefined();
    expect(raw.TTL).toBeUndefined();
    expect(raw.LRU).toBeUndefined();
    expect(raw.SF).toBeUndefined();
    expect(claimsTable3Overall(raw)).toBe(true);
    expect(missingTable3CompetencyAvgs(raw)).toEqual(["AR", "TTL", "LRU", "SF"]);
    expect(() => assertMabProtocol(runnerToCfg(raw))).not.toThrow();
    expect(() => assertTable3OverallHasFourAvgs(raw, basename(FIXTURE_OVERALL_NO_AVGS))).toThrow(
      /four competency avgs/,
    );
    expect(() => assertTable3OverallHasFourAvgs(raw)).toThrow(/AR/);
  });

  test("Table 3 overall with AR / TTL / LRU / SF passes", () => {
    expect(() =>
      assertTable3OverallHasFourAvgs({
        exam: "Table 3",
        overall: 30.0,
        AR: 52.4,
        TTL: 32.4,
        LRU: 4.5,
        SF: 30.5,
      }),
    ).not.toThrow();
    const results = readFileSync(join(HERE, "TABLE3-RESULTS.md"), "utf8");
    expect(() => assertTable3OverallHasFourAvgs(results, "TABLE3-RESULTS.md")).not.toThrow();
  });

  test("live RESULTS/*.md claiming Table 3 overall must publish AR / TTL / LRU / SF", () => {
    const files = walkFiles(BENCHMARKS).filter((p) => isResultsMd(p) && !isExampleFixture(p) && !isAuditorExemptDoc(p));
    expect(files.some((p) => basename(p) === "TABLE3-RESULTS.md")).toBe(true);
    for (const p of files) {
      const src = readFileSync(p, "utf8");
      assertTable3OverallHasFourAvgs(src, p.slice(BENCHMARKS.length + 1));
    }
  });

  test("live JSON claiming Table 3 overall must publish AR / TTL / LRU / SF", () => {
    const files: string[] = [];
    for (const p of walkFiles(HERE)) {
      if (isExampleFixture(p) || isAuditorExemptDoc(p)) continue;
      if (!(p.endsWith(".json") || p.endsWith(".run.json"))) continue;
      files.push(p);
    }
    expect(files.some((p) => p === FIXTURE_OVERALL_NO_AVGS)).toBe(false);
    for (const p of files) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      } catch {
        continue;
      }
      assertTable3OverallHasFourAvgs(raw as Record<string, unknown>, basename(p));
      assertTable3OverallHasFourAvgs(readFileSync(p, "utf8"), basename(p));
    }
    expect(() =>
      assertTable3OverallHasFourAvgs(
        JSON.parse(readFileSync(FIXTURE_OVERALL_NO_AVGS, "utf8")) as Record<string, unknown>,
        basename(FIXTURE_OVERALL_NO_AVGS),
      ),
    ).toThrow(/four competency avgs/);
  });

  test("prose AR hops / SF assemble is not a Table 3 competency avg", () => {
    expect(() =>
      assertTable3OverallHasFourAvgs("Table 3 overall 99.0. ICL index is never called from AR hops or SF assembly."),
    ).toThrow(/four competency avgs/);
    expect(
      missingTable3CompetencyAvgs("Table 3 overall 99.0. ICL index is never called from AR hops or SF assembly."),
    ).toEqual(["AR", "TTL", "LRU", "SF"]);
  });

  test("M15-EVIDENCE.md is the frozen M15 lock; live TABLE3 may update EventQA after M18", () => {
    const ev = readFileSync(M15_EVIDENCE, "utf8");
    const t3 = readFileSync(join(HERE, "TABLE3-RESULTS.md"), "utf8");
    const lme = readFileSync(join(BENCHMARKS, "lme-v2/RESULTS.md"), "utf8");
    expect(t3).toMatch(/google\/gemma-4-31b-it/);
    expect(ev).toMatch(/google\/gemma-4-31b-it/);
    // Frozen M15 lock — do not retune this file when EventQA is re-run.
    expect(ev).toMatch(/Table 3 AR[^\n]*\*\*52\.4\*\*/);
    expect(ev).toMatch(/Table 3 TTL[^\n]*\*\*32\.4\*\*/);
    expect(ev).toMatch(/Table 3 LRU[^\n]*\*\*4\.5\*\*/);
    expect(ev).toMatch(/Table 3 SF[^\n]*\*\*30\.5\*\*/);
    expect(ev).toMatch(/Table 3 overall[^\n]*\*\*30\.0\*\*/);
    expect(lme).toMatch(/\*\*2\.7%\*\*/);
    expect(ev).toMatch(/2\.7%/);
    // Frozen M15 TB Δ. Live terminal-bench/RESULTS.md may be re-dated in M32.
    expect(ev).toMatch(/−20\.0 pp|-20\.0 pp/);
    expect(t3).toMatch(/\*\*k:\*\*\s*10|\*\*k\*\*.*10|k:\s*10/i);
    expect(t3).toMatch(/eventqa/i);
    expect(t3).toMatch(/534000/);
    expect(() => assertTable3OverallHasFourAvgs(t3, "TABLE3-RESULTS.md")).not.toThrow();
  });

  test("M15-EVIDENCE.md exists, matches PROTOCOL, NIM backbone, overall 30.0, 4 avgs, inject not BrainMemory", () => {
    expect(existsSync(M15_EVIDENCE)).toBe(true);
    const src = readFileSync(M15_EVIDENCE, "utf8");

    expect(src).toMatch(/EventQA[^\n]*534k/);
    expect(src).toMatch(/FC[^\n]*262k|262k/);
    expect(src).toMatch(/SH[^\n]*197k|197k/);
    expect(src).toMatch(/MH[^\n]*421k|421k/);
    expect(src).toMatch(/k=10/);
    expect(src).toMatch(/no `label:` strip|no label-strip|No label-strip/i);
    expect(src).toMatch(/openMemory/);
    expect(src).toMatch(/inject/i);
    expect(src).not.toMatch(/\|\s*BrainMemory\s*\|/i);
    expect(src).toMatch(/[Nn]ot.*BrainMemory|No BrainMemory/);

    expect(src).toMatch(/NVIDIA NIM/);
    expect(src).toMatch(/google\/gemma-4-31b-it/);
    expect(src).toMatch(/disclosed,\s*not 4o-mini|not 4o-mini/i);
    expect(src).toMatch(/2026-09-19/);

    expect(src).toMatch(/Table 3 AR[^\n]*\*\*52\.4\*\*/);
    expect(src).toMatch(/Table 3 TTL[^\n]*\*\*32\.4\*\*/);
    expect(src).toMatch(/Table 3 LRU[^\n]*\*\*4\.5\*\*/);
    expect(src).toMatch(/Table 3 SF[^\n]*\*\*30\.5\*\*/);
    expect(src).toMatch(/Table 3 overall[^\n]*\*\*30\.0\*\*/);
    expect(src).toMatch(/\bAR\b/);
    expect(src).toMatch(/\bTTL\b/);
    expect(src).toMatch(/\bLRU\b/);
    expect(src).toMatch(/\bSF\b/);
    expect(() => assertTable3OverallHasFourAvgs(src, "M15-EVIDENCE.md")).not.toThrow();

    expect(src).toMatch(/2\.7%/);
    expect(src).toMatch(/n=451|451/);
    expect(src).toMatch(/−20\.0 pp|-20\.0 pp/);
    expect(src).toMatch(/\bLOSS\b/);
    expect(src).toMatch(/M37/);
    expect(src).toMatch(/`missing`/);
    expect(src).toMatch(/extractDurable/);
    expect(src).toMatch(/max\(serial\)/);
    expect(src).toMatch(/silent inject/i);
    expect(src).toMatch(/not this exam/);
  });

  test("CI test.sh runs root src/*.test.ts as files, not bun test src filter", () => {
    const root = join(HERE, "..", "..");
    const sh = readFileSync(join(root, "scripts", "test.sh"), "utf8");
    expect(sh).toMatch(/find src -maxdepth 1/);
    expect(sh).toMatch(/src_tests/);
    expect(sh).toMatch(/^bun test "\$@" \$ignore \$dirs \$src_tests( \$script_tests)?$/m);
    expect(sh).not.toMatch(/find src packages apps benchmarks/);
    const names = readdirSync(join(root, "src")).filter((n) => n.endsWith(".test.ts"));
    expect(names).toContain("memory-lanes.test.ts");
    expect(names).toContain("assemble.test.ts");
    expect(names).toContain("memory-chunk.test.ts");
  });
});

const ROOT = join(HERE, "..", "..");
const SOTA_GAP = join(HERE, "SOTA-GAP-REPORT.md");
const GRAPH_FIXTURE = join(HERE, "fixtures", "bad-graphrag-eventqa.example.json");

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Block, line, and hash comments. Docstrings / `_icl_complete` are handled separately. */
export function stripAuditorComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^[ \t]*#.*$/gm, "")
    .replace(/[ \t]+#(?![\[{]).*$/gm, "");
}

/** Output-format normalize (`label: N` → `N`, DetQA JSON unwrap) is not stored-shot strip. */
function withoutIclCompleteBody(src: string): string {
  return src
    .replace(/(?:^|\n)def _icl_complete\b[\s\S]*?(?=\n(?:def |class |_[A-Z]))/g, "\n")
    .replace(/(?:^|\n)(?:export\s+)?function _icl_complete\b[\s\S]*?\n\}/g, "\n")
    .replace(/(?:^|\n)def _detqa_complete\b[\s\S]*?(?=\n(?:def |class |_[A-Z]))/g, "\n")
    .replace(/(?:^|\n)(?:export\s+)?function _detqa_complete\b[\s\S]*?\n\}/g, "\n");
}

/** True when live ingest/retrieve code deletes `label:` from stored/haystack/shot text. */
function isStoredLabelStripCode(src: string): boolean {
  const code = withoutIclCompleteBody(stripAuditorComments(src));
  const jsEmpty =
    /\.(?:replace|replaceAll)\s*\(\s*\/label:\\s\*[^/\n]*\/[gimsuy]*\s*,\s*(?:""|''|``)\s*\)/.test(code) ||
    /\.(?:replace|replaceAll)\s*\(\s*['"`]label:[^'"`]*['"`]\s*,\s*(?:""|''|``)\s*\)/.test(code);
  const pyEmpty =
    /re\.sub(?:n)?\s*\(\s*(?:r|rf|fr|R)?(?:'''|"""|['"])[^'"]*label:[^'"]*(?:'''|"""|['"])\s*,\s*(?:'''|"""|['"])(?:'''|"""|['"])/.test(
      code,
    );
  const pyOnStore = pyEmpty && /\b(?:packet|shot|haystack|text|blob|memory|content|pending)\b/.test(code);
  return jsEmpty || pyEmpty || pyOnStore;
}

/**
 * Strips comments, then throws if live product ingest/retrieve code removes
 * `label:` from stored text. `_icl_complete` (response-only) is not strip.
 */
export function assertNotStoredLabelStrip(src: string): void {
  if (isStoredLabelStripCode(src)) {
    throw new Error("stored-shot `label:` strip is forbidden");
  }
}

/**
 * Source auditor: fail if runner ingest deletes `label:` from stored shots.
 * Output normalize in `_icl_complete` is allowed. Tests/examples are skipped
 * at the call site (basename includes `example` or `.test.ts`).
 */
export function assertNoStoredLabelStrip(src: string, label = "runner"): void {
  if (isStoredLabelStripCode(src)) {
    throw new Error(`${label} strips \`label:\` from stored shots`);
  }
}

function isLabelStripExemptFile(path: string): boolean {
  const name = basename(path).toLowerCase();
  return name.includes("example") || name.endsWith(".test.ts");
}

/** GraphRAG *implementation* (package import / `new GraphRAG`). "not GraphRAG" comments are stripped. */
function isGraphRagImplementation(src: string): boolean {
  const code = codeWithoutComments(src).replace(/['"`][^'"`]*not\s+graphrag[^'"`]*['"`]/gi, "");
  return (
    /\bfrom\s+['"][^'"]*graphrag[^'"]*['"]/i.test(code) ||
    /\bimport\s*\(\s*['"][^'"]*graphrag[^'"]*['"]/i.test(code) ||
    /\brequire\s*\(\s*['"][^'"]*graphrag[^'"]*['"]/i.test(code) ||
    /\bnew\s+GraphRAG\b/.test(code)
  );
}

describe("M18.4 GraphRAG EventQA banned", () => {
  test("PROTOCOL.md / SOTA-GAP-REPORT still forbid GraphRAG EventQA and EventQA-64k as Table 3", () => {
    const protocol = readFileSync(PROTOCOL_MD, "utf8");
    const report = readFileSync(SOTA_GAP, "utf8");
    expect(protocol).toMatch(/EventQA-64k vs Table 3 EventQA/);
    expect(protocol).toMatch(/64k is FORBIDDEN/);
    expect(report).toMatch(/EventQA-64k vs Table 3 EventQA/);
    expect(report).toMatch(/GraphRAG EventQA/);
    expect(report).toMatch(/Do not GraphRAG novels/);
    expect(report).toMatch(/GraphRAG[^\n]*34\.4|EventQA:\s*GraphRAG\s*34\.4/);
    expect(protocol).toMatch(/Forbidden comparisons/);
  });

  test("live product retrieve is not a GraphRAG implementation", () => {
    const files = ["index.ts", "chunk-store.ts", "chunk-retrieve.ts"].map((n) => join(ROOT, "src", n));
    expect(existsSync(files[0]!)).toBe(true);
    for (const p of files) {
      if (!existsSync(p)) continue;
      expect(isGraphRagImplementation(readFileSync(p, "utf8")), basename(p)).toBe(false);
    }
  });

  test("table3-inject.config.json still EventQA 534000, k=10, no labelStrip, openMemory inject", () => {
    const raw = JSON.parse(readFileSync(join(HERE, "table3-inject.config.json"), "utf8")) as Record<string, unknown>;
    const cfg = runnerToCfg(raw);
    expect(cfg.exam).toMatch(/Table 3/i);
    expect(cfg.k).toBe(10);
    expect(parseLength(cfg.eventqa)).toBe(534000);
    expect(cfg.labelStrip).toBe(false);
    expect(String(raw.api)).toMatch(/openMemory inject/);
    expect(String(raw.api)).not.toMatch(/GraphRAG/i);
    expect(String(raw.method ?? "")).not.toMatch(/GraphRAG/i);
    expect(String(raw.retrieve ?? "")).not.toMatch(/GraphRAG/i);
    expect(() => assertMabProtocol(cfg)).not.toThrow();
    expect(() => assertNotGraphRagEventQA(cfg)).not.toThrow();
    expect(() => assertNotGraphRagEventQA(raw)).not.toThrow();
  });

  test("fixture claiming Table 3 EventQA via GraphRAG fails assertNotGraphRagEventQA", () => {
    const raw = JSON.parse(readFileSync(GRAPH_FIXTURE, "utf8")) as Record<string, unknown>;
    expect(basename(GRAPH_FIXTURE)).toMatch(/example/);
    expect(raw.exam).toBe("Table 3");
    expect(raw.method).toBe("GraphRAG");
    expect(raw.retrieve).toBe("GraphRAG");
    expect(parseLength(raw.eventqa as number)).toBe(534000);
    expect(raw.k).toBe(10);
    expect(() => assertNotGraphRagEventQA(raw)).toThrow(/GraphRAG EventQA/);
    expect(() => assertMabProtocol(runnerToCfg(raw))).toThrow(/GraphRAG EventQA/);
    expect(() =>
      assertNotGraphRagEventQA({
        exam: "Table 3",
        k: 10,
        eventqa: 534000,
        method: "GraphRAG",
      }),
    ).toThrow(/GraphRAG EventQA/);
    expect(() =>
      assertNotGraphRagEventQA({
        exam: "Table 3",
        k: 10,
        eventqa: 534000,
        note: "not GraphRAG",
      }),
    ).not.toThrow();
    expect(() => assertNotGraphRagEventQA({ exam: "LoCoMo-10", method: "GraphRAG", eventqa: 534000 })).not.toThrow();
  });
});

const FIXTURE_LABEL_STRIP = join(HERE, "fixtures", "bad-label-strip.example.ts");
const LIVE_LABEL_RUNNERS = ["inject-bridge.ts", "inject-agent.py", "run-table3-inject.py", "atoms.ts"] as const;
const ICL_SHOT = "The movie was great. label: 28";

function extractIclComplete(py: string): string {
  const m = py.match(/def _icl_complete\s*\(\s*text\s*,\s*agent\s*\)\s*:[\s\S]*?(?=\n(?:def |class |_[A-Z]))/);
  return m?.[0] ?? "";
}

describe("M19.4 label-strip auditor", () => {
  test("_icl_complete is output normalize, not stored-shot strip", () => {
    const py = readFileSync(join(HERE, "inject-agent.py"), "utf8");
    const fn = extractIclComplete(py);
    expect(fn).toMatch(/^def _icl_complete\(text, agent\):/m);
    expect(fn).toContain('if "icl" not in sub');
    expect(fn).toContain('re.match(r"^(?:label\\s*:\\s*)(.+)$", raw, re.I)');
    expect(fn).toMatch(/sub_dataset/);
    expect(fn).toMatch(/output format, not context/);
    expect(fn).toMatch(/stored shots keep `label:`/);
    expect(fn).not.toMatch(/\bobserve\b/);
    expect(fn).not.toMatch(/\bhaystack\b/);
    expect(fn).not.toMatch(/\bpacket\s*=/);
    expect(fn).not.toMatch(/re\.sub/);
    expect(py).toMatch(/k=10 always/);
    expect(py).toMatch(/EDEN_MEMORY_CAP", "10"/);
    expect(py).toMatch(/def retrieval_query/);
    expect(py).toMatch(/product isIclCue sees an ICL cue/);
    expect(py).toContain('q = f"{str(q).rstrip()}\\nlabel:"');
    expect(() => assertNotStoredLabelStrip(py)).not.toThrow();
    expect(() => assertNoStoredLabelStrip(py, "inject-agent.py")).not.toThrow();
  });

  test("assertNoStoredLabelStrip allows comments and response-only normalize", () => {
    const commented = [
      '// shot.replace(/label:\\s*\\d+/gi, "")',
      "# re.sub(r'label:\\s*\\d+', '', text)",
      '/* text.replace(/label:\\s*\\S+/gi, "") */',
      "const k = 10;",
    ].join("\n");
    expect(() => assertNoStoredLabelStrip(commented, "comments")).not.toThrow();
    expect(() => assertNotStoredLabelStrip(commented)).not.toThrow();

    const iclOnly = `
def _icl_complete(text, agent):
    raw = (text or "").strip()
    sub = str(getattr(agent, "sub_dataset", "")).lower()
    if "icl" not in sub:
        return raw
    match = re.match(r"^(?:label\\s*:\\s*)(.+)$", raw, re.I)
    if match:
        return match.group(1).strip()
    return raw
`;
    expect(() => assertNoStoredLabelStrip(iclOnly, "_icl_complete")).not.toThrow();
    expect(() => assertNotStoredLabelStrip(iclOnly)).not.toThrow();
  });

  test("fixture runner with labelStrip true / replace-before-store is rejected", () => {
    const src = readFileSync(FIXTURE_LABEL_STRIP, "utf8");
    expect(basename(FIXTURE_LABEL_STRIP)).toMatch(/example/);
    expect(isLabelStripExemptFile(FIXTURE_LABEL_STRIP)).toBe(true);
    expect(badLabelStrip.labelStrip).toBe(true);
    expect(badLabelStrip.k).toBe(10);
    expect(parseLength(badLabelStrip.eventqa)).toBe(534000);
    expect(() => assertMabProtocol(badLabelStrip)).toThrow(/label/);
    expect(() => assertNoStoredLabelStrip(src, basename(FIXTURE_LABEL_STRIP))).toThrow(/stored shots/);
    expect(() => assertNotStoredLabelStrip(src)).toThrow(/label/);
    expect(src).toContain('shot.replace(/label:\\s*\\d+/gi, "")');
  });

  test("atoms.ts splitIcl keeps label: ${m[2]}; inject-bridge observe does not strip", () => {
    const atoms = readFileSync(join(HERE, "atoms.ts"), "utf8");
    const live = withoutIclCompleteBody(stripAuditorComments(atoms));
    expect(live).toMatch(/label: \$\{m\[2\]\}/);
    expect(live).toMatch(/out\.push\(`\$\{utt\}\\nlabel: \$\{m\[2\]\}`\)/);
    const units = splitIcl("My disposable virtual card isn't working.\nlabel: 28\n");
    expect(units.some((u) => u.includes("label: 28"))).toBe(true);
    expect(units.some((u) => /disposable virtual card/.test(u))).toBe(true);

    const bridge = readFileSync(join(HERE, "inject-bridge.ts"), "utf8");
    const ingestLive = stripAuditorComments(bridge);
    expect(ingestLive).toMatch(/m\.observe\(\[\{ role: "user", content: t \}\]\)/);
    expect(ingestLive).not.toMatch(/\.replace\(\s*\/label:/);
    expect(ingestLive).not.toMatch(/re\.sub/);
    expect(() => assertNoStoredLabelStrip(bridge, "inject-bridge.ts")).not.toThrow();
    expect(() => assertNotStoredLabelStrip(atoms)).not.toThrow();
  });

  test("live runners do not strip stored label:", () => {
    for (const name of LIVE_LABEL_RUNNERS) {
      const p = join(HERE, name);
      expect(existsSync(p)).toBe(true);
      expect(isLabelStripExemptFile(p)).toBe(false);
      const src = readFileSync(p, "utf8");
      assertNoStoredLabelStrip(src, name);
      assertNotStoredLabelStrip(src);
    }
    const cfg = runnerToCfg(
      JSON.parse(readFileSync(join(HERE, "table3-inject.config.json"), "utf8")) as Record<string, unknown>,
    );
    expect(cfg.labelStrip).toBe(false);
    expect(readFileSync(PROTOCOL_MD, "utf8")).toMatch(/no `label:` strip/);
    expect(() => assertNotStoredLabelStrip(readFileSync(join(ROOT, "src", "index.ts"), "utf8"))).not.toThrow();
  });

  test("openMemory observe keeps label: 28 on stored shots", () => {
    const dir = mkdtempSync(join(tmpdir(), "eden-m194-"));
    try {
      const mem = openMemory({ dir });
      mem.observe([{ role: "user", content: ICL_SHOT }]);
      expect(mem.memories()[0]?.text).toContain("label: 28");
      expect(mem.memories()[0]?.text).toContain("The movie was great");
      const cue = "The movie was great. label:";
      const notes = mem.notesFor(cue, 10);
      const relevant = mem.relevant(cue, 10);
      const retrieved = [...notes, ...relevant].filter((r) => /movie was great/i.test(r.text));
      if (retrieved.length) {
        expect(retrieved.some((r) => /label:\s*28/.test(r.text))).toBe(true);
      }
      const injected = mem.inject([{ role: "user", content: cue }]);
      const pkt = (Array.isArray(injected) ? injected : [])
        .map((m) => (m && typeof m === "object" ? String((m as { content?: unknown }).content ?? "") : ""))
        .join("\n");
      if (/movie was great/i.test(pkt)) {
        expect(pkt).toMatch(/label:\s*28/);
      }
      expect(mem.memories().some((r) => /label:\s*28/.test(r.text))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M19.3 MCC artifact", () => {
  test("MCC-M19.md exists and lists five ICL leaves, k=10, no label strip", () => {
    const p = join(HERE, "MCC-M19.md");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toMatch(/icl_banking/);
    expect(src).toMatch(/icl_clinic/);
    expect(src).toMatch(/icl_nlu/);
    expect(src).toMatch(/icl_trec_coarse/);
    expect(src).toMatch(/icl_trec_fine/);
    expect(src).toMatch(/\*\*k:\*\*\s*10|k:\s*10|k=10/);
    expect(src).toMatch(/labelStrip:\*\*\s*false|no label-strip|no label strip/i);
    expect(src).not.toMatch(/labelStrip:\s*true/);
    expect(src).not.toMatch(/pending orchestrator/i);
    expect(src).toMatch(/\*\*71\*\*/);
    expect(src).toMatch(/\*\*83\*\*/);
    expect(src).toMatch(/\*\*75\*\*/);
    expect(src).toMatch(/\*\*33\*\*/);
    expect(src).toMatch(/\*\*6\*\*/);
    expect(src).toMatch(/\*\*53\.6\*\*/);
    expect(src).toMatch(/openMemory/);
    expect(src).not.toMatch(/\|\s*BrainMemory\s*\|/i);
  });
});

const TABLE3_RESULTS = join(HERE, "TABLE3-RESULTS.md");
const LME_RESULTS = join(BENCHMARKS, "lme-v2/RESULTS.md");
const TB_RESULTS = join(BENCHMARKS, "terminal-bench/RESULTS.md");
const TABLE3_CONFIG = join(HERE, "table3-inject.config.json");
const BACKBONE = "google/gemma-4-31b-it";

/** A line that denies, forbids, or conditions a claim. The claim itself is not published. */
function isDenialLine(line: string): boolean {
  return /\b(?:not|no|never|forbid(?:den)?|do not|don't|cannot|can't|only if|unless)\b/i.test(line);
}

function hasBrainMemoryColumn(src: string): boolean {
  return /\|\s*BrainMemory\s*\|/i.test(src);
}

function deniesBrainMemory(src: string): boolean {
  return /\b(?:not|no)\s+BrainMemory\b/i.test(src);
}

/** LoCoMo 92 on a line that is not a denial. That is an Eden/product score. */
function locomo92ProductLines(src: string): string[] {
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

function k40AsMccLines(src: string): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    if (/\bvs\b/i.test(line)) continue;
    const k40 = /\bk\s*=\s*40\b/.test(line) || /\bk\s*:\s*40\b/.test(line);
    if (!k40) continue;
    const at = line.search(/\bk\s*=\s*40\b|\bk\s*:\s*40\b/);
    if (at >= 0 && claimDenied(line, at, at + 4)) continue;
    if (k40 && /\b(?:MCC|Table\s*3)\b/i.test(line)) hits.push(line.trim());
    if (k40 && /\bk:\*\*\s*40\b|\*\*k:\*\*\s*40\b/.test(line)) hits.push(line.trim());
  }
  return hits;
}

/**
 * EventQA official length published as 64k, or 64k equated with 534k.
 * A forbidden-comparison line ("64k vs 534k") is not that claim.
 */
function eventqa64As534Lines(src: string): string[] {
  const hits: string[] = [];
  const len = leafCell(src, "eventqa", 0);
  if (len && /^(?:64k|64000)$/i.test(len)) hits.push(`eventqa length ${len}`);
  for (const line of src.split("\n")) {
    if (isDenialLine(line) || /\bvs\b/i.test(line)) continue;
    if (!/EventQA/i.test(line)) continue;
    const has64 = /\b(?:64k|64000)\b/i.test(line);
    const has534 = /\b534(?:k|000)\b/i.test(line);
    if (has64 && !has534) hits.push(line.trim());
    if (/\b(?:64k|64000)\b\s*(?:=|as)\s*534/i.test(line)) hits.push(line.trim());
  }
  return hits;
}

/** Leaf table cell by index: 0 length, 3 score. Empty cells are kept. */
function leafParts(src: string, id: string): string[] | undefined {
  const m = src.match(new RegExp(`^\\|\\s*${id}\\s*\\|([^\\n]*)$`, "im"));
  if (!m) return undefined;
  return m[1].split("|").map((s) => s.trim());
}

function leafCell(src: string, id: string, index: number): string | undefined {
  const parts = leafParts(src, id);
  if (!parts || parts.length <= index) return undefined;
  const cell = parts[index] ?? "";
  return cell.length ? cell : undefined;
}

function leafScore(src: string, id: string): number | undefined {
  const raw = leafCell(src, id, 3)?.replace(/\*/g, "").trim() ?? "";
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return undefined;
  return Number(raw);
}

/** First-column competency / overall score. `FAIL/missing` is a score cell, not a frozen number. */
function competencyCell(src: string, label: string): string {
  const m = src.match(new RegExp(`^\\|\\s*\\*{0,2}${label}\\*{0,2}\\s*\\|\\s*([^|]+)\\|`, "im"));
  return m?.[1]?.replace(/\*/g, "").trim() ?? "";
}

function competencyNumber(src: string, label: string): number | undefined {
  const cell = competencyCell(src, label);
  if (!/^-?\d+(?:\.\d+)?$/.test(cell)) return undefined;
  return Number(cell);
}

const AVG_CELL = /^(?:-?\d+(?:\.\d+)?|FAIL\/missing|FAIL|missing)$/i;

/**
 * Explicit `Label: yes|no`. `yes` wins if both appear, so a bar check still runs.
 * `4o-mini Table 3 SOTA: no` is not a claim.
 */
function labeledYesNo(src: string, label: string): "yes" | "no" | "absent" {
  const re = new RegExp(`${label}\\s*:\\s*\\**\\s*(yes|no)\\b`, "gi");
  const hits = [...src.matchAll(re)].map((m) => m[1]!.toLowerCase());
  if (hits.includes("yes")) return "yes";
  if (hits.includes("no")) return "no";
  return "absent";
}

const LABELED_SOTA_NO =
  /(?:4o-mini(?:\s+Table\s*3)?\s+SOTA|SF SOTA|selective forgetting SOTA|SOTA selective forgetting|trajectory SOTA|SOTA agent-trajectory|SOTA memory agent|Bar\s*(?:≥|>=)\s*50)\s*:\s*\**\s*no\b[^.]*/gi;

/** Phrase still present after labeled `: no` clauses are removed. `: no` is not a claim. */
function bareSotaClaim(src: string, phrase: RegExp): string[] {
  const hits: string[] = [];
  for (const line of src.split("\n")) {
    LABELED_SOTA_NO.lastIndex = 0;
    const stripped = line.replace(LABELED_SOTA_NO, "");
    phrase.lastIndex = 0;
    if (!phrase.test(stripped)) continue;
    if (isDenialLine(stripped)) continue;
    hits.push(line.trim());
  }
  return hits;
}

function readerIs4oMini(src: string): boolean {
  const head = src.split("\n").slice(0, 16).join("\n");
  if (/\bnot\s+\*{0,2}\s*GPT-4o-mini\b/i.test(head) || /\bnot\s+4o-mini\b/i.test(head)) return false;
  if (new RegExp(BACKBONE.replace("/", "\\/")).test(head)) return false;
  return /GPT-4o-mini|4o-mini/i.test(head);
}

function table3ProtocolHolds(src: string): boolean {
  const eventqa = leafCell(src, "eventqa", 0);
  const fcSh = leafCell(src, "fc_sh", 0);
  const fcMh = leafCell(src, "fc_mh", 0);
  return (
    /\*\*k:\*\*\s*10\b|\bk:\s*10\b/.test(src) &&
    /EventQA[^\n]*534(?:k|000)/i.test(src) &&
    /FC[^\n]*262(?:k|000)/i.test(src) &&
    (eventqa == null || /^(?:534000|534k)$/i.test(eventqa)) &&
    (fcSh == null || /^(?:262000|262k)$/i.test(fcSh)) &&
    (fcMh == null || /^(?:262000|262k)$/i.test(fcMh))
  );
}

function fourAvgNumbers(src: string): { ok: boolean; overall?: number } {
  const labels = ["AR", "TTL", "LRU", "SF"] as const;
  const nums = labels.map((l) => competencyNumber(src, l));
  const overall = competencyNumber(src, "overall");
  return { ok: nums.every((n) => n != null) && overall != null, overall };
}

/** Plan §9.2. Returns claim names whose numeric bar does not hold. */
export function sotaClaimsWithoutBars(table3: string, lme: string): string[] {
  const bad: string[] = [];
  const avgs = fourAvgNumbers(table3);
  const four = avgs.ok && table3ProtocolHolds(table3);
  const miniYes =
    labeledYesNo(table3, "4o-mini Table 3 SOTA") === "yes" ||
    bareSotaClaim(table3, /4o-mini(?:\s+Table\s*3)?\s+SOTA|SOTA memory agent/i).length > 0;
  const miniBar = four && avgs.overall != null && avgs.overall > 41.6 && readerIs4oMini(table3);
  if (miniYes && !miniBar) bad.push("4o-mini Table 3 SOTA");

  const fcSh = leafScore(table3, "fc_sh");
  const fcMh = leafScore(table3, "fc_mh");
  const sfYes =
    labeledYesNo(table3, "SF SOTA") === "yes" ||
    bareSotaClaim(table3, /SF SOTA|selective forgetting SOTA|SOTA selective forgetting/i).length > 0;
  if (sfYes && !(fcSh != null && fcMh != null && fcSh >= 82 && fcMh >= 27)) bad.push("SF SOTA");

  const bar50 = labeledYesNo(table3, "Bar\\s*(?:≥|>=)\\s*50");
  if (bar50 === "yes" && !(avgs.overall != null && avgs.overall >= 50)) bad.push("bar ≥50");

  const acc = lmeAcc(lme);
  const trajYes =
    labeledYesNo(lme, "trajectory SOTA") === "yes" ||
    labeledYesNo(table3, "trajectory SOTA") === "yes" ||
    bareSotaClaim(lme, /trajectory SOTA|SOTA agent-trajectory/i).length > 0 ||
    bareSotaClaim(table3, /trajectory SOTA|SOTA agent-trajectory/i).length > 0;
  if (trajYes && !(acc != null && acc >= 74.9)) bad.push("trajectory SOTA");
  return bad;
}

function lmeAcc(src: string): number | undefined {
  const m = src.match(/\|\s*\*\*acc\*\*\s*\|\s*\*\*([0-9.]+)\s*%\*\*/);
  if (!m) return undefined;
  return Number(m[1]);
}

function lmeCount(src: string, label: "n" | "correct"): number | undefined {
  const re = label === "n" ? /\|\s*n\s*\|\s*\*\*(\d+)\*\*/ : /\|\s*correct\s*\|\s*(\d+)\s*\|/;
  const m = src.match(re);
  return m ? Number(m[1]) : undefined;
}

type VerdictRow = { published: number; run: number; verdict: "WIN" | "LOSS" };

function verdictRow(src: string, label: string): VerdictRow | undefined {
  const re = new RegExp(
    `^\\|\\s*${label}[^|\\n]*\\|\\s*([0-9.]+)\\s*\\|\\s*([0-9.]+)\\s*\\|\\s*\\*\\*(WIN|LOSS)\\*\\*`,
    "im",
  );
  const m = src.match(re);
  if (!m) return undefined;
  const verdict = m[3] === "WIN" ? "WIN" : "LOSS";
  return { published: Number(m[1]), run: Number(m[2]), verdict };
}

describe("M37.4 honest claims", () => {
  const protocol = readFileSync(PROTOCOL_MD, "utf8");
  const table3 = readFileSync(TABLE3_RESULTS, "utf8");
  const lme = readFileSync(LME_RESULTS, "utf8");
  const tb = readFileSync(TB_RESULTS, "utf8");
  const config = JSON.parse(readFileSync(TABLE3_CONFIG, "utf8")) as Record<string, unknown>;

  test("backbone is named on the three RESULTS; PROTOCOL keeps 4o-mini as the paper default", () => {
    expect(table3).toContain(BACKBONE);
    expect(lme).toContain(BACKBONE);
    expect(tb).toContain(BACKBONE);
    expect(String(config.reader)).toBe(BACKBONE);
    expect(protocol).toMatch(/4o-mini reader/);
    expect(protocol).toMatch(/GPT-4o-mini/);
    expect(protocol).toMatch(/unless a different backbone is disclosed/);
  });

  test("no BrainMemory product column; Table 3, LME, and TB deny it", () => {
    for (const src of [protocol, table3, lme, tb]) {
      expect(hasBrainMemoryColumn(src)).toBe(false);
    }
    expect(deniesBrainMemory(table3)).toBe(true);
    expect(deniesBrainMemory(lme)).toBe(true);
    expect(deniesBrainMemory(tb)).toBe(true);
    expect(protocol).toMatch(/\*\*not\*\*\s+`BrainMemory\.retrieve`/);
    expect(JSON.stringify(config)).not.toMatch(/BrainMemory/);
    expect(String(config.api)).toMatch(/openMemory inject/);
  });

  test("Table 3 k is 10, EventQA 534k, FC 262k — not k=40-as-MCC, not 64k-as-534k", () => {
    expect(table3).toMatch(/\*\*k:\*\*\s*10\b/);
    expect(table3).toMatch(/EventQA[^\n]*534k/);
    expect(table3).toMatch(/FC[^\n]*262k/);
    expect(table3).toMatch(/MCC[^\n]*k=10/);
    expect(leafCell(table3, "eventqa", 0)).toMatch(/^(?:534000|534k)$/i);
    expect(leafCell(table3, "fc_sh", 0)).toMatch(/^(?:262000|262k)$/i);
    expect(leafCell(table3, "fc_mh", 0)).toMatch(/^(?:262000|262k)$/i);
    expect(k40AsMccLines(table3)).toEqual([]);
    expect(eventqa64As534Lines(table3)).toEqual([]);
    expect(config.k).toBe(10);
    expect(config.eventqa).toBe(534000);
    expect(config.fc).toBe(262000);
    expect(config.labelStrip).toBe(false);
    expect(() => assertMabProtocol(runnerToCfg(config))).not.toThrow();
    expect(protocol).toMatch(/k=\*\*10\*\*/);
    expect(protocol).toMatch(/NOT 40/);
    expect(protocol).toMatch(/NOT 64k/);
    expect(protocol).toMatch(/\*\*534k\*\*/);
    expect(k40AsMccLines(protocol)).toEqual([]);
    expect(eventqa64As534Lines(protocol)).toEqual([]);
  });

  test("LoCoMo 92 is not published as an Eden score", () => {
    expect(protocol).toMatch(/Do not claim LoCoMo 92/);
    expect(locomo92ProductLines("Eden LoCoMo 92 is the published score, not a draft").length).toBeGreaterThan(0);
    expect(locomo92ProductLines(protocol)).toEqual([]);
    expect(locomo92ProductLines(table3)).toEqual([]);
    expect(locomo92ProductLines(lme)).toEqual([]);
    expect(locomo92ProductLines(tb)).toEqual([]);
    expect(table3).toMatch(/LoCoMo 92[^\n]*not this exam/);
  });

  test("TABLE3 publishes four competency avg rows plus overall (score not frozen)", () => {
    for (const label of ["AR", "TTL", "LRU", "SF", "overall"]) {
      expect(competencyCell(table3, label), label).toMatch(AVG_CELL);
    }
    expect(table3).toMatch(/mean\(AR,\s*TTL,\s*LRU,\s*SF\)/);
    expect(table3).toMatch(/mean of AR\s*\/\s*TTL\s*\/\s*LRU\s*\/\s*SF/);
    const overall = competencyNumber(table3, "overall");
    if (overall != null) {
      expect(() => assertTable3OverallHasFourAvgs(table3, "TABLE3-RESULTS.md")).not.toThrow();
    }
  });

  test("LME names RAG 42.8 and AgentRunbook-C 74.9 with WIN or LOSS, not 74.9 as acc", () => {
    const acc = lmeAcc(lme);
    const n = lmeCount(lme, "n");
    const correct = lmeCount(lme, "correct");
    expect(acc).toBeDefined();
    expect(n).toBeGreaterThan(0);
    expect(correct).toBeDefined();
    expect(Math.abs(acc! - (correct! / n!) * 100)).toBeLessThan(0.15);
    const rag = verdictRow(lme, "RAG");
    const book = verdictRow(lme, "AgentRunbook-C");
    expect(rag?.published).toBe(42.8);
    expect(book?.published).toBe(74.9);
    expect(rag?.verdict).toMatch(/WIN|LOSS/);
    expect(book?.verdict).toMatch(/WIN|LOSS/);
    expect(Math.abs(rag!.run - acc!)).toBeLessThan(0.11);
    expect(Math.abs(book!.run - acc!)).toBeLessThan(0.11);
    expect(rag?.verdict).toBe(rag!.run >= 42.8 ? "WIN" : "LOSS");
    expect(book?.verdict).toBe(book!.run >= 74.9 ? "WIN" : "LOSS");
    const overall = rag?.verdict === "WIN" && book?.verdict === "WIN" ? "WIN" : "LOSS";
    expect(lme.match(/\*\*Overall:\s*(WIN|LOSS)\b/)?.[1]).toBe(overall);
    expect(lme).toMatch(/Do not invent 74\.9/);
  });

  test("TB is a locked subset, not the 89-task board, at k=5", () => {
    expect(tb).toMatch(/locked subset/i);
    expect(tb).toMatch(/not(?:\s+the)?\s+89-task|No 89-task/i);
    expect(tb).toMatch(/\|\s*public board \(89 tasks\)\s*\|\s*\*\*no\b/i);
    expect(tb).toMatch(/\|\s*k \(trials \/ task\)\s*\|\s*5\s*\|/);
    const nTasks = tb.match(/\|\s*n \(tasks\)\s*\|\s*(\d+)\s*\|/);
    expect(nTasks).not.toBeNull();
    expect(Number(nTasks![1])).toBeLessThan(89);
    expect(hasBrainMemoryColumn(tb)).toBe(false);
  });

  test("Plan §9.2 SOTA sentences stay off unless the numeric bars hold", () => {
    expect(sotaClaimsWithoutBars(table3, lme)).toEqual([]);
    const honestNo = [
      table3,
      "**Bar ≥50:** no. **SF SOTA:** no (need FC-SH ≥82 and FC-MH ≥27). **4o-mini Table 3 SOTA:** no (backbone is google/gemma-4-31b-it).",
      "trajectory SOTA only if acc ≥ 74.9",
    ].join("\n");
    expect(sotaClaimsWithoutBars(honestNo, lme)).toEqual([]);

    const below = [
      "**Reader / backbone:** NVIDIA NIM `google/gemma-4-31b-it` (**not** GPT-4o-mini).",
      "**k:** 10. EventQA 534k, FC 262k.",
      "| eventqa | 534000 | 1 | m | 1 | ok |",
      "| fc_sh | 262000 | 1 | m | 60.0 | ok |",
      "| fc_mh | 262000 | 1 | m | 12.0 | ok |",
      "| AR | 10 | x |",
      "| TTL | 10 | x |",
      "| LRU | 10 | x |",
      "| SF | 10 | x |",
      "| **overall** | **44.0** | mean(AR, TTL, LRU, SF) |",
      "**4o-mini Table 3 SOTA:** yes. **SF SOTA:** yes. **Bar ≥50:** yes.",
    ].join("\n");
    const lmeLoss = "| **acc** | **3.5%** |\n**trajectory SOTA:** yes";
    expect(sotaClaimsWithoutBars(below, lmeLoss)).toEqual([
      "4o-mini Table 3 SOTA",
      "SF SOTA",
      "bar ≥50",
      "trajectory SOTA",
    ]);

    const holds = [
      "**Reader / backbone:** GPT-4o-mini.",
      "**k:** 10. EventQA 534k, FC 262k.",
      "| eventqa | 534000 | 1 | m | 1 | ok |",
      "| fc_sh | 262000 | 1 | m | 82 | ok |",
      "| fc_mh | 262000 | 1 | m | 27 | ok |",
      "| AR | 52 | x |",
      "| TTL | 52 | x |",
      "| LRU | 52 | x |",
      "| SF | 52 | x |",
      "| **overall** | **52.0** | mean(AR, TTL, LRU, SF) |",
      "**4o-mini Table 3 SOTA:** yes. **SF SOTA:** yes. **Bar ≥50:** yes.",
    ].join("\n");
    const lmeWin = "| **acc** | **80.0%** |\n**trajectory SOTA:** yes";
    expect(sotaClaimsWithoutBars(holds, lmeWin)).toEqual([]);
  });
});
