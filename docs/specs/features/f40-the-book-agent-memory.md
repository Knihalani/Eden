# F40: The Book (Agent Memory Artifact)

| Field | Value |
|---|---|
| **Feature ID** | F40 |
| **Slug** | `the-book-agent-memory` |
| **Priority** | P1 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | BentoLabs |
| **Closes gap** | 4.2 |
| **Dependencies** | F29, F39, KB procedural layer |

---

## 1. Summary

Versioned markdown **Book** per agent — distilled failures, fixes, and learnings — injected at gateway inference (≤2k tokens). Bento "organizational memory" artifact; Eden exposes KB as runtime asset.

---

## 2. Target behavior

```
Nightly BookGenerator:
    → Read resolved issues (7d), promoted nudges, regression cases
    → LLM synthesize markdown chapters
    → Version bump agent_books
    → Gateway pre_invoke: append Book excerpt to system message (if enabled)
```

---

## 3. Data model

```sql
CREATE TABLE agent_books (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    version INT NOT NULL,
    content_md TEXT NOT NULL,
    token_count INT NOT NULL,
    source_issue_ids UUID[],
    published_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (org_id, agent_id, version)
);
```

---

## 4. API

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/agents/{agent_id}/book` | latest version |
| `GET` | `/orgs/{org_id}/agents/{agent_id}/book/versions` |
| `POST` | `/orgs/{org_id}/agents/{agent_id}/book/regenerate` |

**MCP resource:** `eden://agents/{id}/book`

---

## 5. Performance & cost optimization

### Generation cost

- Nightly batch: 1 Sonnet call/agent ~$0.05–0.15
- Incremental update: only if ≥3 new resolved issues
- Skip agents with <10 traces/day

### Runtime cost

- Token budget: max 2000 tokens injected — truncate oldest chapters
- Cache Book in Redis 1h — gateway read p95 <2ms
- **A/B measure:** issue rate with Book on vs off (F33)

### Latency

- Gateway injection overhead p95 <5ms (cached)

---

## 6. Acceptance criteria

- [ ] Book updates within 24h of issue resolve
- [ ] Gateway shows audit field `book_version` on trace
- [ ] Version diff in portal reader
- [ ] Token count ≤2000 enforced

---

*Bento 4.2 parity; complements F39 nudges (Book = static, nudges = triggered).*
