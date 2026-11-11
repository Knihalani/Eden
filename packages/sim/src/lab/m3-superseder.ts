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
  /** The partner's `supersede` dependency: one call a push pass, every (older, newer) pair's probability. */
  replaces: (
    scope: { tenantId: string; userId: string },
    pairs: readonly (readonly [ContextItem, ContextItem])[],
  ) => number[];
  /** Items encoded, pairs scored, passes, and the time each took (ms; `passMs`: pair scoring a pass, summed). */
  stats: () => {
    items: number;
    pairs: number;
    passes: number;
    encodeMs: number;
    pairMs: number;
    passMsP50: number;
    passMsP90: number;
    passMsP99: number;
  };
}

/**
 * M3 (D908 rule 1): the `pushSupersede` trial's dependency from an exported binnet `supersede` network (H10): the
 * probability that `newer` replaces `older`, read as binnet did in training (title, a newline, text). An item's code
 * is cached by user, id and content (paid once per item version, as at ingest); a pair is scored per request.
 */
export function loadSuperseder(dir: string): Superseder {
  // M3b (D914): `h10.py export`'s students (a `cfg` in meta.json) or binnet's `supersede` export.
  const meta = existsSync(join(dir, "meta.json")) ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : {};
  type Code = Float32Array | Int8Array;
  let net: { encode: (t: string) => Code; many: (pairs: readonly (readonly [Code, Code])[]) => number[] };
  if (meta.cfg) {
    const h = h10Network(dir);
    net = { encode: h.encode, many: h.replacesMany };
  } else {
    const n = network(dir);
    if (n.meta.arch !== "supersede") throw new Error(`--supersede: ${dir} holds a ${n.meta.arch} network`);
    net = { encode: n.encode, many: (ps) => ps.map(([a, b]) => n.replaces(a as Float32Array, b as Float32Array)) };
  }
  const codes = new Map<string, Float32Array | Int8Array>();
  let encodeMs = 0;
  let pairMs = 0;
  let pairs = 0;
  let passes = 0;
  const passMs: number[] = [];
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
    replaces: (scope, batch) => {
      const cs = batch.map(([older, newer]) => [code(scope, older), code(scope, newer)] as const);
      const t0 = performance.now();
      const logits = net.many(cs);
      const dt = performance.now() - t0;
      pairMs += dt;
      passMs.push(dt);
      pairs += batch.length;
      passes++;
      // M3b's diagnosis (D914): every scored pair, when M3B_SUPERSEDE_TRACE names a file (one JSON line a pair).
      if (TRACE)
        appendFileSync(
          TRACE,
          batch
            .map(([older, newer], i) =>
              JSON.stringify({
                user: scope.userId,
                older: older.id,
                newer: newer.id,
                olderAt: older.updatedAt,
                newerAt: newer.updatedAt,
                logit: +logits[i]!.toFixed(4),
                // With M3B_SUPERSEDE_TRACE_TEXT=1 the texts too (synthetic worlds only), to train on engine pairs.
                ...(TRACE_TEXT
                  ? { a: `${older.title ?? ""}\n${older.text}`, b: `${newer.title ?? ""}\n${newer.text}` }
                  : {}),
              }),
            )
            .join("\n") + "\n",
        );
      return logits.map((l) => 1 / (1 + Math.exp(-l)));
    },
    stats: () => {
      const q = [...passMs].sort((x, y) => x - y);
      const at = (f: number) => (q.length ? +q[Math.min(q.length - 1, Math.floor(f * q.length))]!.toFixed(3) : 0);
      return {
        items: codes.size,
        pairs,
        passes,
        encodeMs: +encodeMs.toFixed(1),
        pairMs: +pairMs.toFixed(2),
        passMsP50: at(0.5),
        passMsP90: at(0.9),
        passMsP99: at(0.99),
      };
    },
  };
}
