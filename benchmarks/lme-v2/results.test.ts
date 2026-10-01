/**
 * M15.2 honesty gate + M26.4 verdict honesty. Does not re-run LME-V2. Does not green-wash accuracy.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTRUNBOOK_C_SMALL, DIAGNOSTIC_200, formatResults, M15_LOCK, RAG_SMALL, verdict } from "./run.ts";

const HERE = import.meta.dir;
const RESULTS = join(HERE, "RESULTS.md");
const RUNNER = join(HERE, "run.ts");
const GITIGNORE = join(HERE, "../../.gitignore");

function parseAccPct(src: string): number {
  const m = src.match(/\|\s*\*\*acc\*\*\s*\|\s*\*\*([0-9.]+)%\*\*/);
  if (!m) throw new Error("RESULTS missing **acc** cell");
  return Number(m[1]);
}

function parseVerdictRow(src: string, target: string): { published: number; run: number; verdict: "WIN" | "LOSS" } {
  const re = new RegExp(
    String.raw`\|\s*${target}\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*\*\*(WIN|LOSS)\*\*`,
  );
  const m = src.match(re);
  if (!m) throw new Error(`RESULTS missing verdict row: ${target}`);
  return { published: Number(m[1]), run: Number(m[2]), verdict: m[3] as "WIN" | "LOSS" };
}

/** Fail if RESULTS claims Overall WIN without acc ≥ 42.8, claims 74.9 without acc ≥ 74.9, or uses BrainMemory as the product column. */
function honestyProblems(src: string): string[] {
  const problems: string[] = [];
  if (/\|\s*BrainMemory\s*\|/i.test(src)) problems.push("BrainMemory product column");
  if (!/No BrainMemory/.test(src)) problems.push("missing No BrainMemory");
  if (!/\|\s*target\s*\|\s*published\s*\|\s*this run\s*\|\s*verdict\s*\|/.test(src)) {
    problems.push("missing verdict table");
  }
  let acc = NaN;
  try {
    acc = parseAccPct(src);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : "acc parse");
    return problems;
  }
  let rag: ReturnType<typeof parseVerdictRow>;
  let ar: ReturnType<typeof parseVerdictRow>;
  try {
    rag = parseVerdictRow(src, "RAG query→slice");
    ar = parseVerdictRow(src, "AgentRunbook-C");
  } catch (e) {
    problems.push(e instanceof Error ? e.message : "verdict parse");
    return problems;
  }
  if (rag.published !== RAG_SMALL) problems.push(`RAG published ${rag.published} ≠ ${RAG_SMALL}`);
  if (ar.published !== AGENTRUNBOOK_C_SMALL) problems.push(`AgentRunbook-C published ${ar.published} ≠ ${AGENTRUNBOOK_C_SMALL}`);
  if (Math.abs(rag.run - acc) > 0.05) problems.push(`RAG this-run ${rag.run} ≠ acc ${acc}`);
  if (Math.abs(ar.run - acc) > 0.05) problems.push(`AgentRunbook-C this-run ${ar.run} ≠ acc ${acc}`);
  const overallWin = /Overall: WIN/.test(src);
  if (overallWin && acc < RAG_SMALL) problems.push(`Overall WIN without acc ≥ ${RAG_SMALL} (acc=${acc})`);
  if (overallWin && acc < AGENTRUNBOOK_C_SMALL) {
    problems.push(`Overall WIN without acc ≥ ${AGENTRUNBOOK_C_SMALL} (acc=${acc})`);
  }
  if (overallWin && (rag.verdict !== "WIN" || ar.verdict !== "WIN")) {
    problems.push("Overall WIN without both row WIN");
  }
  if ((ar.verdict === "WIN" || Math.abs(ar.run - AGENTRUNBOOK_C_SMALL) < 0.05) && acc < AGENTRUNBOOK_C_SMALL) {
    problems.push(`claims ${AGENTRUNBOOK_C_SMALL} without acc ≥ ${AGENTRUNBOOK_C_SMALL} (acc=${acc})`);
  }
  if (/\*\*No files\.\*\*/.test(src)) problems.push("diagnosis says No files");
  return problems;
}

function assertResultsHonesty(src: string) {
  expect(honestyProblems(src)).toEqual([]);
}

describe("M26.2 LME-V2 Small RESULTS honesty", () => {
  test("RESULTS exists, names inject not BrainMemory, n=451, vs 42.8/74.9, WIN or LOSS written", () => {
    expect(existsSync(RESULTS)).toBe(true);
    const src = readFileSync(RESULTS, "utf8");
    expect(src).toMatch(/openMemory/);
    expect(src).toMatch(/inject/);
    expect(src).not.toMatch(/\|\s*BrainMemory\s*\|/i);
    expect(src).toMatch(/No BrainMemory/);
    expect(src).toMatch(/\bn\b[\s\S]*\*\*451\*\*/);
    expect(src).toMatch(/\b451\b/);
    expect(src).toMatch(/# M26 LME-V2 Small RESULTS/);
    expect(src).toMatch(/\*\*Wave:\*\*\s*M26\.2/);
    expect(src).toMatch(
      /\*\*M37 recert:\*\* \d{4}-\d{2}-\d{2} — (?:same protocol; )?live n=451 after M16–M36; trajectory SOTA only if acc ≥ 74\.9/,
    );
    expect(src).toMatch(/\*\*ISO date:\*\*/);
    expect(src).toMatch(/Report:\*\*\s*§11\.1|\*\*Report:\*\*\s*§11\.1/);
    expect(src).toMatch(/\| target \| published \| this run \| verdict \|/);
    expect(src).toMatch(/RAG query→slice/);
    expect(src).toMatch(/42\.8/);
    expect(src).toMatch(/AgentRunbook-C/);
    expect(src).toMatch(/74\.9/);
    expect(src).toMatch(/\*\*(WIN|LOSS)\*\*/);
    expect(src).toMatch(/Overall: (WIN|LOSS)|Overall:\*\* pending live|Overall:\*\* pending|\*\*Overall:\*\* pending live|\*\*Overall:\*\* pending/);
    expect(src).not.toMatch(/Do not invent 2\.7/);
    expect(src).not.toMatch(/\*\*acc\*\*[^\n]*74\.9/);
  });

  test("gold_in_packet denominator is phrase-match of n, not a sample; empty packets honest; screenshots skipped named", () => {
    const src = readFileSync(RESULTS, "utf8");
    expect(src).toMatch(/gold_in_packet hit \/ phrase-match denom/);
    expect(src).toMatch(/not a sample/);
    expect(src).toMatch(/llm\/mc are N\/A|N\/A llm\/mc|llm\/mc N\/A/);
    expect(src).toMatch(/junk always-on is not assumed/);
    expect(src).toMatch(/non-empty ≠ gold/);
    expect(src).toMatch(/screenshots[\s\S]*\*\*skipped\*\*/i);
    expect(src).toMatch(/google\/gemma-4-31b-it/);
    expect(src).not.toMatch(/\*\*Reader:\*\*[^\n]*4o-mini/);
    expect(src).not.toMatch(/\*\*acc\*\*[^\n]*74\.9/);
    expect(src).toMatch(/2\.7% @451/);
    expect(src).toMatch(/~3\.5% @200/);
    expect(src).toMatch(/## vs M15 \/ diagnostic/);
    expect(src).toMatch(/## M15 lock appendix/);
  });

  test("M25 screenshot policy: 29 gotchas skipped named, not 74.9", () => {
    const src = readFileSync(RESULTS, "utf8");
    expect(src).toMatch(/## M25 screenshot policy \(2026-09-20\)/);
    expect(src).toMatch(/29 `errors-gotchas` questions are multimodal/);
    expect(src).toMatch(/\*\*skipped \(named LOSS\)\*\*/);
    expect(src).toMatch(/not downloaded, not stored, and not replayed by sleep/);
    expect(src).toMatch(/That is not AgentRunbook-C \*\*74\.9\*\*/);
    expect(src).toMatch(/Do not treat any current acc as comparable to 74\.9 on multimodal gotchas/);
    expect(src).toMatch(/Report §4\.12/);
    const runner = readFileSync(RUNNER, "utf8");
    expect(runner).toMatch(/## M25 screenshot policy \(2026-09-20\)/);
    expect(runner).toMatch(/29 \\`errors-gotchas\\` questions are multimodal/);
    expect(runner).toMatch(/\*\*skipped \(named LOSS\)\*\*/);
    expect(runner).toMatch(/That is not AgentRunbook-C \*\*\$\{AGENTRUNBOOK_C_SMALL\}\*\*/);
    expect(runner).toMatch(/Do not treat any current acc as comparable to \$\{AGENTRUNBOOK_C_SMALL\} on multimodal gotchas/);
  });

  test("runner product path is openMemory inject, not BrainMemory or memory_search", () => {
    const src = readFileSync(RUNNER, "utf8");
    expect(src).toMatch(/from ["']\.\.\/\.\.\/src\/index\.ts["']/);
    expect(src).toMatch(/\bopenMemory\b/);
    expect(src).toMatch(/\.inject\(/);
    expect(src).not.toMatch(/from ["'][^"']*brain-memory[^"']*["']/);
    expect(src).not.toMatch(/\bnew\s+BrainMemory\s*\(/);
    expect(src).not.toMatch(/\bmemory_search\s*\(/);
    expect(src).toMatch(/[Nn]o[^\n]*memory_search/);
    expect(src).toMatch(/google\/gemma-4-31b-it/);
    expect(src).not.toMatch(/gpt-4o-mini/);
  });

  test("formatResults schema: ISO date, n/correct/acc, gold denom, empty honest, vs M15 2.7% @451 and ~3.5% @200 — acc cell is this run", () => {
    const md = formatResults({
      date: "2026-09-20",
      bun: "1.3.13",
      nim_model: "google/gemma-4-31b-it",
      n: 451,
      n_correct: 45,
      acc: 0.10,
      reader_ok: true,
      reader_note: "ok",
      gold_in_packet: { n: 226, hit: 100 },
      reader_answered: 440,
      inject: [10, 20, 30],
      reader: [100, 200, 300],
      query: [110, 220, 330],
      packet_empty: 12,
      domains: [],
      by_type: { procedure: { n: 74, correct: 8 } },
      ingested: {
        questions: 451,
        unique_traj: 200,
        screenshots: "skipped",
        full_tokens_claimed: "~25M tokens",
        what_ran: "test ingest",
      },
      v: verdict(10),
      experience_files: 0,
    });
    expect(md).toMatch(/\*\*Date:\*\*\s*2026-09-20/);
    expect(md).toMatch(/\*\*ISO date:\*\*\s*2026-09-20/);
    expect(md).toMatch(/\*\*Wave:\*\*\s*M26\.2/);
    expect(md).toContain(
      "**M37 recert:** 2026-09-20 — live n=451 after M16–M36; trajectory SOTA only if acc ≥ 74.9",
    );
    expect(md).toMatch(/§11\.1/);
    expect(md).toMatch(/\|\s*n\s*\|\s*\*\*451\*\*/);
    expect(md).toMatch(/\|\s*correct\s*\|\s*45\s*\|/);
    expect(md).toMatch(/\|\s*\*\*acc\*\*\s*\|\s*\*\*10\.0%\*\*/);
    expect(md).not.toMatch(/\|\s*\*\*acc\*\*\s*\|\s*\*\*2\.7%\*\*/);
    expect(md).toMatch(/gold_in_packet hit \/ phrase-match denom \| 100 \/ 226 of 451/);
    expect(md).toMatch(/not a sample/);
    expect(md).toMatch(/llm\/mc are N\/A/);
    expect(md).toMatch(/empty packets \| 12 \/ 451/);
    expect(md).toMatch(/junk always-on is not assumed/);
    expect(md).not.toMatch(/junk always-on; not a retrieval win/);
    expect(md).toContain(`${M15_LOCK.acc_pct}% @${M15_LOCK.n}`);
    expect(md).toContain(`${DIAGNOSTIC_200.acc_pct}% @${DIAGNOSTIC_200.n}`);
    expect(md).toMatch(/## vs M15 \/ diagnostic/);
    expect(md).toMatch(/## M15 lock appendix/);
    expect(md).toMatch(/\| RAG query→slice \| 42\.8 \| 10\.0 \| \*\*LOSS\*\*/);
    expect(md).toMatch(/Do not invent 74\.9/);
    expect(md).not.toMatch(/\*\*Reader:\*\*[^\n]*4o-mini/);
    expect(md).not.toMatch(/gpt-4o-mini/);
  });
});

describe("M25.3 screenshot policy RESULTS honesty", () => {
  test("RESULTS names 29 gotchas multimodal skipped (or captions) and does not claim 74.9 for text-only", () => {
    expect(existsSync(RESULTS)).toBe(true);
    const src = readFileSync(RESULTS, "utf8");
    expect(src).toMatch(/M25/);
    expect(src).toMatch(/29/);
    expect(src).toMatch(/gotchas/i);
    expect(src).toMatch(/skipped|caption/i);
    expect(src).toMatch(/multimodal|screenshot/i);
    expect(src).toMatch(/Do not invent 74\.9|not AgentRunbook-C \*\*74\.9\*\*|Do not treat[\s\S]{0,120}74\.9/i);
    expect(src).not.toMatch(/\*\*acc\*\*[^\n]*74\.9/);
    expect(src).not.toMatch(/text-only[^\n]{0,80}74\.9%/);
  });
});

describe("M26.3 latency — in-process inject, not a 60ms CLI", () => {
  const WRAP = join(HERE, "../../packages/wrap/src/proxy.ts");
  const KNOW = join(HERE, "../../packages/wrap/src/know-inject.ts");
  const HOOK = join(HERE, "../../packages/cli/src/memory-hook.ts");

  function noMemoryCliSpawn(src: string) {
    expect(src).not.toMatch(/\bspawn(?:Sync)?\s*\(/);
    expect(src).not.toMatch(/\bexecFile(?:Sync)?\s*\(/);
    expect(src).not.toMatch(/\bexecSync\s*\(/);
    expect(src).not.toMatch(/\bBun\.spawn\b/);
    expect(src).not.toMatch(/from ["']node:child_process["']/);
  }

  test("LME runner measures inject_ms separately from reader_ms and does not spawn a memory CLI", () => {
    const src = readFileSync(RUNNER, "utf8");
    expect(src).toMatch(/const tInject = Date\.now\(\)/);
    expect(src).toMatch(/handle\.mem\.inject\(/);
    expect(src).toMatch(/const inject_ms = Date\.now\(\) - tInject/);
    expect(src).toMatch(/reader_ms = r\.ms/);
    expect(src).toMatch(/query_ms: inject_ms \+ reader_ms/);
    expect(src).toMatch(/inject_p50: percentile\(rows\.map\(\(r\) => r\.inject_ms\), 50\)/);
    expect(src).toMatch(/inject_p95: percentile\(rows\.map\(\(r\) => r\.inject_ms\), 95\)/);
    expect(src).toMatch(/reader_p50: percentile\(rows\.map\(\(r\) => r\.reader_ms\), 50\)/);
    noMemoryCliSpawn(src);
    expect(src).toMatch(/## M26\.3 latency/);
    expect(src).toMatch(/Wrap inject is in-process \\`AgentMemory\.inject\\`, not a 60ms CLI/);
    expect(src).toMatch(/M6\.4 remains the small-store baseline/);
    expect(src).toMatch(/LME p95 is haystack retrieve, not a CLI gate/);
    expect(src).toMatch(/0\.048/);
    expect(src).toMatch(/0\.133/);
    expect(src).toMatch(/M15 LME \| 82 \| 286/);
    expect(src).toMatch(/Different fixtures/);
  });

  test("wrap proxy / Anthropic / hook inject are in-process; no spawn/execFile of a memory CLI", () => {
    const proxy = readFileSync(WRAP, "utf8");
    expect(proxy).toMatch(/injectBodyThenObserveTools\(processMemory\(\)/);
    expect(proxy).toMatch(/from ["']\.\.\/\.\.\/\.\.\/src\/index["']/);
    noMemoryCliSpawn(proxy);

    const know = readFileSync(KNOW, "utf8");
    expect(know).toMatch(/export function withKnowFactsAnthropic/);
    expect(know).toMatch(/const mem = processMemory\(\)/);
    expect(know).toMatch(/mem\.inject\(/);
    expect(know).toMatch(/injectBodyThenObserveTools\(processMemory\(\), body\)/);
    noMemoryCliSpawn(know);

    const hook = readFileSync(HOOK, "utf8");
    expect(hook).toMatch(/export function memoryHookResponse/);
    expect(hook).toMatch(/mem\.inject\(\[\{ role: "user", content: prompt \}\]\)/);
    noMemoryCliSpawn(hook);
  });

  test("RESULTS.md M26.3 latency section vs M15 82/286 and M6.4 0.048/0.133", () => {
    const src = readFileSync(RESULTS, "utf8");
    expect(src).toMatch(/## M26\.3 latency/);
    expect(src).toMatch(/this LME run \| [\d.]+ \| [\d.]+/);
    expect(src).toMatch(/M15 LME \| 82 \| 286/);
    expect(src).toMatch(/M6\.4 \| 0\.048 \| 0\.133/);
    expect(src).toMatch(/5-message fixture/);
    expect(src).toMatch(/Different fixtures/);
    expect(src).toMatch(/Wrap inject is in-process `AgentMemory\.inject`, not a 60ms CLI/);
    expect(src).toMatch(/M6\.4 remains the small-store baseline/);
    expect(src).toMatch(/LME p95 is haystack retrieve, not a CLI gate/);
  });
});

describe("M26.4 verdict honesty — Plan §9.2", () => {
  function stubMd(accPct: number, extra?: { experience_files?: number; overall?: "WIN" | "LOSS" }) {
    const acc = accPct / 100;
    const v = verdict(accPct);
    return formatResults({
      date: "2026-09-20",
      bun: "1.3.13",
      nim_model: "google/gemma-4-31b-it",
      n: 451,
      n_correct: Math.round(451 * acc),
      acc,
      reader_ok: true,
      reader_note: "ok",
      gold_in_packet: { n: 226, hit: 73 },
      reader_answered: 421,
      inject: [82],
      reader: [1365],
      query: [1498],
      packet_empty: 0,
      domains: [],
      by_type: { procedure: { n: 74, correct: 4 } },
      ingested: {
        questions: 451,
        unique_traj: 200,
        screenshots: "skipped",
        full_tokens_claimed: "~25M tokens",
        what_ran: "truncated text observe",
      },
      v: extra?.overall ? { ...v, overall: extra.overall } : v,
      experience_files: extra?.experience_files,
    });
  }

  test("verdict: Overall WIN only if both RAG 42.8 and AgentRunbook-C 74.9 WIN", () => {
    expect(verdict(2.7)).toEqual({ vs_rag: "LOSS", vs_agentrunbook_c: "LOSS", overall: "LOSS" });
    expect(verdict(42.8)).toEqual({ vs_rag: "WIN", vs_agentrunbook_c: "LOSS", overall: "LOSS" });
    expect(verdict(50)).toEqual({ vs_rag: "WIN", vs_agentrunbook_c: "LOSS", overall: "LOSS" });
    expect(verdict(74.8)).toEqual({ vs_rag: "WIN", vs_agentrunbook_c: "LOSS", overall: "LOSS" });
    expect(verdict(74.9)).toEqual({ vs_rag: "WIN", vs_agentrunbook_c: "WIN", overall: "WIN" });
    expect(verdict(80)).toEqual({ vs_rag: "WIN", vs_agentrunbook_c: "WIN", overall: "WIN" });
  });

  test("formatResults table: this-run is acc, published 42.8/74.9, no invented 74.9", () => {
    const loss = stubMd(2.7);
    expect(loss).toMatch(/\| RAG query→slice \| 42\.8 \| 2\.7 \| \*\*LOSS\*\*/);
    expect(loss).toMatch(/\| AgentRunbook-C \| 74\.9 \| 2\.7 \| \*\*LOSS\*\*/);
    expect(loss).toMatch(/Overall: LOSS/);
    expect(loss).toMatch(/Do not invent 74\.9/);
    expect(loss).not.toMatch(/\| AgentRunbook-C \| 74\.9 \| 74\.9 \|/);
    expect(loss).not.toMatch(/\|\s*BrainMemory\s*\|/i);
    assertResultsHonesty(loss);

    const mid = stubMd(42.8);
    expect(mid).toMatch(/\| RAG query→slice \| 42\.8 \| 42\.8 \| \*\*WIN\*\*/);
    expect(mid).toMatch(/\| AgentRunbook-C \| 74\.9 \| 42\.8 \| \*\*LOSS\*\*/);
    expect(mid).toMatch(/Overall: LOSS/);
    expect(mid).not.toMatch(/Overall: WIN/);
    assertResultsHonesty(mid);

    const sota = stubMd(74.9);
    expect(sota).toMatch(/\| RAG query→slice \| 42\.8 \| 74\.9 \| \*\*WIN\*\*/);
    expect(sota).toMatch(/\| AgentRunbook-C \| 74\.9 \| 74\.9 \| \*\*WIN\*\*/);
    expect(sota).toMatch(/Overall: WIN/);
    assertResultsHonesty(sota);
  });

  test("diagnosis: files exist / silent inject slices; never **No files.**", () => {
    const empty = stubMd(2.7, { experience_files: 0 });
    expect(empty).toMatch(/\*\*Files exist\.\*\*/);
    expect(empty).toMatch(/silent `\[episode\]` slices/);
    expect(empty).toMatch(/Still \*\*LOSS\*\* vs RAG 42\.8 and AgentRunbook-C 74\.9/);
    expect(empty).toMatch(/Screenshots skipped \(named\)/);
    expect(empty).toMatch(/Truncation/);
    expect(empty).toMatch(/\*\*k\.\*\*/);
    expect(empty).toMatch(/Not 4o-mini/);
    expect(empty).not.toMatch(/\*\*No files\.\*\*/);

    const landed = stubMd(2.7, { experience_files: 200 });
    expect(landed).toMatch(/wrote 200 trajectory files/);
    expect(landed).toMatch(/silent `\[episode\]` slices/);
    expect(landed).not.toMatch(/\*\*No files\.\*\*/);
  });

  test("RESULTS.md honesty: no Overall WIN under 42.8, no invented 74.9, no BrainMemory column", () => {
    const src = readFileSync(RESULTS, "utf8");
    assertResultsHonesty(src);
    const acc = parseAccPct(src);
    if (/Overall: WIN/.test(src)) {
      expect(acc).toBeGreaterThanOrEqual(42.8);
    }
    const ar = parseVerdictRow(src, "AgentRunbook-C");
    if (ar.verdict === "WIN" || Math.abs(ar.run - 74.9) < 0.05) {
      expect(acc).toBeGreaterThanOrEqual(74.9);
    }
    expect(src).not.toMatch(/\|\s*BrainMemory\s*\|/i);
    expect(src).toMatch(/\*\*Files exist\.\*\*/);
    expect(src).not.toMatch(/\*\*No files\.\*\*/);
  });

  test("CI honesty does not require gitignored last-run.json", () => {
    const gitignore = readFileSync(GITIGNORE, "utf8");
    expect(gitignore).toMatch(/^benchmarks\/lme-v2\/last-run\.json$/m);
    const testSrc = readFileSync(join(HERE, "results.test.ts"), "utf8");
    expect(testSrc).not.toMatch(/readFileSync\(\s*LAST_RUN/);
    expect(testSrc).not.toMatch(/JSON\.parse\(\s*readFileSync\(\s*LAST_RUN/);
    expect(testSrc).not.toMatch(/const LAST_RUN\s*=/);
    // Official record is committed RESULTS.md. last-run.json is a local runner dump.
    assertResultsHonesty(readFileSync(RESULTS, "utf8"));
  });

  test("honesty gate fails a forged Overall WIN at 2.7 and a forged 74.9 this-run", () => {
    const fakeWin = stubMd(2.7, { overall: "WIN" });
    expect(fakeWin).toMatch(/Overall: WIN/);
    expect(parseAccPct(fakeWin)).toBeLessThan(42.8);
    expect(honestyProblems(fakeWin).some((p) => /Overall WIN without acc/.test(p))).toBe(true);

    const fake749 = stubMd(2.7).replace(
      /\| AgentRunbook-C \| 74\.9 \| 2\.7 \| \*\*LOSS\*\*/,
      "| AgentRunbook-C | 74.9 | 74.9 | **WIN** |",
    );
    expect(honestyProblems(fake749).some((p) => /74\.9/.test(p))).toBe(true);

    const brainCol = stubMd(2.7).replace(
      "| target | published | this run | verdict |",
      "| target | published | this run | BrainMemory |",
    );
    expect(honestyProblems(brainCol).some((p) => /BrainMemory/.test(p))).toBe(true);
  });

  test("runner formatResults always emits the M26 verdict table", () => {
    const src = readFileSync(RUNNER, "utf8");
    expect(src).toMatch(/\| target \| published \| this run \| verdict \|/);
    expect(src).toMatch(/RAG query→slice \| \$\{RAG_SMALL\} \| \$\{pct\(accPct\)\} \| \*\*\$\{args\.v\.vs_rag\}\*\*/);
    expect(src).toMatch(/AgentRunbook-C \| \$\{AGENTRUNBOOK_C_SMALL\} \| \$\{pct\(accPct\)\} \| \*\*\$\{args\.v\.vs_agentrunbook_c\}\*\*/);
    expect(src).toMatch(/Overall WIN only if both/);
    expect(src).not.toMatch(/\*\*No files\.\*\*/);
    expect(src).toMatch(/\*\*Files exist\.\*\*/);
  });
});

describe("M26.1 runner honesty — smoke ≠ official, files ingest, no skip-all", () => {
  test("LME_LIMIT or n<451 writes RESULTS.smoke.md; only n=451 writes RESULTS.md + last-run.json", () => {
    const src = readFileSync(RUNNER, "utf8");
    expect(src).toMatch(/export function isOfficialRun/);
    expect(src).toMatch(/export function resultsPathFor/);
    expect(src).toMatch(/export function shouldWriteLastRun/);
    expect(src).toMatch(/RESULTS_SMOKE_PATH/);
    expect(src).toMatch(/const outPath = resultsPathFor\(n\)/);
    expect(src).toMatch(/if \(shouldWriteLastRun\(n\)\)/);
    expect(src).not.toMatch(
      /writeFileSync\(\s*LAST_RUN_PATH[\s\S]{0,160}LME_LIMIT\s*\?\s*join\(\s*HOLD_DIR,\s*"RESULTS\.smoke\.md",?\s*\)\s*:\s*RESULTS_PATH/,
    );
    expect(src).toMatch(/part:\s*"M26",/);
    expect(src).not.toMatch(/part:\s*"M15\.2"/);
  });

  test("ingest is putExperience + omitExperienceTree notes + mem.sleep; JSONL cap is not the haystack", () => {
    const src = readFileSync(RUNNER, "utf8");
    expect(src).toMatch(/putExperience\(/);
    expect(src).toMatch(/tree:\s*st\.observation/);
    expect(src).toMatch(/omitExperienceTree/);
    expect(src).toMatch(/await mem\.sleep\(\)/);
    expect(src).toMatch(/LME_EXPERIENCE_BYTES/);
    expect(src).toMatch(/ensureExperienceBudget/);
    expect(src).toMatch(/EXPERIENCE_BYTES_ENV/);
    expect(src).not.toMatch(/process\.env\.EDEN_MEMORY_STORE_CAP\s*=/);
    expect(src).not.toMatch(/from ["'][^"']*brain-memory[^"']*["']/);
    expect(src).not.toMatch(/\bmemory_search\s*\(/);
    expect(src).not.toMatch(/\bextractDurable\s*\(/);
  });

  test("probe does not skip all; HTTP 504 scores that row incorrect and CONTINUE", () => {
    const src = readFileSync(RUNNER, "utf8");
    expect(src).toMatch(/Never skip the remaining n questions/);
    expect(src).toMatch(/HTTP 504 on one question scores that row incorrect and CONTINUE/);
    expect(src).toMatch(/do not break\/return \(never skip-all\)/);
    expect(src).not.toMatch(/if\s*\(\s*!probe\.ok\s*\)\s*(?:return|throw|break)/);
    expect(src).not.toMatch(/Official acc uses UNKNOWN for every question/);
    expect(src).toMatch(/for \(const q of questions\)/);
    expect(src).toMatch(/NVCF-POLL-SECONDS[\s\S]{0,40}\|\| "120"/);
    expect(src).toMatch(/mapPool/);
  });

  test("named dataset miss throws LmeDatasetMissingError with exact filename", () => {
    const src = readFileSync(RUNNER, "utf8");
    expect(src).toMatch(/class LmeDatasetMissingError/);
    expect(src).toMatch(/Blocked: LME dataset missing:/);
    expect(src).toMatch(/DATASET_FILENAMES/);
    expect(src).toMatch(/questions\.jsonl/);
    expect(src).toMatch(/haystacks\/lme_v2_small\.json/);
    expect(src).toMatch(/trajectories\.jsonl/);
    expect(src).toMatch(/trajectories\.small-compact\.jsonl/);
  });
});
