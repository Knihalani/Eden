/**
 * M33.2 dense RAG — written reject. Decision only.
 *
 * Report §4.3: dense RAG (Qwen3/TE3) overall 38.0–38.2, below BM25 41.5.
 * Dense lost overall. Adding embeddings without a hybrid proof on identical
 * docs will not beat HippoRAG; the table already ran that experiment.
 *
 * M18 EventQA inject 64 vs identical-chunk BM25 74.6 on official 534k — LOSS.
 * M18 close rule: lose to LangChain BM25 on identical chunks, stop adding
 * structure. Dense is more structure. Store-all BM25 is the lane that stays.
 *
 * M19 TREC-F 6 published LOSS; MCC 53.6. ICL stays store-all atoms.
 * Mem0 extract destroyed TTL. Report §4.3 leave: embeddings as a replacement
 * for store-all ICL. No extract. No embeddings in place of store-all ICL.
 *
 * M27 SH inject 64 vs BM25 66 / HippoRAG 76. Close: lose to identical-chunk
 * BM25, LOSS, stop structure.
 *
 * Optional Dense is rejected in writing (allowed). M18/M19/M27 still lose
 * to BM25, which would *permit* a hybrid — we still reject because:
 * Report §4.3 dense already lost overall (38 vs 41.5), so adding those
 * embeddings is not a hybrid proof; M18/M27 say stop structure on an
 * identical-chunk BM25 loss; ICL store-all forbids embeddings as a
 * replacement. A local embed that does not retrieve on those leaves
 * would be a no-op. Local-only would have been required IF added.
 * We did not add. ICL still store-all. No embedder. No network embed.
 * No new npm dep.
 *
 * `howtoEmbedScore` / `globalThis.edenHowtoEmbed` in src/index.ts stays an
 * optional how-to aboutness hook that degrades to 0. It is not this lane.
 *
 * Not BrainMemory. Do not add memory_search. No retrieve. Fail-open: a
 * constant decision only; this module never throws into inject.
 */

export const DENSE_RAG = false as const;

export type DenseDecision = "rejected";
