/**
 * M8's router (`routerGate`, D940): the cost of scoring one request against a user's sources with the shipped weights
 * (or `--weights FILE`): the request's features, the conjunction scores (one per distinct source kind and
 * description) and the network over every source, at 1,000 sources (4 named + 996 connectors of 9 kinds). The engine's
 * own reads of its state (per-user maps) are timed in situ by the lab hook (`days-calls --route-log`, `ms`).
 *
 *   bun packages/engine/bench/router.bench.ts [sources=1000] [requests=2000] [--weights FILE]
 */
import { readFileSync } from "node:fs";
import {
  conjScore,
  defaultRouterWeights,
  parseRouterWeights,
  requestFeatures,
  routeProbabilities,
  ROUTER_NF,
  ROUTER_NULL_NF,
  routerTerms,
  sourceKeys,
} from "../src/router";

const args = process.argv.slice(2);
const wi = args.indexOf("--weights");
const w = wi >= 0 ? parseRouterWeights(new Uint8Array(readFileSync(args[wi + 1]!))) : defaultRouterWeights();
if (!w) throw new Error("no weights: ship packages/engine/assets/router.bin or pass --weights FILE");
const rest = args.filter((a, i) => !a.startsWith("--") && i !== wi + 1);
const N = Number(rest[0] ?? 1_000);
const R = Number(rest[1] ?? 2_000);

const KINDS = ["jira", "wiki", "slack-channel", "dashboard", "drive-folder", "github", "zendesk", "figma", "sheets"];
const named = [
  ["gmail", "The user's email (Gmail)"],
  ["calendar", "The user's calendar (Google Calendar)"],
  ["drive", "The user's documents and notes (Google Drive / Notion)"],
  ["slack", "The user's work chat (Slack)"],
];
const sources = [
  ...named,
  ...Array.from({ length: N - named.length }, (_, k) => [`${KINDS[k % 9]}-${k}`, `${KINDS[k % 9]} connector`]),
];
const REQUESTS = [
  "Book the restaurant for Friday with Dana and the kids",
  "Pay the plumber's invoice before the end of the month",
  "Can you move my dentist appointment to next week?",
  "Send the Q3 deck to the board and copy Raj",
  "Renew the car insurance on the Audi",
];
let rng = 7;
const rand = () => ((rng = (Math.imul(rng, 1103515245) + 12345) >>> 0) / 2 ** 32);
const x = new Float64Array(N * ROUTER_NF);
const p = new Float64Array(N);
const summary = new Float64Array(ROUTER_NULL_NF);
// Keys are memoised per source in the engine; built once here.
const keysOf = sources.map(([id, d]) => sourceKeys(id!, d!));
const shared = new Map<string, Uint32Array>();
const keys = keysOf.map((k) => {
  const c = k.join(",");
  const held = shared.get(c);
  if (held) return held;
  shared.set(c, k);
  return k;
});
const times: number[] = [];
for (let r = 0; r < R; r++) {
  for (let i = 0; i < N * ROUTER_NF; i++) x[i] = rand() < 0.7 ? 0 : rand() * 3;
  const t0 = performance.now();
  const feats = requestFeatures(routerTerms(REQUESTS[r % REQUESTS.length]!));
  const memo = new Map<Uint32Array, number>();
  for (let i = 0; i < N; i++) {
    const k = keys[i]!;
    let c = memo.get(k);
    if (c === undefined) memo.set(k, (c = conjScore(w, feats, k)));
    x[i * ROUTER_NF] = c;
  }
  routeProbabilities(w, x, N, summary, p);
  let skipped = 0;
  for (let i = 0; i < N; i++) if (p[i]! < w.floor) skipped++;
  times.push(performance.now() - t0);
  if (skipped < 0) console.log(skipped);
}
times.sort((a, b) => a - b);
const at = (q: number) => Math.round(times[Math.floor(q * (times.length - 1))]! * 1000) / 1000;
console.log(JSON.stringify({ sources: N, requests: R, p50Ms: at(0.5), p90Ms: at(0.9), p99Ms: at(0.99) }));
