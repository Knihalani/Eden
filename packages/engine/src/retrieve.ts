/**
 * `pushRetrieve` (M3, D901; a trial, off): the push's lexical ranking fused with a learned retriever's top k by
 * reciprocal rank (docs/research/m3-retriever.md). No model call here: the retriever is the `widen` dependency.
 */

/** RRF's constant (the screen's c 60). */
export const RRF_C = 60;

/**
 * Ids of `lists` in reciprocal-rank-fusion order: score Σ 1 / (c + rank + 1) over the lists an id is in; ties go to
 * the earlier list, then the earlier rank, so with an empty second list the first comes back unchanged. Each list
 * counts an id once (its first place).
 */
export function rrfOrder(lists: readonly (readonly string[])[], c = RRF_C): string[] {
  const score = new Map<string, number>();
  const first = new Map<string, number>();
  lists.forEach((list, li) => {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      score.set(id, (score.get(id) ?? 0) + 1 / (c + i + 1));
      if (!first.has(id)) first.set(id, li * 1e6 + i);
    });
  });
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || first.get(a)! - first.get(b)!);
}
