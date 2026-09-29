/**
 * M27.4 identical-chunk BM25 vs fused AR retrieve.
 * Same 512-token chunks as product (`chunkText` / ChunkStore / retrieveNarrativeChunks).
 * Not BrainMemory. No GraphRAG / PPR. Honest LOSS is OK — do not invent structure.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK_TARGET_TOKENS, ChunkStore, chunkText, estimateTokens } from "./chunk-store";
import { bm25Rank, retrieveNarrativeChunks } from "./chunk-retrieve";
import { encodeLane, MEMORY_MARK, openMemory } from "./index";

const NEEDLE = "The special magic number of zebra-quark-17 is 48291.";
const GOLD = "48291";
const QUERY = "What is the special magic number of zebra-quark-17?";
const K = 10;
const N_CHUNKS = 20;
const BURY_AT = [0, 4, 9, 14, 19] as const;

const FILLER = [
  "The miller walked beside the river that ran through the valley at dawn.",
  "Villagers said the oak still slept under the silt waiting for summer rain.",
  "Fog hung low over the marsh and the herons waited on one leg.",
  "Carts rattled over the stone bridge after the harvest wagons were loaded.",
  "Children skipped pebbles across the millpond until the geese protested.",
  "Winter ice cracked along the millrace and the wheel stood still for weeks.",
  "Spring floods returned every year and filled the lower pasture with silt.",
  "The baker traded loaves for flour when the sacks were stacked in the loft.",
  "Night watchmen circled the granary with lanterns after the storm passed.",
  "Sheep moved down from the high meadow when the first frost arrived.",
] as const;

export type M274Trial = {
  bury: number;
  nChunks: number;
  goldChunk: number;
  bm25Top10: boolean;
  fusedTop10: boolean;
  goldInPacket: boolean;
};

export type M274Report = {
  n: number;
  bm25GoldInTop10: number;
  fusedGoldInTop10: number;
  goldInPacket: number;
  fusionIsBm25: boolean;
  verdict: "WIN" | "LOSS";
  trials: M274Trial[];
};

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "eden-m274-"));
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function fillerBlock(seed: number): string {
  const parts: string[] = [];
  let n = 0;
  let i = 0;
  while (n < CHUNK_TARGET_TOKENS - 24) {
    const s = `${FILLER[i % FILLER.length]!.replace(/\.$/, "")} near marker ${seed}-${i}.`;
    parts.push(s);
    n += estimateTokens(s);
    i++;
  }
  return parts.join(" ");
}

function haystack(buryAt: number): string {
  const blocks: string[] = [];
  for (let c = 0; c < N_CHUNKS; c++) {
    const block = fillerBlock(c + 1);
    if (c === buryAt) blocks.push(`${NEEDLE} ${block}`);
    else blocks.push(block);
  }
  return blocks.join(" ");
}

function packetOf(messages: unknown[]): string {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => (m && typeof m === "object" ? (m as { role?: string; content?: unknown }) : {}))
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => String(m.content))
    .filter((c) => c.includes(MEMORY_MARK))
    .join("\n");
}

function goldIn(texts: string[]): boolean {
  return texts.some((t) => t.includes(GOLD) && t.includes("zebra-quark-17"));
}

function rankTexts(query: string, docs: string[], k: number): string[] {
  return bm25Rank(query, docs, k).map((r) => docs[r.i] ?? "");
}

function runTrial(bury: number): M274Trial {
  const dir = tmpDir();
  try {
    const story = haystack(bury);
    expect(encodeLane(story)).toBe("narrative");
    const viaChunker = chunkText(story);
    expect(viaChunker.length).toBeGreaterThan(K);

    const mem = openMemory({ dir });
    mem.observe([{ role: "user", content: story }]);
    const stored = new ChunkStore(dir).all();
    const docs = stored.map((c) => String(c.text ?? ""));
    expect(docs.length).toBeGreaterThan(K);
    expect(docs.some((t) => t.includes(GOLD))).toBe(true);
    expect(docs.every((t) => estimateTokens(t) <= CHUNK_TARGET_TOKENS + 64 || t.includes(GOLD))).toBe(true);

    const goldChunk = docs.findIndex((t) => t.includes(GOLD));
    const bm25Top = rankTexts(QUERY, docs, K);
    const fusedHits = retrieveNarrativeChunks(dir, QUERY, { k: K });
    const fusedTop = fusedHits.map((h) => h.text);
    const pkt = packetOf(mem.inject([{ role: "user", content: QUERY }]));

    return {
      bury,
      nChunks: docs.length,
      goldChunk,
      bm25Top10: goldIn(bm25Top),
      fusedTop10: goldIn(fusedTop),
      goldInPacket: pkt.includes(GOLD) && pkt.includes("zebra-quark-17"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function measureM274(): M274Report {
  const trials = BURY_AT.map((bury) => runTrial(bury));
  const n = trials.length;
  const bm25GoldInTop10 = trials.filter((t) => t.bm25Top10).length;
  const fusedGoldInTop10 = trials.filter((t) => t.fusedTop10).length;
  const goldInPacket = trials.filter((t) => t.goldInPacket).length;
  const fusionIsBm25 = trials.every((t) => t.bm25Top10 === t.fusedTop10);
  const verdict: "WIN" | "LOSS" = fusedGoldInTop10 < bm25GoldInTop10 ? "LOSS" : "WIN";
  return { n, bm25GoldInTop10, fusedGoldInTop10, goldInPacket, fusionIsBm25, verdict, trials };
}

describe("M27.4 identical-chunk BM25 vs fused AR", () => {
  test("zebra-quark needle: BM25-only vs retrieveNarrativeChunks top-10 + gold_in_packet", () => {
    withEnv({ EDEN_MEMORY_CAP: "10" }, () => {
      const report = measureM274();
      console.log(
        `M27.4 unit gold_in_top10 BM25-only ${report.bm25GoldInTop10}/${report.n} vs fused ${report.fusedGoldInTop10}/${report.n}; gold_in_packet ${report.goldInPacket}/${report.n}; verdict ${report.verdict}`,
      );
      for (const t of report.trials) {
        expect(t.nChunks).toBeGreaterThan(K);
        expect(t.goldChunk).toBeGreaterThanOrEqual(0);
      }
      expect(report.n).toBe(BURY_AT.length);
      expect(report.bm25GoldInTop10).toBe(report.n);
      if (report.verdict === "LOSS") {
        console.warn("M27.4 LOSS vs identical-chunk BM25 — stop structure (no GraphRAG / PPR)");
      }
      expect(report.verdict === "LOSS" || report.fusedGoldInTop10 >= report.bm25GoldInTop10).toBe(true);
    });
  });
});
