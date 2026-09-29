/**
 * M33.2 dense RAG rejected in writing.
 * Product inject stays store-all. No embedder. No memory_search.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DENSE_RAG, type DenseDecision } from "./memory-dense";

const ROOT = join(import.meta.dir, "..");
const DENSE_PATH = join(import.meta.dir, "memory-dense.ts");
const ICL_PATH = join(import.meta.dir, "icl-index.ts");
const INDEX_PATH = join(import.meta.dir, "index.ts");

const PRODUCT = [
  INDEX_PATH,
  join(ROOT, "packages", "wrap", "src", "proxy.ts"),
  join(ROOT, "packages", "wrap", "src", "anthropic.ts"),
  join(ROOT, "packages", "wrap", "src", "know-inject.ts"),
  join(ROOT, "packages", "cli", "src", "memory-hook.ts"),
];

/** Import / dynamic import / require of an embedding provider or this reject module. */
const EMBED_IMPORT =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"][^'"]*(?:openai|voyageai|voyage|cohere|@xenova\/transformers|memory-dense)[^'"]*['"]/;

const HOWTO_EMBED_FREEZE = `function howtoEmbedScore(a: string, b: string): number {
  try {
    const fn = (globalThis as { edenHowtoEmbed?: (x: string, y: string) => number }).edenHowtoEmbed;
    if (typeof fn !== "function") return 0;
    const n = Number(fn(a, b));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 0.999) : 0;
  } catch {
    return 0;
  }
}`;

function codeWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("M33.2 dense RAG rejected", () => {
  test("file exists and DENSE_RAG is false", () => {
    expect(existsSync(DENSE_PATH)).toBe(true);
    expect(DENSE_RAG).toBe(false);
    const decision: DenseDecision = "rejected";
    expect(decision).toBe("rejected");
    const src = readFileSync(DENSE_PATH, "utf8");
    expect(src).toMatch(/export const DENSE_RAG = false as const/);
    expect(src).toMatch(/export type DenseDecision = "rejected"/);
  });

  test("written reject cites M18 64 vs 74.6, M19 TREC-F 6 / MCC 53.6, M27 64 vs 66, Report §4.3 38 vs 41.5", () => {
    const src = readFileSync(DENSE_PATH, "utf8");
    expect(src).toMatch(/M18 EventQA inject 64 vs identical-chunk BM25 74\.6/);
    expect(src).toMatch(/M19 TREC-F 6 published LOSS/);
    expect(src).toMatch(/MCC 53\.6/);
    expect(src).toMatch(/M27 SH inject 64 vs BM25 66 \/ HippoRAG 76/);
    expect(src).toMatch(/38\.0–38\.2/);
    expect(src).toMatch(/below BM25 41\.5/);
    expect(src).toMatch(/ICL stays store-all atoms/);
    expect(src).toMatch(/ICL still store-all/);
    // Plan §5: a BM25 loss *permits* hybrid. Reject stays for the other three reasons.
    expect(src).toMatch(/\*permit\* a hybrid/);
    expect(src).toMatch(/we still reject because/);
    expect(src).toMatch(/dense already lost overall/);
    expect(src).toMatch(/stop structure/);
    expect(src).toMatch(/ICL store-all forbids embeddings as a/);
    expect(src).not.toMatch(/lose to BM25[^.\n]{0,80}(?:forbids hybrid|does not permit)/i);
    expect(src).not.toMatch(/because we (?:beat|won|exceeded) BM25/i);
    expect(src).toMatch(/Local-only would have been required IF added/);
    expect(src).toMatch(/We did not add/);
    expect(src).toMatch(/[Ff]ail-open/);
  });

  test("decision module has no retrieve, no BrainMemory, no memory_search, no imports", () => {
    const src = readFileSync(DENSE_PATH, "utf8");
    const code = codeWithoutComments(src);
    expect(code).not.toMatch(/\bfunction\b/);
    expect(code).not.toMatch(/\bretrieve\b/);
    expect(code).not.toMatch(/\bmemory_search\b/);
    expect(code).not.toMatch(/\bBrainMemory\b/);
    expect(code).not.toMatch(/\bimport\b/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(EMBED_IMPORT);
  });

  test("product inject path does not import openai/voyage/cohere embeddings, @xenova/transformers, or a dense index", () => {
    for (const p of PRODUCT) {
      expect(existsSync(p), p).toBe(true);
      const src = readFileSync(p, "utf8");
      expect(src, p).not.toMatch(EMBED_IMPORT);
      expect(src, p).not.toMatch(/@xenova\/transformers/);
      expect(src, p).not.toMatch(/memory-dense/);
      expect(src, p).not.toMatch(/\bDENSE_RAG\b/);
    }
  });

  test("icl-index stays store-all BM25 with no embed retrieve", () => {
    expect(existsSync(ICL_PATH)).toBe(true);
    const src = readFileSync(ICL_PATH, "utf8");
    expect(src).toMatch(/Store-all including/);
    expect(src).toMatch(/Robertson \/ Lucene BM25/);
    expect(src).toMatch(/export function retrieveIcl/);
    expect(src).not.toMatch(/embed/i);
    expect(src).not.toMatch(EMBED_IMPORT);
    expect(src).not.toMatch(/@xenova\/transformers/);
    expect(codeWithoutComments(src)).not.toMatch(/\bmemory_search\b/);
  });

  test("howtoEmbedScore / edenHowtoEmbed stays a degrade-to-0 how-to hook, not a RAG lane", () => {
    const src = readFileSync(INDEX_PATH, "utf8");
    expect(src).toContain(HOWTO_EMBED_FREEZE);
    expect(src).toMatch(/Optional local embed on lexical miss\. Absent hook → 0 \(degrade\)\. No network, no new dep\./);
    const calls = src.match(/\bhowtoEmbedScore\s*\(/g) ?? [];
    expect(calls).toEqual(["howtoEmbedScore(", "howtoEmbedScore("]);
    expect(src).toMatch(/return howtoEmbedScore\(q, howtoHayText\(row\)\);/);
    expect(src).not.toMatch(/edenHowtoEmbed[\s\S]{0,400}(?:EventQA|retrieveIcl|icl-index|chunk-store)/);
  });

  test("product inject path and the reject module have no memory_search", () => {
    for (const p of [...PRODUCT, DENSE_PATH, ICL_PATH]) {
      const code = codeWithoutComments(readFileSync(p, "utf8"));
      expect(code, p).not.toMatch(/\bmemory_search\b/);
    }
  });
});
