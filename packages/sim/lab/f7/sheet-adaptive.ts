/**
 * D1800: the rule sheet's price a check under three breakpoint rules, from a user's check spacing [EST], $0.
 *
 *   bun packages/sim/lab/f7/sheet-adaptive.ts [--users 400] [--days 30] [--sheet-chars 8200] [--changes 1,4]
 *
 * A port of `sheet-cache.py` (D1197) run on the shipped rule itself (`SheetCachePolicy`, @eden/engine), over whole
 * users (the rule's state carries from day to day) rather than independent days. The rules:
 * - `always`: D1790's default before D1800, the sheet marked with the hour on every check;
 * - `never`: the sheet sent plain (only the fixed instructions cached);
 * - `adaptive`: `SheetCachePolicy` (marked when in the cache, or when the user's recent checks reused it).
 * The provider's cache is modelled exactly: a marked send of a sheet writes it (2x input) unless the same sheet was
 * sent marked within the hour, which reads it (0.1x); either refreshes the hour; a plain send pays 1x and refreshes
 * nothing. Spacings (each day's checks within its active hours, a night between days, as sheet-cache.py):
 * - `lab`: a fixed `--gap-min` (10) minutes; `poisson`: at random over 7.3 active hours; `bursty`: sessions of 2-5
 *   checks a minute or two apart, sessions at random; `edge`: gaps of 30-90 minutes, around the hour's break-even.
 * Users: light (2 checks a day), typical (6), heavy (16), very heavy (40), and shifting (heavy and light weeks in
 * turn). Sheet changes (`--changes LO,HI` a day) land at random in the day. Haiku 5.5 list input, $0.10 a million
 * tokens, four characters a token, as sheet-cache.py. `--weight` and `--mark` override the rule's two settings (the
 * sweep that chose them).
 */
import { SheetCachePolicy } from "@eden/engine";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1]!);
const USERS = Number(args.get("users") ?? 400);
const DAYS = Number(args.get("days") ?? 30);
const SHEET_CHARS = Number(args.get("sheet-chars") ?? 8200);
const [CH_LO, CH_HI] = (args.get("changes") ?? "1,4").split(",").map(Number) as [number, number];
const GAP_MIN = Number(args.get("gap-min") ?? 10);
const WEIGHT = args.has("weight") ? Number(args.get("weight")) : undefined;
const MARK = args.has("mark") ? Number(args.get("mark")) : undefined;
const IN = 0.1e-6;
const ACTIVE_MIN = (220 * 60) / 30;
const TTL_MIN = 60;

/** A seeded generator (mulberry32), so a run repeats. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Spacing = "lab" | "poisson" | "bursty" | "edge";

function dayTimes(model: Spacing, n: number, r: () => number): number[] {
  if (model === "lab") return Array.from({ length: n }, (_, i) => i * GAP_MIN);
  if (model === "poisson") return Array.from({ length: n }, () => r() * ACTIVE_MIN).sort((a, b) => a - b);
  if (model === "edge") {
    const out = [0];
    while (out.length < n) out.push(out.at(-1)! + 30 + 60 * r());
    return out;
  }
  const out: number[] = [];
  while (out.length < n) {
    let t = r() * ACTIVE_MIN;
    const k = Math.min(2 + Math.floor(r() * 4), n - out.length);
    for (let j = 0; j < k; j++) {
      out.push(t);
      t += 0.5 + 1.5 * r();
    }
  }
  return out.sort((a, b) => a - b);
}

type Rule = "always" | "never" | "adaptive";

/** Mean price of the sheet a check, as a multiple of its plain price, and the share of checks marked. */
function run(
  model: Spacing,
  perDay: (day: number) => number,
  rule: Rule,
  seed: number,
): { price: number; marked: number } {
  const r = rng(seed);
  let total = 0;
  let checks = 0;
  let marks = 0;
  for (let u = 0; u < USERS; u++) {
    const policy = new SheetCachePolicy(undefined, WEIGHT, MARK);
    let version = 0;
    // The provider's entry: the sheet version last sent marked and when (a read or a write refreshes it).
    let cached: { version: number; at: number } | null = null;
    for (let d = 0; d < DAYS; d++) {
      const base = d * 1440;
      const times = dayTimes(model, perDay(d), r);
      const span = Math.max(times.at(-1)!, 1);
      const cuts = Array.from({ length: CH_LO + Math.floor(r() * (CH_HI - CH_LO + 1)) }, () => base + r() * span);
      let last = base;
      for (const t0 of times) {
        const t = base + t0;
        version += cuts.filter((c) => last < c && c <= t).length;
        last = t;
        const hash = String(version);
        const now = t * 60_000;
        const marked = rule === "always" ? true : rule === "never" ? false : policy.mark("u", hash, now);
        if (marked) {
          const hit = cached !== null && cached.version === version && t - cached.at <= TTL_MIN;
          total += hit ? 0.1 : 2.0;
          cached = { version, at: t };
          marks++;
        } else total += 1.0;
        checks++;
        policy.note("u", hash, now, marked);
      }
    }
  }
  return { price: total / checks, marked: marks / checks };
}

const tokens = SHEET_CHARS / 4;
const plain = tokens * IN;
const USERS_BY_KIND: [string, (day: number) => number][] = [
  ["light (2/day)", () => 2],
  ["typical (6/day)", () => 6],
  ["heavy (16/day)", () => 16],
  ["very heavy (40/day)", () => 40],
  // A user whose habits change: heavy and light weeks in turn (the rule's lag, against both fixed rules).
  ["shifting (16 or 2/day, weekly)", (d) => (Math.floor(d / 7) % 2 === 0 ? 16 : 2)],
];
const SPACINGS: Spacing[] = ["lab", "poisson", "bursty", "edge"];
console.log(
  `sheet ${SHEET_CHARS} chars (${tokens} tokens), plain $${plain.toFixed(6)} a check; ${USERS} users x ${DAYS} days a ` +
    `cell; sheet changes ${CH_LO}-${CH_HI} a day [EST]`,
);
console.log("$ a check for the sheet (x plain); adaptive's share of checks marked; adaptive against the better rule");
console.log("| user | spacing | always | never | adaptive | marked | vs best |");
console.log("|---|---|---|---|---|---|---|");
let worst = -Infinity;
let seed = 1800;
for (const [kind, perDay] of USERS_BY_KIND) {
  for (const model of SPACINGS) {
    const s = seed++;
    // The same seed for each rule: the same users, days and sheet changes.
    const a = run(model, perDay, "always", s);
    const n = run(model, perDay, "never", s);
    const ad = run(model, perDay, "adaptive", s);
    const best = Math.min(a.price, n.price);
    const vs = ad.price / best - 1;
    worst = Math.max(worst, vs);
    const $ = (x: number) => `$${(x * plain).toFixed(6)} (${x.toFixed(2)})`;
    console.log(
      `| ${kind} | ${model} | ${$(a.price)} | ${$(n.price)} | ${$(ad.price)} | ` +
        `${(ad.marked * 100).toFixed(0)}% | ${vs >= 0 ? "+" : ""}${(vs * 100).toFixed(1)}% |`,
    );
  }
}
console.log(`\nworst cell, adaptive against the better of always and never: ${(worst * 100).toFixed(1)}%`);
