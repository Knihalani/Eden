/**
 * D1800, D1810: the push check's cached prefix (the fixed instructions and the rule sheet) priced a check under
 * five breakpoint rules, from a user's check spacing and the box's other traffic [EST], $0.
 *
 *   bun packages/sim/lab/f7/sheet-adaptive.ts [--users 400] [--days 30] [--seed 1800] [--changes 1,4]
 *     [--box quiet|busy|shared]
 *
 * A port of `sheet-cache.py` (D1197) run on the shipped classes themselves (`SheetCachePolicy`, `SystemTtlPolicy`,
 * @eden/engine), over whole users (the rules' state carries from day to day). The rules:
 * - `always`: D1790, the sheet marked with the hour on every check, which sends the instructions at the hour too;
 * - `never`: the sheet sent plain, the instructions at five minutes (D1790's shape without a sheet);
 * - `sheet only`: D1800's first rule, the sheet by `SheetCachePolicy`, the instructions at the hour only with it;
 * - `adaptive`: D1800 as shipped, the sheet by `SheetCachePolicy`, the instructions at the hour with a marked sheet
 *   or when `SystemTtlPolicy` (the tenant's check gaps) asks for it, else at five minutes (the policy built with its
 *   lab switch that never chooses none);
 * - `plain`: D1810, as `adaptive` with `SystemTtlPolicy`'s third choice: under a plain sheet the instructions go with
 *   no breakpoint (1x, no read, no write) when both breakpoints' running means are above plain.
 * The provider's cache is modelled per prefix: a marked send reads the entry (0.1x) when it is alive, else writes it
 * (1.25x at five minutes, 2x at the hour), and either sets the entry to live the request's TTL from then (an
 * assumption: whether a five-minute read shortens an hour's entry is not documented). A plain send pays 1x. The
 * instructions' entry is shared by the box: `--box quiet` has no other traffic (this user's checks alone keep it
 * warm); `--box busy` has other users' checks keep it alive at every one of this user's (a check of theirs a minute
 * before each, which `SystemTtlPolicy` also sees: the same tenant's users); `--box shared` has the same checks come
 * from another tenant, sending the instructions at five minutes, which this tenant's policy does not see (D9: it is
 * per tenant). Only this user's checks are priced.
 * Spacings (each day's checks within its active hours, a night between days, as sheet-cache.py):
 * - `lab`: a fixed `--gap-min` (10) minutes; `poisson`: at random over 7.3 active hours; `bursty`: sessions of 2-5
 *   checks a minute or two apart, sessions at random; `edge`: gaps of 30-90 minutes, around the hour's break-even.
 * Users: rare (1 check a day), light (2), typical (6), heavy (16), very heavy (40), and shifting (heavy and light weeks
 * in turn). Sheet changes (`--changes LO,HI` a day) land at random over the whole day, independent of the checks. Sizes:
 * `CHECK_SYSTEM`'s 3,861 characters and an 8,200-character sheet, four characters a token, Haiku 5.5's $0.10 a
 * million. `--weight` and `--mark` override the sheet rule's two settings (the sweep that chose them).
 */
import { CHECK_SYSTEM, SheetCachePolicy, SystemTtlPolicy } from "@eden/engine";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1]!);
const USERS = Number(args.get("users") ?? 400);
const DAYS = Number(args.get("days") ?? 30);
const SEED = Number(args.get("seed") ?? 1800);
const SHEET_CHARS = Number(args.get("sheet-chars") ?? 8200);
const [CH_LO, CH_HI] = (args.get("changes") ?? "1,4").split(",").map(Number) as [number, number];
const GAP_MIN = Number(args.get("gap-min") ?? 10);
const BOX = args.get("box") ?? "quiet";
const WEIGHT = args.has("weight") ? Number(args.get("weight")) : undefined;
const MARK = args.has("mark") ? Number(args.get("mark")) : undefined;
const IN = 0.1e-6;
const ACTIVE_MIN = (220 * 60) / 30;
const HOUR_MIN = 60;
const FIVE_MIN = 5;

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

type Rule = "always" | "never" | "sheet only" | "adaptive" | "plain";

/** A prefix's entry in the provider's cache: alive until `until` (minutes). */
class Entry {
  until = -Infinity;
  /** The price of a marked send at `t` with a TTL of `ttl` minutes (a multiple of plain); refreshes the entry. */
  send(t: number, ttl: number): number {
    const hit = t <= this.until;
    this.until = t + ttl;
    return hit ? 0.1 : ttl === HOUR_MIN ? 2.0 : 1.25;
  }
}

const sysTokens = CHECK_SYSTEM.length / 4;
const sheetTokens = SHEET_CHARS / 4;

/** Mean price of the prefix (instructions and sheet) a check of this user's, as a multiple of its plain price. */
function run(model: Spacing, perDay: (day: number) => number, rule: Rule, seed: number) {
  const r = rng(seed);
  let total = 0;
  let checks = 0;
  for (let u = 0; u < USERS; u++) {
    const sheets = new SheetCachePolicy(undefined, WEIGHT, MARK);
    // D1800's rule never sends the instructions plain; D1810's may.
    const system = new SystemTtlPolicy(undefined, undefined, rule === "plain");
    const sysEntry = new Entry();
    // The sheet's entry, by its version: another version is another prefix.
    let sheetEntry = new Entry();
    let sheetVersion = -1;
    let version = 0;
    /** The instructions' TTL in minutes, 0 for no breakpoint (D1810). */
    const sysTtl = (sheetMarked: boolean, now: number): number => {
      if (rule === "always" || sheetMarked) return HOUR_MIN;
      if (rule !== "adaptive" && rule !== "plain") return FIVE_MIN;
      const ttl = system.ttl("t", now);
      return ttl === "1h" ? HOUR_MIN : ttl === "5m" ? FIVE_MIN : 0;
    };
    /** The instructions' price for a send at `t` (a multiple of plain): plain at 1x touches no entry. */
    const sysSend = (t: number, ttl: number) => (ttl === 0 ? 1 : sysEntry.send(t, ttl));
    for (let d = 0; d < DAYS; d++) {
      const base = d * 1440;
      const mine = dayTimes(model, perDay(d), r).map((t) => ({ t: base + t, own: true }));
      const cuts = Array.from({ length: CH_LO + Math.floor(r() * (CH_HI - CH_LO + 1)) }, () => base + r() * 1440);
      // Busy or shared: another check a minute before each of this user's (busy: the same tenant's, by its rule and seen
      // by its policy; shared: another tenant's at five minutes, unseen).
      const events = BOX === "quiet" ? mine : mine.flatMap((e) => [{ t: e.t - 1, own: false }, e]);
      let last = base;
      for (const { t, own } of events) {
        const now = t * 60_000;
        if (!own) {
          if (BOX === "shared") sysEntry.send(t, FIVE_MIN);
          else {
            sysSend(t, sysTtl(false, now));
            system.note("t", now);
          }
          continue;
        }
        version += cuts.filter((c) => last < c && c <= t).length;
        last = t;
        const hash = String(version);
        const marked = rule === "always" ? true : rule === "never" ? false : sheets.mark("u", hash, now);
        let price = sysSend(t, sysTtl(marked, now)) * sysTokens;
        if (marked) {
          if (sheetVersion !== version) {
            sheetEntry = new Entry();
            sheetVersion = version;
          }
          // The sheet's prefix holds the instructions too: alive only while both are, which the hour keeps together.
          price += sheetEntry.send(t, HOUR_MIN) * sheetTokens;
        } else price += sheetTokens;
        total += price / (sysTokens + sheetTokens);
        checks++;
        sheets.note("u", hash, now, marked);
        system.note("t", now, marked);
      }
    }
  }
  return total / checks;
}

const plain = (sysTokens + sheetTokens) * IN;
const USERS_BY_KIND: [string, (day: number) => number][] = [
  ["light (2/day)", () => 2],
  ["typical (6/day)", () => 6],
  ["heavy (16/day)", () => 16],
  ["very heavy (40/day)", () => 40],
  // A user whose habits change: heavy and light weeks in turn (the rules' lag, against the fixed rules).
  ["shifting (16 or 2/day, weekly)", (d) => (Math.floor(d / 7) % 2 === 0 ? 16 : 2)],
  // D1810's very quiet user, last so the rows before keep D1800's seeds.
  ["rare (1/day)", () => 1],
];
const SPACINGS: Spacing[] = ["lab", "poisson", "bursty", "edge"];
console.log(
  `box ${BOX}; instructions ${sysTokens} tokens + sheet ${sheetTokens} tokens, plain $${plain.toFixed(6)} a check; ` +
    `${USERS} users x ${DAYS} days a cell, seed ${SEED}; sheet changes ${CH_LO}-${CH_HI} a day [EST]`,
);
console.log(
  "$ a check for the prefix (x plain); D1810 (plain) against D1800 (adaptive) and the better of always and never",
);
console.log("| user | spacing | always | never | D1800 adaptive | D1810 plain | vs D1800 | vs best fixed |");
console.log("|---|---|---|---|---|---|---|---|");
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
let worst = -Infinity;
let best = Infinity;
let seed = SEED;
for (const [kind, perDay] of USERS_BY_KIND) {
  for (const model of SPACINGS) {
    const s = seed++;
    // The same seed for each rule: the same users, days, sheet changes and other traffic.
    const [a, n, ad, pl] = (["always", "never", "adaptive", "plain"] as Rule[]).map((rule) =>
      run(model, perDay, rule, s),
    ) as [number, number, number, number];
    const vs = pl / ad - 1;
    worst = Math.max(worst, vs);
    best = Math.min(best, vs);
    const $ = (x: number) => `$${(x * plain).toFixed(6)} (${x.toFixed(2)})`;
    console.log(
      `| ${kind} | ${model} | ${$(a)} | ${$(n)} | ${$(ad)} | ${$(pl)} | ${pct(vs)} | ${pct(pl / Math.min(a, n) - 1)} |`,
    );
  }
}
console.log(`\nD1810 against D1800, cell by cell: worst ${pct(worst)}, best ${pct(best)}`);
