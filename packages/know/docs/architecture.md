# Architecture

**Source is closed** (this tree, private Eden). **Dumps are open** (`graph.kpk` — [data.md](data.md)).

Ingest appends triples to `graph.jnl` (zstd frames). Frontier/pages/host/minhash live in packed `crawl.bin` (legacy `graph.sqlite` is folded once, then deleted). Compact freezes the overlay into `graph.kpk` (full in-RAM rewrite of one object). Query and wrap inject
read **the pack only** (`openQueryStore`) so a long ingest writer cannot stall the agent.
Overlay search stays on `openStore` for ingest/tests until the next compact. `eden know query` uses the pack;
ingest then query without compact looks empty.

```
allowed public pages + catalog feeds
        │
        ▼
 ~/.eden/know/graph.jnl     (overlay triples) + crawl.bin (frontier/pages)
        │  compact (fetch published pack → merge overlay → write → If-Match put)
        ▼
 ~/.eden/know/graph.kpk      (KPK9 / KG13: hot RFC titles, 4-bit area column, T_CLOSED catalogs, EG10/EG11 edges)
        │                 (published GitHub Get may still be an older KPK8 freeze)
        │
        ▼
  one fact card  or  { "unknown": true }
```

The pack lives on disk (`~/.eden/know`), never in the SDK tarball. Wrap reads prompt/CoT, extracts needles, injects **one** grounded card as a **system note** (not a tool) or stays silent.

The frontier is not a catalog allowlist: seeds first, then every robots-ok URL (Wikipedia in, listed paywalls out). Wikipedia `/wiki/` pages with no HTML infobox capital get a fail-open Action API section-0 wikitext fetch (robots-ok read API).

Postings for catalog rows are **aliases only** (e.g. `json` → media, `GET` → method). RFC titles, obsoletes/updates, catalog membership, and capitals are **bytes inside `graph.kpk`**. `rfc-titles.bin` / `rfc-edges.bin` are encoder input used to bake those sections; query does not open them. Obscure IANA media subtypes and URI schemes are not packed — they blew the file. SPDX ids `json|xml|html|zip|http|https` are not aliased so `json` stays media. Evidence and page URLs stay off the pack (cards use subject/object). Query prefers the packed typed hit over a WAL RFC-title posting.

TTL exists on WAL rows. Query does not re-fetch stale **packed** facts until the next compact with a new overlay.

Ingest overlay is an append-only zstd journal (`graph.jnl`). Crawl state is `crawl.bin` (not sqlite). Query never opens sqlite. Encode writes **KG13** on large dumps (RFC bitset + hot-title overlay + 4-bit IETF area column, sparse when that wins + EG11/EG10/EG09 edges + T_CLOSED catalog presence) as one brotli-11 inner graph; small dumps stay KG11 (RT14 titles). KPK1–KPK9 still decode. Gold/holdout RFCs keep full titles inside the file. Cold RFC `is` objects are area labels (HTTP, DNS, …) so the dump stays queryable without 5,227 English titles. Decode does not synth RFC-title postings until a title search needs them. Flash/inject uses `rfcTitleHot` / typed synth and does not open `rfc-titles.bin`.

## Query contract

- Fact card ≤ 48 tokens, grounded in the hit’s subject/object/evidence
- Sources stay off the wire
- Empty query and ungrounded text → `{ "unknown": true }` (CLI exit 1 for empty query)
- Extra tokens (`RFC 3986 xyzzy-not-a-token`) stay unknown on `knowQuery`; inject may still card the RFC

## Pack (KPK9 / KG13)

KPK9 encode writes **one dump file that contains the graph**. Large dumps use **KG13**: RFC numbers, a hot-title overlay (gold/holdout RFCs keep full English titles), a 4-bit IETF area column (AS11 sparse when it wins) for every other RFC, EG12 interpolative pair-ids / EG11 residuals / EG10 vbyte edges (bake-off; joint brotli still prefers EG10), T_CLOSED catalog presence when `nTriples` round-trips the freeze, and CI16 capitals in **one compression context** (brotli-11). Hybrid residual edges (EG12 outside the brotli kernel) are baked; they win uncompressed and lose after the joint kernel. Small dumps stay **KG11** (full RT14 titles). Decode keeps the RFC section lazy until a fact or token search needs it. Catalogs, capitals, edges, and hot titles are bytes inside `graph.kpk` — not a pointer at `rfc-titles.bin` / `rfc-edges.bin`. Old dumps (KG10, KG12, RI09 + residual TLV, `KPK9_EDGES` / `KPK9_CAPS` / `T_CLOSED`) still decode. New encode never sets `KPK9_IMPLICIT` or `KPK9_CAT`. Matching closed catalogs are a `T_CLOSED` presence mask inside the file, not a missing section. Official complete IANA media types, URI schemes, SPDX license ids, W3C TR shortnames, and HTTP field names live as codec tabs (`media-type-tab.ts`, `scheme-tab.ts`, `spdx-tab.ts`, `w3c-tab.ts`, `http-field-tab.ts`) — the same class as `charset-tab.ts`, not counted closed-table JSON. New dumps write an `SB01` presence bitset when the dump’s names are a subset of those tabs. Year-directory W3C leftovers that are not official shortnames stay mixed extras (`YR01` year bits). Old exact-closed dumps (`T_CLOSED` bit set and an empty `T_MEDIA` / `T_SPDX` / `T_SCHEME` / `T_SLUG` / `T_HEADER` section) still mean the KEEP English objects, not the full registry. KPK1–KPK8 still decode. Do not gzip or zstd the outer file as the only encoding — `decodePack` reads disk bytes.

Fair agent-load is `graph.kpk`. Flash query may still intern RFC titles from `rfc-titles.bin` for a hot path; compact/decode of a new dump does not require those bins to reconstruct the 8,299 facts. Compact with no local pack and no fetched base would write **only** the WAL overlay (dropping the published graph). Operators with credentials always fetch first. Tests pass a `base` fact list into `compact(base)` for the same merge.

**Compact** still rewrites one object in RAM (the compact host can be fat). **Serving** at terabyte scale is not that object: the agent keeps the hot shard (RFC numbers, IANA/SPDX/W3C catalogs, capitals — today’s ~10 KB fixture class). Wiki/crawl leftovers are a cold shard. Typed locate (`application/json`, `RFC 3986`, `capital of Kenya`) never builds posting lists; a typed miss is silence, not a wiki scan. Token search (CLI title words) may synth or read `T_POST` (PS01) when the dump is large (`POST_PERSIST_MIN`). Query never `GetObject`s the whole dump; `EDEN_KNOW_URL` is a remote hit index for the cold shard only (fail-open, 80 ms). Wrap inject skips token-lane pack search so a TB wiki cannot pollute a card.

## Crawl limits (honest)

- No Playwright. JS-rendered JSON-LD never arrives.
- No generic RDF/XML, Turtle, or RFC PDF extract (xml2rfc HTML/XML titles only).
- CC WET is plaintext: no infobox, JSON-LD, or microdata on that path. Each WET file is scanned `max(2000, kept×40)` records; already-digested URIs, paywall hosts, junk TLDs, and Content-Length < 80 skip UTF-8 decode (header-only reject). Gzip leftover grows geometrically. `wet.paths` slots are shard-exclusive (`shardWetIndex`). WET, CC-NEWS, and CDX fetch in parallel then commit serially. `tickNews` (CC-NEWS) runs from `tick()`.
- Wikidata SPARQL is robots-disallowed; tick does not fetch it. Q-ids with no name are skipped. Capitals come from `synth.ts`, not live Wikidata.
- `liveGetStream` (rfc-index + IANA) enqueues HTTP `Link` targets onto the frontier. It does not inject HTML into the XML body. `liveGet` and WARC bodies still fold `Link` into HTML. Stream fetches send `If-None-Match` when an ETag is cached.
- `parseRfcIndex` drops obsoleted / historic / not-issued RFCs. History only from current entries’ obsoletes/updates; index objects capped at 72 chars. Live RFC HTML `is` objects may be 96 chars in the overlay.
- Each tick batches unseen Wikipedia country articles (Action API, ≤50 titles), re-queues TTL-stale allowed pages (not only catalog hosts), and re-polls origin sitemaps every 24h (lastmod order, sitemapindex children).
- Live outlinks join the frontier when they pass `skipHost` + `junkFrontier` (RFC 9309 on fetch). Catalog hostname is **not** required to enqueue.
- Catalog XML/JSON is skipped for six hours after a successful fetch. Compact keeps 8,000 frontier URLs and 8,000 page rows on disk (was 192 / 48).
- Frontier purge/rank uses hostname patterns (same idea as `qualityHost`), not `LIKE '%needle%'`.
- FineWeb fastText ≥0.65 is **not** in `keepWet` (no 100 MB model). Gopher-style quality, English trigram, fact-bearing (capital / RFC / media / SPDX / IANA / ISO), and MinHash 14×8 (per WET slice) **are**. Registry hosts (IANA, RFC Editor, IETF, W3C, SPDX, Unicode, WHATWG) still keep at length ≥ 80. Wikipedia-family WET must pass Gopher + fact-bearing. Catalog hosts skip language/quality only for those registries.
- Live `admitText` can still admit long English on a normal non-catalog host (junk TLD / cheapSkip / english).
- RFC 9309 path matching includes `*` and `$`. `Disallow: /w/` still needs `wikiReadAllowed` so `/wiki/` is not swallowed.

## Inject

Needles from prompt/CoT; one card. RFC rank 0 beats `application/json` rank 1 when both appear. Direct `application/json` is IANA media, not RFC 4627. DNS `A` is the phrase `DNS A` (lone `A` is not a needle). `DNS HTTPS` is `IANA dns HTTPS`, not the URI scheme. ISC without “license” is not a needle. `about:` / `data:` schemes are not needles. Cards are the necessary English sentence (`application/json is a JSON media type.`, `AAAA is an IP6 Address record.`, `The capital of the United Kingdom is London.`). `Content-Type: text/plain; charset=utf-8` injects the header, not UTF-8. Token-lane needles (rank 9 prose) never open the pack — flash or silence.

Know is a system note, not a wrap tool. There is no “ask Know” tool for facts the needle scanner missed. `EDEN_KNOW=0` disables. Fail-open.

## This package vs wrap

Know injects world facts. Wrap compiles repeated tool calls. They share a private CLI shim (`eden know` → `knowCli`) in the Eden monorepo. This tree must stay import-clean of wrap.
