/**
 * The request glossary's cost a process (D1153, D1710): what loading it adds to RSS and heap, how long the load
 * takes, and `glossOf`'s time a request, English and not. Each run is a fresh process (the load happens once a
 * process); the parent prints the median of the runs and every run.
 *
 *   bun packages/engine/bench/gloss.bench.ts [runs=3] [fuzz=50000] [--served]
 *
 * `GLOSS_MODULE=/path/gloss.ts` measures another copy of the module (its own `gloss.bin` beside it), such as the
 * version 1 reader for a before/after.
 *
 * RSS is read before the load (after a full GC) and 1.5 s after it (after another), as the tech audit measured it:
 * after `warmGlossary` (`rssLoadMB`), after 2,000 English requests (`rssEnglishMB`: an English-only process; the
 * `ENGLISH` set has contractions and possessives, and `lexAfterEnglish` says whether they read the lexicons), and after
 * the first request in
 * another language (`rssWholeMB`: the whole glossary held; `firstOtherMs` is that request's time, the lexicons' read
 * since D1710). `rssAfterMB` is after the fuzzed corpus, which it holds too.
 * Latency: every request timed alone (Bun.nanoseconds), after a warm-up pass; English is `ENGLISH` repeated, the rest
 * is `fuzzCorpus` over the shipped words (seed 1710, the differential test's).
 */
import { heapStats } from "bun:jsc";
import { readFileSync } from "node:fs";
import { ENGLISH, fuzzCorpus } from "./gloss-corpus";

const args = process.argv.slice(2);

/**
 * The process's anonymous (private) resident memory in MB, from /proc (0 where there is none). RSS also counts the
 * Bun binary's code pages a step touches for the first time, which every process on the machine shares.
 */
function anon(): number {
  try {
    const m = readFileSync("/proc/self/smaps_rollup", "utf8").match(/^Anonymous:\s+(\d+)/m);
    return m ? Number(m[1]) / 1024 : 0;
  } catch {
    return 0;
  }
}

if (args[0] === "--child") {
  const fuzz = Number(args[1]);
  // The module and its imports first: the baseline is a process with the code and no glossary.
  const { glossOf, glossWords, warmGlossary } = await import(process.env.GLOSS_MODULE ?? "../src/gloss");
  if (args.includes("--served")) {
    await serve();
    // Until what serving left to collect is gone: the baseline must not shrink under the load.
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(1_000);
      Bun.gc(true);
    }
  }
  Bun.gc(true);
  const rss0 = process.memoryUsage().rss;
  const anon0 = anon();
  const heap0 = heapStats().heapSize;
  const t0 = performance.now();
  const g = warmGlossary();
  const loadMs = performance.now() - t0;
  await Bun.sleep(1_500);
  Bun.gc(true);
  const rssLoad = process.memoryUsage().rss - rss0;
  const anonLoad = anon() - anon0;
  // English requests first: what a process that never sees another language pays.
  const en: number[] = [];
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < 2_000; i++) {
      const text = ENGLISH[i % ENGLISH.length]!;
      const s = Bun.nanoseconds();
      glossOf(text, g);
      if (pass === 1) en.push((Bun.nanoseconds() - s) / 1_000);
    }
  await Bun.sleep(1_500);
  Bun.gc(true);
  const rssEnglish = process.memoryUsage().rss - rss0;
  // Whether English traffic (contractions and possessives included) read the lexicons: 1 or 0; -1 for a reader with
  // no lazy part (version 1).
  const lexAfterEnglish = typeof g?.readLex === "function" ? (g.lex !== undefined ? 1 : 0) : -1;
  // The first request in another language: since D1710 it reads the lexicons.
  const t1 = performance.now();
  glossOf("Domani voglio spostare 5.000 sterline dai risparmi al conto corrente.", g);
  const firstOtherMs = performance.now() - t1;
  await Bun.sleep(1_500);
  Bun.gc(true);
  const rssWhole = process.memoryUsage().rss - rss0;
  const anonWhole = anon() - anon0;
  const words = glossWords(g!);
  const corpus = fuzzCorpus(words.langs, words.english, fuzz);
  const other: number[] = [];
  for (let pass = 0; pass < 2; pass++)
    for (const text of corpus) {
      const s = Bun.nanoseconds();
      glossOf(text, g);
      if (pass === 1) other.push((Bun.nanoseconds() - s) / 1_000);
    }
  Bun.gc(true);
  const pct = (xs: number[], p: number) =>
    xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
  console.log(
    JSON.stringify({
      loadMs,
      rssLoadMB: rssLoad / 2 ** 20,
      anonLoadMB: anonLoad,
      rssEnglishMB: rssEnglish / 2 ** 20,
      lexAfterEnglish,
      firstOtherMs,
      rssWholeMB: rssWhole / 2 ** 20,
      anonWholeMB: anonWhole,
      rssAfterMB: (process.memoryUsage().rss - rss0) / 2 ** 20,
      heapMB: (heapStats().heapSize - heap0) / 2 ** 20,
      enP50: pct(en, 0.5),
      enP99: pct(en, 0.99),
      otherP50: pct(other, 0.5),
      otherP99: pct(other, 0.99),
    }),
  );
  process.exit(0);
}

/**
 * `--served`: the baseline is a process that has already served (a partner with the glossary off, 300 events of the
 * pipeline bench's workload), as a router child has: the runtime's own code pages that any work touches (fs, Buffer,
 * Set, regex) are then resident before the glossary loads, and what the load adds is the glossary's.
 */
async function serve() {
  const { SourceMap } = await import("@eden/graph");
  const { Budget } = await import("@eden/llm");
  const { ContextPartner, ItemCache } = await import("../src/index");
  const { buildWorkload } = await import("./workload");
  const w = buildWorkload({ itemsPerSource: 300, events: 300, seed: 7 });
  const partner = new ContextPartner({
    sources: async () => w.sources,
    sourceMap: new SourceMap(),
    cache: new ItemCache({}),
    budget: new Budget(),
    model: null,
    config: { requestGloss: false },
  });
  for (const event of w.events) {
    await partner.observe(event, { waitMs: 0 });
    await Bun.sleep(0);
  }
}

const served = args.includes("--served");
const plain = args.filter((a) => !a.startsWith("--"));
const runs = Number(plain[0] ?? 3);
const fuzz = Number(plain[1] ?? 50_000);
const rows: Record<string, number>[] = [];
for (let i = 0; i < runs; i++) {
  const p = Bun.spawnSync(
    [process.execPath, import.meta.path, "--child", String(fuzz), ...(served ? ["--served"] : [])],
    { stderr: "inherit" },
  );
  rows.push(JSON.parse(p.stdout.toString()));
}
const med = (k: string) => rows.map((r) => r[k]!).sort((a, b) => a - b)[Math.floor(rows.length / 2)]!;
const keys = Object.keys(rows[0]!);
console.log(`median of ${runs} (fuzz ${fuzz}${served ? ", served baseline" : ""}):`);
for (const k of keys)
  console.log(`  ${k.padEnd(14)} ${med(k).toFixed(2)}   runs: ${rows.map((r) => r[k]!.toFixed(2)).join(" ")}`);
