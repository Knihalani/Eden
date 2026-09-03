# Open data (code is private)

Eden Know’s **ingest and retrieval code is closed**. What we publish is the **graph snapshot**: a `graph.kpk` pack anyone can download.

Public landing (robots / contact): [Knihalani/eden-know-data](https://github.com/Knihalani/eden-know-data).
Public file (this dump): [KaiavN/eden-know-data](https://github.com/KaiavN/eden-know-data) (`graph.kpk`).

## Live dump

- Magic this tree encodes: **KPK9** (KPK1–KPK8 and old KPK9 KG10/KG11/KG12 dumps still decode). Large dumps encode **KG13**: hot RFC titles, a 4-bit IETF area column, T_CLOSED catalog presence, EG10/EG11 edges, and CI16 capitals in one brotli-11 kernel. Titles for gold/holdout RFCs, edges, catalogs, and capitals are **inside** `graph.kpk`. A fingerprint over `rfc-titles.bin` is not a valid encode.
- Query inflates the RFC section and the catalog residual separately. Not whole-file-only gzip. RFC-number search does not synth title postings.
- Public Get on GitHub is still the **KPK8 15,317 B** freeze (SHA-256 `99debba93441f2381eac864ee99c941207cb7c930894db92cfae4462bdab604d`) until operators run compact/dump. That freeze still omitted titles from the file.

https://raw.githubusercontent.com/KaiavN/eden-know-data/main/graph.kpk

Operator replica on **Impossible Cloud**: `s3://eden-know/graph.kpk` (endpoint `https://us-east-1.storage.impossibleapi.net`, region `us-east-1`). Compact fetches that object before merge and uploads with If-Match. The vendor does **not** implement `PutBucketPolicy` or object ACLs, so that replica is not an anonymous URL. Do not use a rotating pre-signed URL as the public dump (they expire in minutes–hours).

The pack is not shipped inside any SDK tarball. Agents read `~/.eden/know/graph.kpk` (or `EDEN_KNOW_DIR`) at query time.

## Zero-egress host

**Impossible Cloud** (S3-compatible). Storage is billed; **egress and API calls are $0**. Endpoint is the S3 API (`aws s3 … --endpoint-url https://us-east-1.storage.impossibleapi.net`, region `us-east-1`). Hugging Face Datasets can mirror the same file later for discovery.

Do **not** put a large dump on GitHub **Releases** or AWS S3: egress is metered. The public Get is GitHub raw on [KaiavN/eden-know-data](https://github.com/KaiavN/eden-know-data) (KPK8 freeze 15,317 B until the next compact). Impossible Cloud is the operator replica (storage billed; egress and API calls $0) but anonymous GetObject is not offered (`PutBucketPolicy` returns NotImplemented; ACLs disabled). Dashboard pre-signed share links expire (minutes–hours).

Fair-use note from their pricing FAQ: monthly egress should not exceed stored volume. Fine at tens of KB. Revisit if a large pack is downloaded more times than its size in a month.

## Produce a snapshot (operators)

```
eden know compact
eden know dump
```

`query` reads the pack only. Ingest writes SQLite WAL; those facts are **invisible** to `eden know query` and wrap until compact. Ingest then query without compact looks empty — that is the contract, not a bug.

`compact` is a **full rewrite** in RAM on the compact host (not a delta). One object there; serving at TB scale uses a hot catalog shard plus a remote cold index (`EDEN_KNOW_URL`), not GetObject of the whole dump. Compact fetches the published `graph.kpk` first, merges this host’s local pack + WAL on top, writes, then uploads with **If-Match** (or If-None-Match `*` when the object is new). A 412 retries. If fetch fails, compact stays local and **does not upload** (never clobber a graph we did not merge). `dump` does the same and prints local path, bytes, SHA-256, and the public URL. It overwrites `graph.kpk` only — no dated copies.

Credentials (never commit):

| Variable | Meaning |
|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Impossible Cloud keys |
| `EDEN_KNOW_S3_ACCESS_KEY` / `EDEN_KNOW_S3_SECRET_KEY` | Same, if you do not want to reuse `AWS_*` |
| `EDEN_KNOW_S3_ENDPOINT` | default `https://us-east-1.storage.impossibleapi.net` |
| `EDEN_KNOW_S3_REGION` | default `us-east-1` |
| `EDEN_KNOW_S3_BUCKET` | default `eden-know` |
| `EDEN_KNOW_S3_KEY` | default `graph.kpk` |
| `EDEN_KNOW_S3=0` | compact/dump stay local |
| `EDEN_KNOW_URL` | optional remote cold-shard query (`POST {q,k}` → `{hits}`); fail-open. Query never GetObject of the dump. |

Always-on crawler: Northflank service `eden-know-ingest` (`nf-compute-50`, 0.5 vCPU / 1 GB, ~$12/mo + disk). Persistent `EDEN_KNOW_DIR=/data/know`. Each tick ingests a small Common Crawl WET window, CDX range hits, Wikipedia, open academia seeds, and any robots-ok outlink that is not a listed paywall or news/blog junk, then compact-publishes the single `graph.kpk` when the overlay is due (every ~3 minutes, or immediately at 512 WAL nodes). Health: `GET /health` on a parent process (the tick runs in a child so probes are not starved by WET CPU). Secrets: `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (never in git). Spec: `packages/know/deploy/northflank-service.json`.

Manual copy if you are not using the CLI upload:

```
aws s3 cp ~/.eden/know/graph.kpk s3://eden-know/graph.kpk \
  --endpoint-url https://us-east-1.storage.impossibleapi.net \
  --region us-east-1
```

## What the bytes are (and are not)

RFC titles and catalog rows live **in the pack bytes**. `rfc-titles.bin` / `rfc-edges.bin` are encoder-side tables used only as a size bake-off candidate (copying the already-framed blob into the dump when it wins). A newly encoded pack round-trips without opening them. Old KPK8/KPK9 flag dumps still decode via those tables.

Adding rfc-index rows whose titles do **not** match that table inflates the overlay. `RFC_KEEP` in `names.ts` is unused; compact packs every current rfc-index `is` row it is given.

Obscure IANA media types and URI schemes are dropped on purpose (`packableFact` / `SCHEME_KEEP`). Evidence strings and page URLs are not packed (cards use s/p/o only).

KPK1–KPK9 still decode. A frozen **KPK1** fixture lives in `src/fixtures/kpk1.kpk`. KPK7/KPK8 are checked on the live path. Do not gzip or zstd the outer file as the only encoding.
