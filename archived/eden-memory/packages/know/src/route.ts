import { spawnSync } from "node:child_process";
import { needleLane, type NeedleLane } from "./needles";

export type { NeedleLane };
export { needleLane };

type Hit = { s: string; p: string; o: string; e: string; url: string };

export type KnowSearch = {
  search(q: string, k?: number): Hit[];
  close?: () => void;
};

/** Hot shard is catalogs/RFC/capitals (agent-resident). Cold is wiki/token at TB. */
export function shardForLane(lane: NeedleLane): "hot" | "cold" {
  return lane === "token" ? "cold" : "hot";
}

export type RemoteGet = (url: string, body: { q: string; k: number }) => unknown;

function hitsOf(raw: unknown, k: number): Hit[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { hits?: unknown }).hits;
  if (!Array.isArray(list)) return [];
  const out: Hit[] = [];
  for (const h of list) {
    if (!h || typeof h !== "object") continue;
    const rec = h as { s?: unknown; p?: unknown; o?: unknown; e?: unknown; url?: unknown };
    const s = typeof rec.s === "string" ? rec.s : "";
    const p = typeof rec.p === "string" ? rec.p : "";
    const o = typeof rec.o === "string" ? rec.o : "";
    if (!s || !p || !o) continue;
    out.push({
      s,
      p,
      o,
      e: typeof rec.e === "string" ? rec.e : "",
      url: typeof rec.url === "string" ? rec.url : "",
    });
    if (out.length >= k) break;
  }
  return out;
}

/** Sync Get of hits. Cards are formatted locally — never trust a remote fact string. */
function defaultRemoteGet(url: string, body: { q: string; k: number }): unknown {
  const r = spawnSync(
    "curl",
    ["-sS", "-m", "0.08", "-H", "content-type: application/json", "-d", JSON.stringify(body), url],
    { encoding: "utf8", timeout: 120 },
  );
  if (r.status !== 0 || !r.stdout) return null;
  return JSON.parse(r.stdout) as unknown;
}

/**
 * Remote index for the cold shard. Query never GetObject of a TB blob.
 * Fail-open: network/parse errors are silence.
 */
export function remoteKnowSearch(url: string, getJson?: RemoteGet): KnowSearch {
  const get = getJson ?? defaultRemoteGet;
  return {
    search(q, k = 5) {
      try {
        return hitsOf(get(url, { q, k }), k);
      } catch {
        return [];
      }
    },
  };
}

export function shardForQuery(q: string): "hot" | "cold" {
  return shardForLane(needleLane(q));
}
