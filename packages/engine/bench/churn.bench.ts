/**
 * A heavy user's cache under churn: what a vocabulary that never frees a term costs, and what `releaseTerms` changes.
 *
 * Words come from a Zipf law over a two-million-word universe (rank r drawn as ⌊(1 − u)^(−1/(s−1))⌋, the continuous
 * Pareto tail), so the distinct words seen grow as a power of the words read (Heaps' law), as a mailbox's do. A user
 * is backfilled with 5,000 synced items (D57), then lookups stream 10-item puts through the 2,000-item lookup cap:
 * every put evicts 10 items whose rarer words no live item holds any more.
 *
 * Reported per setting (`releaseTerms` off, then on): the worst put, the worst put that did not rebuild the user (a
 * rebuild swaps in a new `Vocab`), p99 and p50, rebuilds, the vocabulary's id capacity and live terms at the end, and
 * the heap the churned user holds against a fresh build of the same live items. Then the fixed costs a heavy user pays
 * on every put and every expiry tick: a one-item lookup put into a 5,000 synced + 2,000 lookup user, and `expireIdle`
 * over 1,000 users of 3,000 fresh synced items each (nothing expired: every visit is overhead).
 *
 * Run: `bun packages/engine/bench/churn.bench.ts [s=1.3] [lookupItems=20000]`. No model, no network.
 */
import type { ContextItem } from "@eden/protocol";
import { SparseIndex } from "@eden/primitives";
import { ItemCache, type CacheLimits } from "../src/cache";

const S = Number(process.argv[2] ?? 1.3);
const LOOKUP_ITEMS = Number(process.argv[3] ?? 20_000);
const UNIVERSE = 2_000_000;
const SYNCED = 5_000;
const BATCH = 10;

/** xorshift32, seeded: every setting sees the same words. */
function rng(seed: number): () => number {
  let x = seed | 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

/** A word for a rank: letters only (base 26), so no word is numeric and every one is one term. */
function word(rank: number): string {
  let s = "";
  let r = rank;
  do {
    s += String.fromCharCode(97 + (r % 26));
    r = Math.floor(r / 26);
  } while (r > 0);
  return `q${s}`;
}

function zipfWords(next: () => number, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = Math.min(UNIVERSE, Math.floor((1 - next()) ** (-1 / (S - 1))));
    out.push(word(r));
  }
  return out.join(" ");
}

function items(seed: number, n: number, prefix: string): ContextItem[] {
  const next = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}:${i}`,
    sourceId: prefix,
    ref: String(i),
    title: zipfWords(next, 5),
    text: zipfWords(next, 150),
  }));
}

const scope = { tenantId: "t", userId: "heavy" };
const synced = items(1, SYNCED, "drive");
const lookups = items(2, LOOKUP_ITEMS, "mail");
const step = 10; // ms between puts: nothing expires within the run

function heapMb(): number {
  Bun.gc(true);
  return process.memoryUsage().heapUsed / 1e6;
}

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
}

/** Puts the synced backfill, then the lookups from `from` on in `BATCH`-item puts; returns each put's time (ms). */
function build(cache: ItemCache, from: number, times: number[] | null, plain: number[] | null): number {
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < SYNCED; i += 100) cache.put(scope, synced.slice(i, i + 100), t0, true, true);
  let rebuilds = 0;
  let now = t0;
  for (let i = from; i < LOOKUP_ITEMS; i += BATCH) {
    const vocab = cache.peekVocab(scope);
    now += step;
    const a = performance.now();
    cache.put(scope, lookups.slice(i, i + BATCH), now, true);
    const ms = performance.now() - a;
    times?.push(ms);
    if (cache.peekVocab(scope) !== vocab) rebuilds++;
    else plain?.push(ms);
  }
  return rebuilds;
}

/**
 * The heap a cache holds, measured in a child process (`heap <churn|fresh> <on|off>`): heap after building it less the
 * heap before, both after a full GC, with the words generated before. A separate process per build, because JSC's
 * conservative stack scan can keep a dropped cache alive within one.
 */
function heapChild(kind: string, on: boolean): void {
  // The index's insert and query scratch is one copy per process, shared by every user (sized by the largest term id
  // any user has): grown up front so it counts in neither build, whichever crosses a power of two.
  const warm = new SparseIndex({ fields: 2 });
  warm.search(Uint32Array.of(0), 1, 1);
  warm.addFields([Uint32Array.of(1 << 19), Uint32Array.of(0)], [1, 1]);
  warm.search(Uint32Array.of(1 << 19), 1, 1);
  const before = heapMb();
  const cache = new ItemCache({ releaseTerms: on, expireEveryMs: 0 } as Partial<CacheLimits>);
  // The fresh build: the same live items (all synced, the last 2,000 lookups), put once.
  build(cache, kind === "fresh" ? LOOKUP_ITEMS - 2_000 : 0, null, null);
  console.log((heapMb() - before).toFixed(2));
  void cache.peekVocab(scope);
}

function heapOf(kind: string, on: boolean): number {
  const out = Bun.spawnSync([
    process.execPath,
    import.meta.path,
    String(S),
    String(LOOKUP_ITEMS),
    "heap",
    kind,
    on ? "on" : "off",
  ]);
  return Number(out.stdout.toString().trim());
}

function churn(on: boolean): void {
  const cache = new ItemCache({ releaseTerms: on, expireEveryMs: 0 } as Partial<CacheLimits>);
  const times: number[] = [];
  const plain: number[] = [];
  const rebuilds = build(cache, 0, times, plain);
  const v = cache.peekVocab(scope)!;
  const live = (v as { live?: number }).live ?? v.size;
  const churned = heapOf("churn", on);
  const fresh = heapOf("fresh", on);
  const label = on ? "releaseTerms on " : "releaseTerms off";
  console.log(
    `${label}  worst put ${Math.max(...times).toFixed(2)} ms  worst non-rebuild ${Math.max(...plain).toFixed(2)} ms  ` +
      `p99 ${pct(times, 0.99).toFixed(2)} ms  p50 ${pct(times, 0.5).toFixed(3)} ms  rebuilds ${rebuilds}`,
  );
  console.log(
    `${"".padEnd(label.length)}  vocab ids ${v.size}, live ${live}  heap ${churned.toFixed(1)} MB churned vs ` +
      `${fresh.toFixed(1)} MB fresh build of the same live items (${(churned / fresh).toFixed(2)}x)`,
  );
}

function tiny(i: number, prefix: string): ContextItem {
  return { id: `${prefix}:${i}`, sourceId: prefix, ref: String(i), title: "t", text: `word${i % 97} note` };
}

/** One-item lookup puts into a user at both caps (5,000 synced + 2,000 lookup): the fixed cost of a put. */
function heavyPut(limits: Partial<CacheLimits>): number {
  const cache = new ItemCache({ ...limits, expireEveryMs: 0 });
  const t0 = 1_700_000_000_000;
  cache.put(scope, synced, t0, true, true);
  const warm = lookups.slice(0, 2_000);
  cache.put(scope, warm, t0 + 1, true);
  const small = Array.from({ length: 6_000 }, (_, i) => tiny(i, "chat"));
  let now = t0 + 2;
  for (let i = 0; i < 2_000; i++) cache.put(scope, [small[i]!], now++, true); // warm-up (JIT)
  const per: number[] = [];
  for (let r = 0; r < 40; r++) {
    const a = performance.now();
    for (let i = 0; i < 100; i++) cache.put(scope, [small[2_000 + ((r * 100 + i) % 4_000)]!], now++, true);
    per.push(((performance.now() - a) * 1e3) / 100);
  }
  return pct(per, 0.5);
}

/** `expireIdle` over 1,000 users × 3,000 fresh synced items (one shared item list: puts with `sanitized` keep it). */
function tick(limits: Partial<CacheLimits>): number {
  const cache = new ItemCache({ ...limits, expireEveryMs: 0 });
  const list = Array.from({ length: 3_000 }, (_, i) => tiny(i, "drive"));
  const t0 = 1_700_000_000_000;
  for (let u = 0; u < 1_000; u++) cache.put({ tenantId: "t", userId: `u${u}` }, list, t0, true, true);
  const per: number[] = [];
  for (let r = 0; r < 12; r++) {
    const a = performance.now();
    if (cache.expireIdle(t0 + 3_600_000) !== 0) throw new Error("nothing should expire");
    per.push(performance.now() - a);
  }
  return pct(per.slice(2), 0.5);
}

if (process.argv[4] === "heap") {
  heapChild(process.argv[5]!, process.argv[6] === "on");
} else {
  console.log(
    `Zipf s=${S}: ${SYNCED} synced items, then ${LOOKUP_ITEMS} lookup items in ${BATCH}-item puts ` +
      `(lookup cap 2,000; 150 body + 5 title words an item)`,
  );
  churn(false);
  churn(true);
  for (const on of [false, true]) {
    const limits = { releaseTerms: on } as Partial<CacheLimits>;
    console.log(
      `releaseTerms ${on ? "on " : "off"}  one-item put into a 5,000 synced + 2,000 lookup user: ` +
        `p50 ${heavyPut(limits).toFixed(2)} µs`,
    );
  }
  console.log(`expireIdle, 1,000 users x 3,000 fresh synced items: p50 ${tick({}).toFixed(2)} ms`);
}
