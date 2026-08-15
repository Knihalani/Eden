# F29: Agent Issues (Sentry-Style Grouping)

| Field | Value |
|---|---|
| **Feature ID** | F29 |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **SHIPPED (v0)** — `agent_issues` API + portal `/issues` |
| **Competitive source** | Raindrop 2.0 (Issues), Sentry |
| **Dependencies** | F28 (stumbles) |

---

## 1. Summary

Raindrop promotes recurring **Stumbles** into **Issues** — same failure across users/runs, ranked by severity and user impact. Eden's `incident_clusters` uses `(category, error_type, agent_id)` keys without stumble layer, user counts, or Sentry-parity lifecycle (resolve/regress).

F29 is the operator-facing issue object that ties the closed loop together.

---

## 2. Data model

**Migration `077_agent_issues.sql`:**

```sql
CREATE TYPE stumble_kind AS ENUM (
    'tool_error', 'loop', 'hallucination', 'task_failure',
    'user_frustration', 'timeout', 'self_diagnostic', 'custom'
);

CREATE TABLE agent_stumbles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    trace_id UUID NOT NULL,
    session_id UUID,
    user_id TEXT,
    agent_id TEXT,
    kind stumble_kind NOT NULL,
    fingerprint TEXT NOT NULL,
    title TEXT NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    severity TEXT NOT NULL CHECK (severity IN ('p0','p1','p2','p3')),
    detected_by TEXT NOT NULL,
    span_id UUID,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_issues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    kind stumble_kind NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','resolved','ignored','regressed')),
    severity TEXT NOT NULL CHECK (severity IN ('p0','p1','p2','p3')),
    agent_id TEXT,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    stumble_count INT NOT NULL DEFAULT 1,
    user_count INT NOT NULL DEFAULT 1,
    affected_user_ids TEXT[] NOT NULL DEFAULT '{}',
    example_stumble_ids UUID[] NOT NULL DEFAULT '{}',
    triage_result JSONB,
    assignee UUID REFERENCES users(id),
    experiment_id UUID,
    UNIQUE (org_id, fingerprint)
);

CREATE INDEX idx_issues_org_status ON agent_issues (org_id, status, severity, last_seen DESC);
CREATE INDEX idx_stumbles_fingerprint ON agent_stumbles (org_id, fingerprint, detected_at DESC);
```

---

## 3. Fingerprint function

```python
def compute_fingerprint(
    kind: str,
    agent_id: str,
    error_signature: str,
) -> str:
    """
    error_signature examples:
      tool_error: f"{tool_name}|{normalized_error_code}"
      loop: f"{loop_hash_from_etec}"
      task_failure: f"{failure_reason_normalized}"
    """
    raw = f"{kind}|{agent_id or 'unknown'}|{error_signature}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]
```

Normalization: lowercase, strip UUIDs/timestamps from error messages.

---

## 4. IssuePromoter service

**`src/eden/issues/issue_promoter.py`**

On each new stumble:
1. `SELECT agent_issues WHERE org_id AND fingerprint FOR UPDATE`
2. If exists: increment counts, update `last_seen`, append stumble id (cap examples at 20)
3. If new: insert issue with `first_seen=last_seen=now()`
4. Update `user_count` via `HyperLogLog` or distinct array (cap 10k users)
5. Escalate severity if stumble_rate > threshold in 1h window
6. Fire `on_issue_created` hook → Slack (F47), triage queue (F30)

On resolve:
- `POST /agent-issues/{id}/resolve` → status=resolved
- New stumble same fingerprint → status=regressed, reopen alert

---

## 5. API routes

**New router:** `src/eden/api/routes/agent_issues.py`

| Method | Path |
|---|---|
| `GET` | `/orgs/{org_id}/agent-issues` — filters: status, severity, agent_id, kind, since |
| `GET` | `/orgs/{org_id}/agent-issues/{issue_id}` |
| `GET` | `/orgs/{org_id}/agent-issues/{issue_id}/stumbles` — paginated |
| `GET` | `/orgs/{org_id}/agent-issues/{issue_id}/timeline` — stumble rate chart data |
| `POST` | `/orgs/{org_id}/agent-issues/{issue_id}/resolve` |
| `POST` | `/orgs/{org_id}/agent-issues/{issue_id}/ignore` |
| `PATCH` | `/orgs/{org_id}/agent-issues/{issue_id}` — assignee, severity override |

---

## 6. Portal UX (Sentry parity)

**Replace/enhance** `clients/portal/src/app/(portal)/incidents/`:

### Issue list columns
- Issue title (linked)
- Severity badge (p0–p3)
- Users affected
- Events (stumble_count)
- Last seen (relative)
- Assignee avatar

### Issue detail tabs
1. **Overview** — frequency chart, first/last seen, sparkline
2. **Stumbles** — table with trace links, user_id
3. **Triage** — F30 result
4. **Fix** — F22 chat entry
5. **Experiment** — F33 link if active

---

## 7. Migration from incident_clusters

One-time job `scripts/migrate_incidents_to_issues.py`:
- Map cluster key → fingerprint
- Preserve trace membership as stumbles (synthetic)

Deprecate `/intelligence/rca/incidents` UI links → redirect to `/agent-issues`.

---

## 8. Acceptance criteria

- [x] 5 stumbles same fingerprint → 1 issue, stumble_count=5
- [x] 3 distinct user_ids → user_count=3
- [x] Resolve → new stumble sets status=regressed
- [x] P0 issue Slack alert includes user_count (F47)
- [x] Issue list p95 load <500ms for 10k issues (indexed)

---

## 9. Performance & cost optimization

### Read path (portal / MCP)

| Query | p95 | Technique |
|---|---|---|
| Issue list (50 rows) | <300ms | Covering index `(org_id, status, severity, last_seen DESC)` |
| Issue detail | <200ms | Primary key + stumble count from counter |
| Timeline chart | <400ms | Pre-aggregated hourly `issue_stumble_rates` MV |

### Write path

| Operation | p95 |
|---|---|
| IssuePromoter upsert | <25ms |
| HyperLogLog user_count | O(1) Redis PFADD |

### Cost

- **$0** — SQL only, no LLM on issue CRUD
- Storage: ~1KB/issue + 500B/stumble

### Caching

- Redis: `issue:{id}:summary` 30s TTL during active incident
- List view: invalidate on stumble only for affected fingerprint

```
eden_issue_list_duration_seconds
eden_issue_promoter_duration_seconds
```

---

*See F28 for stumble creation; F20 for auto-detection; F30 for triage.*
