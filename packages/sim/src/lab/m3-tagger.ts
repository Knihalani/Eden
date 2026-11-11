/**
 * M3 (D908), LAB ONLY: the `constraintTag` trial's dependency from an exported binnet `tags` network (H13;
 * packages/sim/lab/m3r/twin-forward.ts, export_net.py). The tagger reads an item as binnet did in training (title, a
 * newline, text) and answers its probability of the first tag, "fact" (a binding fact for some request). An item's
 * reading is cached by its id and content, so the tagger is paid once per item version, as an ingest tag would be.
 */
import type { ContextItem } from "@eden/protocol";
import { ALL_CLEAR } from "@eden/engine";
import { network } from "../../lab/m3r/twin-forward";

export interface Tagger {
  tag: (scope: { tenantId: string; userId: string }, item: ContextItem) => number;
  /** Items encoded, and the time spent encoding (ms): the per-item cost an ingest tag would pay. */
  stats: () => { items: number; ms: number };
}

export function loadTagger(dir: string): Tagger {
  const net = network(dir);
  if (net.meta.arch !== "tags") throw new Error(`--tagger: ${dir} holds a ${net.meta.arch} network, not tags`);
  const memo = new Map<string, number>();
  let ms = 0;
  return {
    tag: (scope, item) => {
      // Keyed by user as well: two users' items never share a reading (isolation), even with equal ids.
      const key = `${scope.tenantId}/${scope.userId}\u0000${item.id}\u0000${item.title ?? ""}\u0000${item.text}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const t0 = performance.now();
      const logits = net.tags(net.encode(`${item.title ?? ""}\n${item.text}`));
      ms += performance.now() - t0;
      // The engine's reading (`ItemTagger.constraintProbability`): one minus the all-clear tags' mass.
      const top = Math.max(...logits);
      const exps = logits.map((l) => Math.exp(l - top));
      const clear = exps.reduce((a, e, k) => a + (ALL_CLEAR.has(net.meta.tags![k]!) ? e : 0), 0);
      const p = 1 - clear / exps.reduce((a, b) => a + b, 0);
      memo.set(key, p);
      return p;
    },
    stats: () => ({ items: memo.size, ms: Number(ms.toFixed(1)) }),
  };
}
