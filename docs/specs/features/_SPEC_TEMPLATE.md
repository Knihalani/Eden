# Feature Spec Template

> Copy this template for new F or N features. **§ Performance & cost optimization is mandatory.**

| Field | Value |
|---|---|
| **Feature ID** | F/N{ID} |
| **Priority** | P0/P1/P2 |
| **Effort** | XS–XL |
| **Eden status** | MISSING / PARTIAL / SHIPPED |
| **Dependencies** | ... |

---

## 1. Summary

## 2. Eden current state

## 3. Target behavior

## 4. Architecture

## 5. Data model

## 6. API specification

## 7. Implementation plan

## 8. SDK / MCP / Portal

## 9. Feature flags & rollout

## 10. Test plan

## 11. Acceptance criteria

## 12. Performance & cost optimization

> See [PERFORMANCE-COST-STANDARDS.md](../PERFORMANCE-COST-STANDARDS.md)

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| ... | | | |

### Cost model

- LLM tier used (0 = deterministic only)
- Est. $/1k operations
- Storage per unit

### Caching strategy

- What is cached, TTL, invalidation

### Degradation modes

- Budget exceeded → behavior
- Dependency down → fallback

### Monitoring

```
eden_{feature}_duration_seconds
eden_{feature}_cost_usd_total
```

## 13. Dependencies
