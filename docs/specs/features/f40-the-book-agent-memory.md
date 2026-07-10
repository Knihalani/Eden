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
| **Dependencies** | F29, F39, KB procedural layer, N19, F33, N22 |

---

## 1. Summary

Versioned markdown **Book** per agent — distilled failures, fixes, and learnings — injected at gateway inference (≤2k tokens). Bento "organizational memory" artifact; Eden exposes KB as runtime asset with **F41-gated updates** and A/B measurement via F33. Complements F39 nudges (Book = static context, nudges = triggered).

---

## 2. Eden current state

| Shipped | Gap |
|---|---|
| ProceduralClient / KB | No Book artifact abstraction |
| Gateway pre_invoke hooks | No Book injection |
| N19 flywheel | Book update hook spec only |

**Greenfield:** `src/eden/kb/book/generator.py`, `agent_books` table, gateway injection

---

## 3. Target behavior

```
Nightly BookGenerator (or on F41 promotion):
    → Read resolved issues (7d), promoted nudges (F39), regression cases (N01), approved KB skills (N19)
    → LLM synthesize markdown chapters:
        ## Recent failures
        ## Proven fixes
        ## Tool/MCP gotchas
        ## Do-not-repeat
    → Version bump agent_books
    → Gateway pre_invoke: append Book excerpt to system message (if enabled)
    → Trace audit: book_version field
    → F33 A/B: issue rate with Book on vs off
```

### Maintenance modes

| Mode | Behavior |
|---|---|
| **Operator** | Manual regenerate + edit chapter in portal |
| **Assisted (T2)** | Auto-draft on ≥3 new resolved issues; operator publish |
| **Autonomous (T3)** | Auto-publish minor version if F33 shows no regression |

---

## 4. Architecture

| Component | Path |
|---|---|
| `BookGenerator` | `kb/book/generator.py` |
| `BookInjector` | `llmops/gateway/book_inject.py` |
| `BookDiffService` | `kb/book/diff.py` |
| Portal reader | `/agents/{id}/book` |

**Gateway injection:** Use `GatewayFilter` pattern (F39) — not monkey-patch `complete()`.

```python
class BookGatewayFilter(GatewayFilter):
    async def pre_invoke(self, ctx: GatewayContext) -> GatewayContext:
        book = await book_cache.get(ctx.org_id, ctx.agent_id)
        if book and ctx.config.book_enabled:
            ctx.system_message = append_book_excerpt(ctx.system_message, book, max_tokens=2000)
            ctx.audit["book_version"] = book.version
        return ctx
```

---

## 5. Data model

```sql
CREATE TABLE agent_books (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    version INT NOT NULL,
    content_md TEXT NOT NULL,
    token_count INT NOT NULL,
    source_issue_ids UUID[],
    source_skill_ids UUID[],
    published_by UUID,
    publish_mode TEXT CHECK (publish_mode IN ('manual','auto_draft','auto_publish')),
    published_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (org_id, agent_id, version)
);

CREATE TABLE agent_book_config (
    org_id UUID NOT NULL,
    agent_id TEXT NOT NULL,
    enabled BOOLEAN DEFAULT false,
    max_tokens INT DEFAULT 2000,
    auto_update BOOLEAN DEFAULT true,
    PRIMARY KEY (org_id, agent_id)
);
```

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{org_id}/agents/{agent_id}/book` | Latest version |
| `GET` | `/orgs/{org_id}/agents/{agent_id}/book/versions` | History |
| `GET` | `/orgs/{org_id}/agents/{agent_id}/book/diff?v1=&v2=` | Version diff |
| `POST` | `/orgs/{org_id}/agents/{agent_id}/book/regenerate` | Trigger generation |
| `POST` | `/orgs/{org_id}/agents/{agent_id}/book/publish` | Publish draft version |
| `PATCH` | `/orgs/{org_id}/agents/{agent_id}/book/config` | Enable/disable injection |

**MCP resource:** `eden://agents/{id}/book`  
**MCP tool:** `get_agent_book(agent_id)`, `regenerate_agent_book(agent_id)`

---

## 7. Implementation plan

1. Migration + config API
2. `BookGenerator` nightly cron + promotion hook (N19)
3. Token counting + chapter truncation (oldest first)
4. `BookGatewayFilter` registration
5. Portal markdown reader + diff view
6. F33 experiment template "Book on vs off"
7. N06 audit on publish

---

## 8. Feature flags & rollout

| Flag | Default |
|---|---|
| `agent_book_v1` | off |
| `agent_book_gateway_inject` | off |
| `agent_book_auto_publish` | off (T3 only) |

---

## 9. Test plan

- 3 resolved issues → draft generated with relevant chapters
- Token count ≤2000 enforced (truncate test)
- Gateway trace includes `book_version` audit field
- Disabled config → no injection overhead
- Version diff shows added/removed sections

---

## 10. Acceptance criteria

- [ ] Book updates within 24h of issue resolve (when auto_update)
- [ ] Gateway shows audit field `book_version` on trace
- [ ] Version diff in portal reader
- [ ] Token count ≤2000 enforced
- [ ] MCP resource returns latest markdown
- [ ] F33 can measure Book on vs off stumble rate
- [ ] N22 T0: manual publish only

---

## 11. Performance & cost optimization

### Generation cost

| Trigger | Cost |
|---|---|
| Nightly batch (incremental) | $0.05–0.15/agent (Sonnet) |
| Skip agents <10 traces/day | $0 |
| Manual regenerate | same |

Incremental: only regenerate if ≥3 new resolved issues since last version.

### Runtime cost

| Concern | Mitigation |
|---|---|
| Token budget | max 2000 tokens — truncate oldest chapters |
| Gateway read | Redis cache 1h — p95 <2ms |
| Injection overhead | p95 <5ms (cached) |
| Extra LLM cost per request | ~$0.001–0.01 depending on model |

### Latency budgets

| Operation | p50 | p95 |
|---|---|---|
| Gateway inject | 1ms | 5ms |
| Book API read | 20ms | 100ms |
| Generate (async) | 5s | 20s |

### Monitoring

```
eden_book_generate_duration_seconds
eden_book_gateway_inject_total
eden_book_token_count_histogram
eden_book_version_published_total
```

---

## 12. Dependencies

| Spec | Relationship |
|---|---|
| F29 | Issue source material |
| F39 | Complementary nudges |
| N19 | Skill promotion → Book chapter |
| N01 | Regression lessons in Book |
| F33 | A/B measurement |
| N22 | Auto-publish tier |
| F39 | Shared GatewayFilter pattern |

---

*Bento 4.2 parity; safe compounding via F41 + archivist path from N19.*
