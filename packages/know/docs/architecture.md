# Architecture

Ingest writes a SQLite WAL. Query reads the WAL overlay plus a frozen pack.

```
allowed public pages + catalog feeds
        │
        ▼
 ~/.eden/know/graph.sqlite   (WAL: intern, nodes, lean postings)
        │  compact
        ▼
 ~/.eden/know/graph.kpk      (KPK5: typed ids, aliases, bloom)
        │
        ▼
  one fact card  or  { "unknown": true }
```

SQLite is the ingest journal. The pack is what query time is built for: typed RFC/IANA/SPDX ids, derived W3C hyphen aliases, and a term bloom so unknown queries (Kenya, empty junk) return without a full-graph scan.

Postings for catalog rows are **aliases only** (e.g. `json` → media, `GET` → method). Every IANA media subtype is not indexed — that blew the pack. SPDX ids `json|xml|html|zip|http|https` are not aliased so `json` stays media.

## Query contract

- Fact card ≤ 48 tokens, grounded in the hit’s subject/object/evidence
- Sources stay off the wire
- Empty query and ungrounded text → `{ "unknown": true }` (CLI exit 1 for empty query)

## Pack (KPK5)

Encode magic is KPK5. Decode accepts KPK1–KPK5. Kinds 0–15 live in `src/pack.ts`. Do not gzip the whole file, mmap at this size, or resurrect PFOR/Roaring/Hexastore without a measured win against the current pack.

## This package vs wrap

Know injects world facts. Wrap compiles repeated tool calls. They share a private CLI shim (`eden know` → `knowCli`) in the Eden monorepo. This tree must stay import-clean of wrap.
