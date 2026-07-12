# N09: Content-Addressed Trace Storage & Tiering

| Field | Value |
|---|---|
| **Feature ID** | N09 |
| **Slug** | `content-addressed-trace-storage` |
| **Priority** | P1 |
| **Effort** | XL |
| **Eden status** | **SHIPPED (core)** — trace-scoped `message_store` (ingest-wired) + org-scoped `compression/blob_store.py` + `span_content_blobs` migration; cold tier / RTBF refcount deferred |
| **Restores** | Deleted F11 (trace content deduplication) |
| **Market hypothesis** | At scale, duplicate system prompts/tool schemas dominate storage — 5–20× savings = better margins and faster queries |
| **Dependencies** | Ingest pipeline, ClickHouse/Postgres telemetry |

---

## 1. Problem

Agent traces repeat identical content: system prompts (50KB+), tool JSON schemas, KB snippets. Eden stores full JSON per span → storage cost grows linearly with volume; query latency suffers on wide JSON columns.

Laminar ships content deduplication. Without it, Eden becomes **expensive at enterprise trace volume** — bad client experience via slow search and high bills.

---

## 2. Target behavior

On span ingest:
1. Hash normalized content blobs (SHA256)
2. Intern: store blob once in `span_content_blobs`
3. Span row stores `{ref: hash, offset?, length?}` only
4. Hot tier (7d): Postgres/ClickHouse fast
5. Warm tier (90d): compressed columnar
6. Cold tier (>90d): S3/GCS with retrieval SLA

**Transparent:** API returns full content — clients never see refs.

---

## 3. Architecture

```
Ingest span
    → ContentNormalizer (strip whitespace, sort JSON keys)
    → BlobHasher.sha256()
    → BlobStore.get_or_put(hash, content)  [Redis lock per hash]
    → SpanWriter with content_ref
```

**Module:** `src/eden/observability/compression/blob_store.py`

---

## 4. Data model

```sql
CREATE TABLE span_content_blobs (
    org_id UUID NOT NULL,
    content_hash TEXT NOT NULL,
    content BYTEA NOT NULL,          -- zstd compressed
    content_type TEXT NOT NULL,       -- messages, tool_schema, tool_result
    byte_size INT NOT NULL,
    ref_count BIGINT NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (org_id, content_hash)
);

-- Spans store: attributes->>'content_ref' = hash
```

---

## 5. Deduplication rules

| Content type | Normalize before hash |
|---|---|
| System prompt | Trim, collapse whitespace |
| Tool definitions | Sort keys, strip descriptions optional |
| Tool results | Strip timestamps/UUIDs in known fields |
| User messages | No dedupe (usually unique) |

**Min blob size:** 512 bytes — smaller not worth dedupe overhead.

---

## 6. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 |
|---|---|---|
| Hash + lookup | <1ms | <3ms |
| Blob insert (new) | <5ms | <15ms |
| Span read (resolve ref) | <2ms | <8ms |
| Cold tier retrieval | <2s | <10s |

### Cost model

| Volume | Without dedupe | With dedupe (est.) |
|---|---|---|
| 10M spans/mo, 20KB avg | ~200GB/mo | ~40–80GB/mo (60–80% on prompts) |
| Query cost | Full JSON scan | Hash lookup + single blob fetch |

### Caching

- **Redis:** LRU cache top 10k blobs by ref_count (1h TTL)
- **Bloom filter:** Skip DB lookup for hashes never seen (optional)

### Degradation

- `dedupe_disabled` flag → store inline (rollback)
- Blob store full → alert; stop new intern, inline fallback

### Monitoring

```
eden_blob_dedupe_ratio (gauge, org)
eden_blob_store_bytes_total
eden_blob_lookup_duration_seconds
eden_blob_cache_hit_total
```

---

## 7. Acceptance criteria

- [ ] Dedupe ratio ≥3× on synthetic agent workload (repeated system prompt)
- [ ] Ingest overhead p99 ≤3ms
- [ ] API transcript identical pre/post dedupe
- [ ] Ref count decrements on RTBF delete (Cat 10)
- [ ] Cold tier restore transparent to portal

---

*Restored from deleted F11. See [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md).*
