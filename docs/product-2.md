# Eden Know

Public source of this product is **[KaiavN/eden-know](https://github.com/KaiavN/eden-know)** (MIT). Wrap stays in this private repo. Do not copy this interview/gauntlet document into the public tree.

We present Eden Know, a prototype knowledge graph for agents. It collects public text, discards bloat, and stores entities, relations, and short evidence. At query time a retriever pulls a subgraph and a grounded writer formats one fact card. An agent calls `know("capital of Kenya")` and receives that card — fact, as-of, ttl, confidence — or unknown. Sources stay off the wire.

The prototype we operate this sitting is a **continuous, keyless scraper**: newest Common Crawl WET over HTTPS plus a robots-ok live frontier (`Edenbot/0.1`), written onto a SQLite graph. Wikipedia is **out** of ingest (skip wikipedia/wikimedia/wikidata/wiktionary). English Wikipedia’s **7,228,519** articles (22 August 2026, `.gauntlet/refs/product2/wiki-size.md`) remain **their** corpus, not Know’s. A prior bake-off used Wikipedia + DuckDuckGo Instant Answers only as a writer probe (`results.json` `live.queryTimeCards.kenyaWire`); that is not the store.

To engineer a store that survives the rest of the Web is a different task. Common Crawl’s March 2026 crawl is **1.97 billion pages**, 75.53 TiB compressed (`.gauntlet/refs/product2/cc-scale.md`) — the collection’s size, not our index. Search engines answer tens of millions of queries a day (Brin & Page 1998, `.gauntlet/refs/product2/07-anatomy.md`). Know is built for **one fact per agent turn**.

Uncontrolled collections remain the hard case. Anyone can publish spam, sermons, or a quiet lie. If the store keeps them, it balloons and the writer is handed a fluent falsehood.

## What we build first

Common Crawl WET (HTTPS, no key) + robots-ok live fetch → graph. `Eden.know` on the existing SDK. Retriever + grounded writer → one card, or unknown. Wikipedia APIs are not the ingest.

---

## 1. What this is not

- Not product 1. Product 1 compiles repeating tool stretches so the model never sees them. Know injects **world facts**. Mixing them into a bigger tool catalog would tax the S0/S1 thesis (`docs/ROADMAP.md` §0).
- Not a human search engine. No SERP, no workbench “knowledge explorer,” no hijack of the gated UI rebuild.
- Not “scrape everything reachable.” Robots.txt, ToS, and no-paywall are load-bearing. Blocked hosts are a published hole, not a bug.
- Not an in-RAM vector database of pages. That is how storage balloons and queries get priced like RAM (turbopuffer’s reason to exist: `.gauntlet/refs/product2/02-turbopuffer.md`).

---

## 2. Interview lock

Recorded 2026-08-28 in `.gauntlet/refs/product2/05-interview.md`.

| Fork | Lock |
|---|---|
| User | Agents. Token-efficient, direct, accurate injection. |
| Return shape | Pure answer. Sources unneeded on the wire. |
| Store | **Graph** (entities, relations, compact evidence). Not HTML. Not a warehouse of pre-baked cards. |
| Query | Retriever pulls a subgraph. Grounded writer formats **one fact card**. Raw graph never ships. |
| Scope | Every important public nugget. No paywall, no illegal, no bloat. Opinions are not truth; facts are. Light filter: drop rants/sermons, keep analysis that contains facts. |
| Legal | Honor robots.txt, ToS, no paywall. |
| Expiry | Automatic from signals (change-rate, last-modified, topic volatility). Per-item TTLs. |
| When TTL hits | Crush to **key bits**. Important info stays. Cost drops. Not a naive delete. |
| Languages | English + technical (code, math, standards). Other languages later. |
| Tokens | Tiny-to-small, adaptive. |
| Tenancy | One global brain + customer **adapters** (LoRA analogy): overlays, not copies. |
| Relation | Separate product, **one Eden SDK**. |
| Name | **Eden Know**. |

---

## 3. The hostile web (hard cases, not an appendix)

**You cannot store the internet.** Consecutive crawls re-fetch the same frontier. Summing monthly page counts without `urlkey`+digest dedup double-counts (`.gauntlet/refs/product2/cc-scale.md`). FineWeb’s paper exists because almost all web text is not worth keeping. Collecting “all the information” means all **admitted meaning** onto a graph, not WARCs.

**Robots cut recall.** That is the deal. Live crawl is a delta on allowed hosts plus licensed dumps (Common Crawl, arXiv, standards). We publish the denylist.

**Source-free vs accurate.** The wire is a fact card written at query time. The graph keeps provenance the product can audit. The writer may rephrase; every slot must be grounded in the retrieved subgraph. If it cannot, `unknown` — a fluent wrong answer with no URL is worse than silence. This split is non-negotiable.

**Quiet falsehoods.** Cho & Garcia-Molina model page *changes* as Poisson (`.gauntlet/refs/product2/ttl-cho.md`). A page can be stable and wrong, or noisy and right. TTL from change-rate alone will keep a quiet lie and expire a noisy truth. Type prior + observed λ + contradiction checks. Change-rate is necessary, not sufficient.

**Opinion filter is a measured trade.** Light means rants/sermons out, analysis-with-facts in. A sermon that contains a true date will sometimes survive; a furious post that happens to state a capital will sometimes die. We measure precision/recall on a labeled slice every ingest generation. We do not hide this in a prompt.

**Retrieval collapse.** At web scale the failure is the wrong subgraph, not zero nodes. Anthropic’s contextual retrieval (their eval): top-20 failure 5.7% → 3.7% (contextual embeddings) → 2.9% (contextual BM25+embeddings) → 1.9% with rerank (`.gauntlet/refs/product2/contextual-retrieval.md`). Know still must **not** dump those twenty chunks into the agent. Retrieve a neighborhood; write one card. Microsoft GraphRAG’s community reports are ingest-time cards — refused. **LazyGraphRAG** extracts claims at query time (closest public recipe). HippoRAG-style: graph at ingest, walk at query (`.gauntlet/refs/product2/query-time-card.md`).

**Adapters that copy the world lose.** A customer overlay is a delta index (private docs, aliases, denylist, boosts). Not a second FineWeb per tenant. Not a fine-tune of the global brain unless a later eval beats a delta index on overlay queries *and* does not duplicate global bytes.

---

## 4. Bake-off (measured here)

Runnable: `bun .gauntlet/benches/product2/bench.ts`. Numbers: `.gauntlet/benches/product2/results.json`. **420 documents, 36 queries, 68 fact-docs. This ranks methods. It is not Common Crawl scale.**

### Storage

Uncompressed **graph** (68 nodes: slots + compact evidence) was **2.7%** of page HTML. Ingest-time fact cards were 5.9% — a baseline, not the store. Key bits were **23.9%** of those fact cards.

| Form | Raw bytes | Best compressed (brotli-11) | Fast compressed (brotli-4) |
|---|---:|---:|---:|
| Pages | 237,383 | 2,415 | 2,878 |
| Fact cards (ingest-time baseline) | 13,976 | 1,333 | 1,581 |
| **Graph** (the store) | **6,368** | **923** | 1,105 |
| Key bits | 3,342 | 624 | 750 |

Compress p50 milliseconds jitter by machine and run; this sitting is in `results.json` (`pages_brotli11.ms`, `pages_brotli4.ms`, …). Bytes above are the hop a critic should use.

**Pinnacle at this scale:** do not store pages as the knowledge. **Store a graph** (entities, relations, short evidence). Write the fact card **at query time** from a retrieved subgraph. Ingest-time cards are a baseline in the bake-off, not the product. Key bits are expired graph rows with evidence dropped. **brotli-4 or zstd-3** on the ingest path. **brotli-11** on the cold compact. Eden product 1 already refuses gzip when it is not smaller (`apps/site/src/cache-compress.ts`); Know keeps that rule.

Toy HTML repeats a nav/footer, so page compression looks magically good (1%). The graph-vs-page **uncompressed** ratio (2.7%) is the fairer lesson: keep meaning, drop HTML.

### Near-duplicate

Planted 24 near-mirrors. Exact SHA unique texts stayed **420** (mirrors were not byte-identical).

| Method | Caught planted dups | Kept of 420 |
|---|---:|---:|
| SimHash 64-bit, k=3, raw pages | 22/24 | 44 |
| SimHash on facts / stripped text | 24/24 | 71 |
| FineWeb-shaped MinHash (word 5-gram, 14×8 **band hit**, chrome-stripped pages) | 23/24 | **340** |
| Same MinHash on fact strings | 24/24 | 339 |
| MinHash Jaccard ≥0.85 | 23/24 | **35** |

FineWeb’s 14×8 **is their merge at 15T tokens** (paper). On 420 docs, the same band-hit barely collapses (kept 340) because collision probability is tuned for a crawl, not a toy. Jaccard ≥0.85 is **this sitting’s extra merge**, not a FineWeb correction: it kept 35 and still missed 1/24. SimHash on raw HTML over-collapses chrome (kept 44). **Pinnacle at dump scale:** FineWeb’s 5-gram 14×8 after extract, as published. **Pinnacle on a toy:** also report a Jaccard/SimHash merge so we do not pretend 14×8 collapsed the corpus. Do not MinHash 5-grams of a six-word card and call it FineWeb — 6 fact-strings in this sitting had fewer than five word tokens.

### Opinion (light heuristic, planted)

Precision **1.000**, recall **1.000** (50 trash / 370 keep) after ignoring shared chrome. This only proves the filter can implement the interview lock on a toy. Web-scale needs a labeled holdout and will not stay at 1.0.

### Retrieval and injection

| Method | R@1 | fact-match | avg inject tokens |
|---|---:|---:|---:|
| Linear scan of pages | 0.972 | 0.972 | 29.8 |
| BM25 on pages | 0.972 | 1.000 | 30.0 |
| BM25 on fact cards (wrong store) | 1.000 | 1.000 | 19.8 |
| **BM25 on graph** | **1.000** | **1.000** | 12.1 |
| Hash-trick “dense” on facts | 0.833 | 0.833 | 20.2 |
| Hybrid RRF (BM25+hash-dense) | 1.000 | 1.000 | 19.8 |
| Inject top-5 page chunks | 0.972 | 1.000 | 30.0 |
| Inject ingest-time card | 1.000 | 1.000 | 6.8 |
| Inject **raw subgraph** | 1.000 | 1.000 | **37.7** |
| Inject **query-time card** | **1.000** | **1.000** | **6.8** |
| Inject ungrounded fluent lie | 0.028 | 0.028 | 7.0 |
| Inject adaptive (1, then 3) | 1.000 | 1.000 | 6.8 |

**Pinnacle at this scale:** BM25 (or learned-sparse later) over the **graph**, not over pages. **Query-time card** to inject. Ingest-time one-card lookup is the baseline (same wire, wrong store). Hash-trick embeddings lost 17 points of R@1 — do not pretend this is a transformer. Returning the raw subgraph is the token trap the user rejected. At web scale, published work still wants sparse first-stage plus optional rerank; dense-in-RAM is the cost trap turbopuffer exists to avoid.

### Fact extractors (measured here)

Unique fact-docs (no planted mirrors). Coverage = gold fact string found in the extractor output.

| Extractor | Gold coverage | Bytes |
|---|---:|---:|
| Full page text | 1.000 | 13,559 |
| First sentence | 0.824 | 5,865 |
| Heuristic fact sentences | **0.985** | 8,609 |
| Planted gold (upper bound) | 1.000 | 2,579 |

**Pinnacle:** a fact extractor, not “the first sentence” and not “keep the page.” Heuristic almost matches planted gold and is still 3.3× the gold bytes — the remaining gap is a better extractor (IE / model), ranked on a labeled web slice, not this toy. Planted gold is the storage floor, not a method we have.

### TTL

Gold TTLs were mostly type-shaped (wiki years, news days, code months). Mean relative error vs gold:

| Policy | Mean rel. err. |
|---|---:|
| Uniform 30 days | 1.168 |
| **Type table** (wiki 5y, SI constants 10y, code 90d, news 7d) | **0.231** |
| Change-rate only | 0.458 |
| Type prior then √(prior × 1/λ) | 0.353 |

**Pinnacle:** type table as **prior** (news days, code ~90d, wiki years, SI defining constants a decade). Then **update λ** from recrawl (changed or not), Last-Modified, Cache-Control. Do not let a silent medical page live ten years without an authority/contradiction check (`09-hard.md` §5). Our blend (0.353) lost to pure type (0.231) because the gold *was* the type table — a real crawl will not be.

### Ingest filters (measured here)

| Gate | Docs kept of 420 |
|---|---:|
| Keep all | 420 |
| Robots-ok (skip `Disallow`) | 300 (120 blocked) |
| Robots + light opinion | 270 |
| Robots + opinion + has a fact | **68** |

That is the FineWeb lesson on a toy: **most URLs are not knowledge**. The 68 are what the index is for.

RFC 9309 longest-match holdout (Allow longer than Disallow, empty Disallow, UA-specific `/secret`, `Disallow: /`) passed **4/4**, independent of the planted corpus flags (those also agreed 420/420, which only proves the parser matches the flags the funnel used).

### Live year-zero ingest (measured this sitting, public APIs, no key)

DuckDuckGo Instant Answers (`api.duckduckgo.com`, `t=eden-know`):

| Query | HTTP | Boxed fact? | Notes |
|---|---:|---|---|
| capital of Kenya | 200 | **no** | Empty abstract and answer. Instant Answers are not a SERP. |
| speed of light | 200 | **yes** | 17-character `Answer`; type D; AbstractURL is Wikipedia. |
| zzzzzxqnotatopic999 | 200 | **no** | Empty on junk is a pass. |

Wikipedia (contactable UA `EdenKnow/0.1`, REST summary + opensearch):

| Call | HTTP | Result |
|---|---:|---|
| `/page/summary/Kenya` | 200 | 972 chars; needle **Nairobi** in `needleSnippet` (`results.json`) |
| `/page/summary/Capital_of_Kenya` | 200 | 420 chars; preview starts with Nairobi |
| `/page/summary/Speed_of_light` | 200 | 748 chars; needle **299792458** in `needleSnippet` |
| opensearch `capital of Kenya` | 200 | title **Capital of Kenya** |

Query-time cards from those extracts (`results.json` `live.queryTimeCards`):

| Query | Evidence | Wire |
|---|---|---|
| capital of Kenya | Kenya country page (972 chars) | **“The capital of Kenya is Nairobi.”** 6 tokens, grounded |
| capital of Kenya | Capital of Kenya page (420 chars) | **same card**, 6 tokens, grounded |
| speed of light | Speed of light page | copied sentence, 16 tokens, grounded (includes 299792458) |

DDG Instant Answer for speed of light was `299 792 458 m / s` (17 chars) — a boxed fact, still not the Wikipedia sentence. Kenya Instant Answer stayed empty; the writer did not invent Nairobi from DDG.

**Pinnacle for year zero:** land extracts on the graph. Write the card at query time. Do not ship the 972-character lead. Do not pre-bake a Kenya card at ingest.

### Expiry → key bits (measured here)

Simulated `now = 20 days`. 65 cards still current, 3 expired. Those 3 queries **did not leak** into the current BM25 (leak rate 0). Key-bit BM25 `as_of` hit **2 of 3** (0.667) — not 1.0. Adding the page title as an alias in the tuple recovered **3 of 3**. The 0.667 is the honest default-shape number: a key bit that is only `{s,p,o}` can drop the words a later query uses. Production key bits need aliases. Three queries is a toy; do not quote 1.000 without the alias arm (`results.json` `expiryCompact`).

---

## 5. Published numbers we are not re-measuring

Labeled **cited**, not ours.

- FineWeb: 96 CC dumps → 15T tokens; MinHash 5-gram 14×8 per crawl; language ≥0.65; FineWeb-Edu 1.3T with MMLU/ARC gains. Paper: arXiv 2406.17557.
- English Wikipedia: **7,228,519** articles as of 22 August 2026 (`.gauntlet/refs/product2/wiki-size.md`).
- Common Crawl Mar 2026: 1.97B pages; WARC 75.53 TiB; WET 5.63 TiB.
- turbopuffer: object storage source of truth; cited ~$70/TB/mo S3+SSD cache vs ~$600 3×SSD vs ~$3600 RAM+SSD; warm p50 ~14 ms / cold p50 ~874 ms on 1M docs; SPFresh centroids not HNSW (roundtrips). Vendor.
- Anthropic contextual retrieval: failure@20 5.7% → 2.9% (contextual BM25+embeddings) → 1.9% (+rerank). $1.02 / million document tokens to contextualize with prompt cache. Apply to **surviving facts**, not every WARC.
- Cho & Garcia-Molina: Poisson changes; refresh proportional to λ beats uniform polling.
- Brin & Page 1998: uncontrolled collections — anyone can publish anything. That sentence is why we filter.

---

## 6. Pinnacle architecture

One pipeline. Names are functions, not vendors.

```
allowed fetch (CC **WET/WARC** HTTPS | robots-ok live recrawl + sitemaps; **not** Wikipedia)
    → extract main text
    → language + quality + light opinion + PII
    → exact hash + SimHash (extracted text); FineWeb 5-gram 14×8 per crawl (as published)
    → graph: entities, typed relations, compact evidence + internal provenance
    → TTL on nodes/edges = type prior ⋈ observed λ ⋈ volatility
    → index: sparse BM25/learned-sparse on graph text; object-store truth; SSD/RAM hot set
    → know(): retrieve subgraph → grounded writer → one card | unknown
    → on expiry: drop evidence, keep key bits (s,p,o,as_of), provenance retained
    → customer overlay: delta graph, queried first, never a global copy
```

### 6.1 Ingest

Year zero (user lock, 2026-08-28, Wikipedia withdrawn the same day): **no paid crawler, no API key, not Wikipedia.** Loop on **Common Crawl HTTPS** (`collinfo.json` → `wet.paths.gz` → stream `.wet.gz`) plus **polite live GET** of a robots-ok frontier (`Edenbot/0.1`, RFC 9309, Crawl-delay, bounded sitemaps). Unofficial DuckDuckGo HTML scrapers are out. Instant Answers / Wikipedia APIs are not the store (`.gauntlet/refs/product2/year-zero-ingest.md`, `.gauntlet/refs/product2/free-scraper.md`). Self-cap live QPS; cache robots.txt. CLI: `eden know run`.

Common Crawl **WET** is the laptop **volume** path (still keyless). FineWeb measured Trafilatura on **WARC** beating WET for quality — WET is a bandwidth option, not a quality claim. Incremental live recrawl for high-value allowed hosts, rate-limited. Do not claim a 2-billion-URL frontier from one machine.

**Robots are operational, not a slogan.** RFC 9309 (`.gauntlet/refs/product2/rfc9309.md`): parse `/robots.txt` for a documented product token (`Edenbot`; public bot page). Longest Allow/Disallow wins. Cache robots.txt; back off on 5xx. `Crawl-delay` is not in the RFC ABNF; Common Crawl still honors it — so do we. `Disallow: /` is a skip. This sitting’s bake-off parses those groups rather than only flipping a boolean.

**Common Crawl is not a waiver.** Their ToU (`.gauntlet/refs/product2/cc-tos.md`, updated 7 Mar 2024) says crawled content may still be under the **origin site’s** terms, recommends counsel before commercial use, and indemnity explicitly mentions AI/LLMs. Historical WARCs can contain pages whose **today’s** robots/ToS forbid us. Re-check before serving; publish the recall hole.

WET is 13× smaller than WARC in March 2026. That is a **storage** fact, not a quality win. Keep a content digest to recrawl, not HTML, after Trafilatura. Retry WARC bytes only if the extractor fails.

### 6.2 What we keep (FineWeb, pointed at facts)

URL blocklist (malware, NSFW, paywall hosts). Main-text extract (Trafilatura-class). English + code/math/standards with language score **≥ 0.65** (FineWeb lock). Quality: Gopher/C4-class repetition and FineWeb line heuristics. Light opinion. **MinHash word 5-gram, 14×8, per crawl after extract** — FineWeb’s published merge at dump scale. This sitting also ran Jaccard ≥0.85 (kept 35 vs 14×8 band-hit 340) as a **toy observation**, not a correction of the paper. Then **write a graph**, not a card warehouse: entity nodes, typed edges, short evidence, provenance ids. Pages are a recrawl digest, not the product. Microsoft GraphRAG’s index-time community summaries are the architecture we refused (`.gauntlet/refs/product2/query-time-card.md`).

### 6.3 Storage without ballooning

Three tiers, one object-storage truth (turbopuffer-class engine or an equivalent LSM we do not invent in v0):

| Tier | What | Codec | Query |
|---|---|---|---|
| Hot | Current graph neighborhood (nodes/edges + short evidence) | uncompressed or zstd-3 / brotli-4 | <20 ms modeled once cached |
| Warm | Graph on object storage | brotli-4 | cold hundreds of ms cited |
| Cold | Expired **key bits** (`s,p,o,as_of`) | brotli-11 | not on the default `know()` path |

Key bit: `{s, p, o, as_of, conf}` — the interview’s “important info stays, costs less.” Evidence is what we drop first on expiry. Recrawl can rehydrate evidence from key bits + a new page. A fact card is **not** a tier; it is an ephemeral wire object. This sitting: graph **923** bytes brotli-11 vs fact cards **1,333** vs pages **2,415** vs key bits **624**.

Workspace isolation for overlays mirrors product 1: overlay keys include customer id. Global shards do not.

### 6.4 Retrieval that does not melt

First stage: inverted index over **graph node/edge text** (BM25, then Expanded-SPLADE if a holdout says it pays). Optional hybrid with a **small** dense index of nodes, not pages. Rerank only the top few dozen. Then the grounded writer. Contextual one-liners, if any, on surviving nodes — not $1/M tokens on discarded HTML.

Do not lead with HNSW-in-RAM. Centroids / blocks that survive object-storage roundtrips (SPFresh lesson).

### 6.5 Expiry

On ingest, assign `ttl_days` on each node/edge from the type prior, then set `λ` unknown. Each recrawl: if changed, raise λ; if not, lower. `ttl_days = clamp(prior ⋈ 1/λ)`. When `now > as_of + ttl`:

1. Write key bits to cold (`s,p,o,as_of`).
2. Drop evidence and drop the live edge from the default index (so `know()` does not treat it as current).
3. Keep provenance. Optional `know(q, { as_of })` for forensics, not the agent default.
4. Schedule recrawl sooner if the topic is volatile.

### 6.6 Injection

Default: retrieve a subgraph, **write one fact card**, ~tens of tokens. The writer may rephrase; it may not invent a slot. Never twenty chunks. Never a triple dump. Never a bibliography. Ungrounded or low confidence → `{ unknown: true }`.

Token budget: interview asked for tiny-to-small adaptive. The bake-off compares ingest-time cards, query-time cards, raw subgraphs, and an ungrounded fluent lie (`results.json`). Production cards will be longer than toy sentences; still a card, not a page or a graph.

### 6.7 SDK (unified)

Today `Eden.runTool` talks to `/v1/wrap`. Add on the same class, same `Opts`:

```ts
know(query: string, opts?: { adapter?: string }): Promise<
  | { fact: string; as_of: string; ttl_days: number; confidence: number }
  | { unknown: true }
>
```

Same base URL family, same API key, same protocol header. A miss or an HTTP error becomes `{ unknown: true }` — **fail open** relative to product 1. Know is never a tool the model must pick.

Customer adapter: `opts.adapter` or a key-scoped overlay. Query overlay BM25 first; if it hits with high confidence, return that; else global. Overlay bytes billed. Global not copied.

---

## 7. Modeled cost (labeled modeled)

Assumptions, not invoices: this sitting’s graph is **~94 bytes/node** uncompressed (6,368 / 68). **Modeled** 1B nodes × 94 bytes ≈ 94 GB uncompressed ≈ **~10–20 GB** brotli-4 if the 0.14–0.18 graph ratios hold — a **rough** prior, not a CC measurement. A conservative 400 bytes/node (attributes, aliases, provenance ids the toy omitted) **models ~400 GB** uncompressed. Object storage ~$20/TB/mo cited by turbopuffer → **modeled a few dollars to tens of dollars a month for cold bytes**, plus query/cache. The expensive part is **ingest compute, recrawl bandwidth, and query-time writing**, not disk, if we refuse to store HTML.

Contextualizing every discarded page at $1.02/M tokens is modeled-waste. Contextualize graph nodes that survive.

A from-scratch crawl of “the internet” on one laptop is modeled-unaffordable. Year zero **volume** is Common Crawl (already fetched, free HTTPS) plus a robots-ok live delta onto the graph. That path survives bars 1, 5, and 9. Wikipedia is not the ingest.

---

## 8. Build order (what a critic can open each step)

1. **Schema + SDK.** Graph node/edge + key bit types. `Eden.know` stub returns `unknown`. Tests: fail-open, no second package, protocol header. **Done when:** `bun test` on sdk-js includes `know`.
2. **Year-zero live loop.** Common Crawl WET slices + robots-ok live frontier, no key, **written onto the graph** (not stored as cards). Wikipedia hosts skipped. **Done when:** `eden know run --once` grows `pages`/`nodes` and `eden know status` prints counts.
3. **Dedup + opinion holdout.** SimHash on extracted text; labeled rant/analysis set. **Done when:** over-collapse on chrome is gone (kept count ≈ unique extracted docs).
4. **Query-time writer.** Grounded card from subgraph; ungrounded fluent lie fails. **Done when:** `inject_query_card` matches gold without shipping triples, and `inject_ungrounded` does not.
5. **TTL + key-bit compact.** Type prior, λ update, drop evidence, keep `{s,p,o}`. **Done when:** expired edges leave default index; key bits still answer an `as_of` query.
6. **Overlay.** One customer delta graph, no global copy (byte accounting test).
7. **Continuous recrawl.** Conditional GET on the allowed hot set. ETag path reused from product 1 cache thinking.

No UI phase. No landing-page numbers until a file in `packages/measure` says so (product 1 rule).

---

## 9. What would make this plan wrong

- If a labeled web holdout shows query-time cards lose >5 points of answer accuracy vs shipping a short evidence span after we have a real writer — then we still do not ship pages; we may copy a span into the card schema.
- If learned-sparse at our scale is cheaper *and* more accurate than BM25 on a holdout — swap first stage; keep the graph and the query-time card.
- If object-storage cold latency is unacceptable for the first `know()` in a session — pin the global hot namespace (turbopuffer’s pin) or keep a resident BM25 of current graph text.
- If lawyers say CC text cannot be served as answers in our jurisdiction — we stop at licensed corpora and publish the hole.
- If overlay customers actually need a private *copy* for air-gap — that is a different SKU with honest duplicate bytes, not the default.
- If a holdout shows GraphRAG-style community summaries beat a live walk on *global* questions — materialize those as optional overlay objects, still through the grounded card schema, still not the default store.

---

## 10. Open questions still worth asking

- Who labels the first 5k opinion/quality holdout rows?
- Is `know()` allowed to say “unknown” on breaking news inside the TTL, or must we recrawl first?
- Adapter as query-time boost only, vs a tiny embedding adapter (true LoRA) later?

Until those are answered, the defaults are: newest CC **WET** over HTTPS plus robots-ok live recrawl (not Wikipedia), Trafilatura on **WARC** as the quality dump when bandwidth allows, us labeling a seed set, recrawl before serving a volatile topic, query-time delta index not model LoRA.

---

## 11. Map to the ten locked comparisons

| # | Comparable | How this plan wins instead of copying |
|---|---|---|
| 1 | FineWeb | Same discard; Trafilatura on **WARC**; 5-gram 14×8 **as they published**. Graph + TTL after keep, which FineWeb never had. Jaccard on 420 docs is a toy, not a paper correction. |
| 2 | turbopuffer | Same object-storage truth for the **index**, not the product; product is graph + query-time cards. |
| 3 | Eden cache | gzip/brotli only if smaller; tenant keys; fail-open; 30-min session TTL is **not** knowledge TTL. |
| 4 | Claim protocol | Every number above is results.json or a refs file, or says modeled. |
| 5 | Interview | Graph store, query-time card, name, wire shape, robots, adapters, key bits — §§1–2 and 6. |
| 6 | Primary path | This first screen, including “What we build first.” |
| 7 | Anatomy | Problem → system → scale → hostile collection, before a vendor list. |
| 8 | Live bake-off | §4, re-run command. Query-time card vs ingest card vs raw subgraph vs ungrounded lie. |
| 9 | Hard cases | §3. |
| 10 | Fit | §6.7: one SDK, fail-open, no extra tools, overlays not copies. |
