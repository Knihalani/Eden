/**
 * M3b (D914), LAB ONLY: the `pushSupersede` trial's dependency, H10's pair model (packages/sim/lab/m3r/h10.py's export
 * read by h10-forward.ts, or a binnet `supersede` export read by twin-forward.ts). An item's code is cached by user, id
 * and content (paid once per item version, as at ingest); a pair is scored per request. With M3B_SUPERSEDE_TRACE every
 * scored pair is appended to that file (with M3B_SUPERSEDE_TRACE_TEXT=1 its texts too: synthetic worlds only).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextItem } from "@eden/protocol";
import { network } from "../../lab/m3r/twin-forward";
import { h10Network } from "../../lab/m3r/h10-forward";

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
