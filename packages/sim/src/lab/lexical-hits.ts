/**
 * P3's `hits` arm (weak-points-1111 §3 B10): the plain retrieval baseline Eden's selection is measured against. On
 * every request, the `k` best BM25 hits for the request's own words over every item the user's sources hold, handed to
 * the agent in Eden's candidates packet (the same envelope, lead, excerpt length and byte cap), with nothing of Eden's
 * logic: no cards, intent requests, gate, constraint test, settled cut, not-twice ledger, ask tool or silence. The
 * ranking is `SimIndex`'s ranked search (the one the `tools` arm's sources answer with), over all sources at once.
 *
 * So `hits` against `eden` reads what Eden's choice of items and of when to speak is worth beyond "push any retrieval",
 * and `hits` against `tools` what pushing retrieval is worth beyond an agent that searches for itself.
 */
import { CANDIDATES_LEAD, DEFAULT_CONFIG, isStopword, renderPacket } from "@eden/engine";
import type { ContextItem } from "@eden/protocol";
import { sanitizeForStore } from "@eden/redact";
import { ALL_SOURCES, SimIndex, type SourceProfile } from "../sources";
import type { World } from "../world";

/** The hits a request gets: Eden's default candidates count (`pushCandidates`, 5). */
export const HITS_K = DEFAULT_CONFIG.pushCandidates;

const RANKED = { semantics: "ranked" } as SourceProfile;

/** The `k` best BM25 hits for `text` over every source's items, best first (the world as it is now). */
export function topHits(world: World, text: string, k = HITS_K): ContextItem[] {
  const index = new SimIndex(ALL_SOURCES, world);
  const query = { scope: { tenantId: "", userId: "" }, text, entities: [], limit: k };
  const hits = index.match(index.queryTerms(query, "text"), k, RANKED);
  // Text that is sent to a model passes the redaction gate first (CLAUDE.md), as Eden's cache does at ingest.
  return hits.map((it) => ({
    id: it.id,
    sourceId: it.sourceId,
    ref: it.ref,
    title: sanitizeForStore(it.title),
    text: sanitizeForStore(it.text),
    updatedAt: it.updatedAt,
  }));
}

/** Eden's candidates frame (`candidateFrame` in partner.ts, no nudge): the same lead, excerpt and byte cap. */
const ITEM_BYTES = Math.min(DEFAULT_CONFIG.compactItemBytes, 320);
const MAX_BYTES = Math.max(DEFAULT_CONFIG.maxInjectionBytes, 400 + HITS_K * (ITEM_BYTES + 120));

/** The packet for one request's hits, or null when nothing matched a word of it. */
export function hitsPacket(
  world: World,
  text: string,
  k = HITS_K,
): { text: string; citations: { itemId: string; sourceId: string; title: string }[] } | null {
  const items = topHits(world, text, k);
  if (!items.length) return null;
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const focus = new Set(words.filter((w) => w.length > 1 && !isStopword(w)));
  return {
    text: renderPacket(items, {
      maxBytes: MAX_BYTES,
      lead: CANDIDATES_LEAD,
      focus,
      itemBytes: ITEM_BYTES,
      year: new Date(world.now).getUTCFullYear(),
    }),
    citations: items.map((i) => ({ itemId: i.id, sourceId: i.sourceId, title: i.title })),
  };
}
