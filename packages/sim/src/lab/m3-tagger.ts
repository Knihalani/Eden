/**
 * M3 (D908), LAB ONLY: the `constraintTag` trial's dependency from an exported binnet `tags` network (H13;
 * packages/sim/lab/m3r/twin-forward.ts, export_net.py). The tagger reads an item as binnet did in training (title, a
 * newline, text) and answers its probability of the first tag, "fact" (a binding fact for some request). An item's
 * reading is cached by its id and content, so the tagger is paid once per item version, as an ingest tag would be.
 */
import type { ContextItem } from "@eden/protocol";
import { ALL_CLEAR } from "@eden/engine";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "../../lab/m3r/twin-forward";
import { h10Network } from "../../lab/m3r/h10-forward";

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

const TRACE = process.env.M3B_SUPERSEDE_TRACE ?? "";
const TRACE_TEXT = process.env.M3B_SUPERSEDE_TRACE_TEXT === "1";

export interface Superseder {
  replaces: (scope: { tenantId: string; userId: string }, older: ContextItem, newer: ContextItem) => number;
  /** Items encoded, pairs scored, and the time each took (ms). */
  stats: () => { items: number; pairs: number; encodeMs: number; pairMs: number };
}

/**
 * M3 (D908 rule 1): the `pushSupersede` trial's dependency from an exported binnet `supersede` network (H10): the
 * probability that `newer` replaces `older`, read as binnet did in training (title, a newline, text). An item's code
 * is cached by user, id and content (paid once per item version, as at ingest); a pair is scored per request.
 */
export function loadSuperseder(dir: string): Superseder {
  // M3b (D914): `h10.py export`'s students (a `cfg` in meta.json) or binnet's `supersede` export.
  const meta = existsSync(join(dir, "meta.json")) ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : {};
  let net: { encode: (t: string) => Float32Array | Int8Array; replaces: (a: never, b: never) => number };
  if (meta.cfg) net = h10Network(dir) as typeof net;
  else {
    const n = network(dir);
    if (n.meta.arch !== "supersede") throw new Error(`--supersede: ${dir} holds a ${n.meta.arch} network`);
    net = n as typeof net;
  }
  const codes = new Map<string, Float32Array | Int8Array>();
  let encodeMs = 0;
  let pairMs = 0;
  let pairs = 0;
  const code = (scope: { tenantId: string; userId: string }, it: ContextItem) => {
    const key = `${scope.tenantId}/${scope.userId}\u0000${it.id}\u0000${it.title ?? ""}\u0000${it.text}`;
    let c = codes.get(key);
    if (!c) {
      const t0 = performance.now();
      c = net.encode(`${it.title ?? ""}\n${it.text}`);
      encodeMs += performance.now() - t0;
      codes.set(key, c);
    }
    return c;
  };
  return {
    replaces: (scope, older, newer) => {
      const a = code(scope, older);
      const b = code(scope, newer);
      const t0 = performance.now();
      const logit = net.replaces(a as never, b as never);
      pairMs += performance.now() - t0;
      pairs++;
      // M3b's diagnosis (D914): every scored pair, when M3B_SUPERSEDE_TRACE names a file (one JSON line a pair).
      if (TRACE)
        appendFileSync(
          TRACE,
          JSON.stringify({
            user: scope.userId,
            older: older.id,
            newer: newer.id,
            olderAt: older.updatedAt,
            newerAt: newer.updatedAt,
            logit: +logit.toFixed(4),
            // With M3B_SUPERSEDE_TRACE_TEXT=1 the texts too (synthetic worlds only), to train on engine-drawn pairs.
            ...(TRACE_TEXT
              ? { a: `${older.title ?? ""}\n${older.text}`, b: `${newer.title ?? ""}\n${newer.text}` }
              : {}),
          }) + "\n",
        );
      return 1 / (1 + Math.exp(-logit));
    },
    stats: () => ({ items: codes.size, pairs, encodeMs: +encodeMs.toFixed(1), pairMs: +pairMs.toFixed(2) }),
  };
}
