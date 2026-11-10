/**
 * N2 (D511): the lab's `widen` dependency for the `pushWiden` trial, read from a precomputed embedding table
 * (`packages/sim/modal/n2_embed.py`: per world and request, the item ids an open embedding model ranks first). Lab
 * only; no product package wires a `widen`. The table is made offline on simulated worlds, so the push makes no call.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/** (suite|seed|variant) → request text → ids, best first. */
export type WidenTable = Map<string, Map<string, string[]>>;

export function loadWidenTable(path: string): WidenTable {
  const raw = readFileSync(path);
  const text = path.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  const out: WidenTable = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { suite: string; seed: number; variant: string; request: string; top: string[] };
    const k = `${r.suite}|${r.seed}|${r.variant}`;
    let m = out.get(k);
    if (!m) out.set(k, (m = new Map()));
    m.set(norm(r.request), r.top);
  }
  return out;
}

/** Requests reach the engine redacted (`sanitizeForStore`) and may differ in spacing: matched on letters and digits. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function widenFor(table: WidenTable, suite: string, seed: number, variant: string) {
  const m = table.get(`${suite}|${seed}|${variant}`);
  return async (_scope: unknown, request: string, k: number): Promise<readonly string[]> =>
    (m?.get(norm(request)) ?? []).slice(0, k);
}
