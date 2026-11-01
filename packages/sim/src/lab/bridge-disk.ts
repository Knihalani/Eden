/**
 * Bridging queries from a disk cache (lab only; docs/research/edge-bridge.md): each request's queries, made once by
 * `bridge-enrich.ts`, are kept under the request's key (`bridgeKey`), so funnel reruns replay them at no cost. The
 * requests are the simulated suites', so nothing here is user data; the engine never writes queries to disk (D8).
 *
 * A request with no cached line is uncovered (null), as one the budget refused would be: the lookup runs as without
 * the flag. Every request asked is counted, so a run reports what production would have called.
 */
import { existsSync, readFileSync } from "node:fs";
import { bridgeKey, type BridgeMaker } from "@eden/engine";

/** One line of the cache: the request's key, its text (simulated), and its queries (null: unreadable output). */
export interface BridgeLine {
  h: string;
  r: string;
  q: string[] | null;
}

export function loadBridge(file: string): Map<string, string[] | null> {
  const out = new Map<string, string[] | null>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const l = JSON.parse(line) as BridgeLine;
    out.set(l.h, l.q);
  }
  return out;
}

export class DiskBridgeMaker implements BridgeMaker {
  readonly queries: Map<string, string[] | null>;
  /** Requests replayed, and requests with no cached line. */
  hits = 0;
  misses = 0;
  /** Distinct requests asked: what production would have sent to the model (one call each). */
  readonly asked = new Set<string>();

  constructor(file: string) {
    this.queries = loadBridge(file);
  }

  async make(requests: string[]) {
    const queries = requests.map((r) => {
      const h = bridgeKey(r);
      this.asked.add(h);
      if (!this.queries.has(h)) {
        this.misses++;
        return null;
      }
      this.hits++;
      return this.queries.get(h) ?? null;
    });
    return { queries, costUsd: 0 };
  }
}
