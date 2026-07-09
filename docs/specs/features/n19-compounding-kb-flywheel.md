# N19: Compounding KB Flywheel (Analyst + Runtime Paths)

| Field | Value |
|---|---|
| **Feature ID** | N19 |
| **Slug** | `compounding-kb-flywheel` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** — insights loop + procedural KB shipped; paths not unified |
| **Market hypothesis** | Agent maintenance compounds when every production failure makes the **next** run smarter — safely |
| **Dependencies** | `insights/detector_loop.py`, `kb/procedural/client.py`, F39, N15, N17, N01, N22, F40 |

---

## 1. Summary

Unify Eden's **compounding learning loop** — insights → procedural skills → operator/MCP recommendations → shadow runtime (F39/N15) → F41 promotion — with visible flywheel UX in N17. Two-speed model: immediate analyst path (zero risk) vs gated runtime path (StatGate + archivist review). Stand-out vs Bento: provable safe promotion, not cowboy memory injection.

---

## 2. Eden current state

| Shipped | Path | Status |
|---|---|---|
| Insights detector loop | `insights/detector_loop.py` | **RUNNING** in app lifespan |
| ProceduralClient | `kb/procedural/client.py:24` | **SHIPPED** |
| `archivist_reviewed` field | `client.py:30–44` | **SHIPPED** — gating field |
| `search_by_embedding()` | ProceduralClient | **SHIPPED** |
| Promotion to gateway | F39/N15 | **MISSING** |
| Flywheel coordinator | — | **MISSING** |
| N17 KB cards | — | **MISSING** |

**Partial loop today:**
```
judge_scores → detector_loop (60s) → Insight → KB insert (manual path unclear)
Issue resolve → (planned) procedural skill
Promoted nudge → (F39) gateway filter
```

---

## 3. Two-speed improvement model (stand-out)

| Speed | Path | Latency | Risk | Autonomy |
|---|---|---|---|---|
| **Immediate** | MCP + N17 suggest skill/nudge/guardrail | <1s | Zero — read-only | T0–T4 |
| **Shadow** | F39 nudge / N15 guardrail log-only | next request | Low — no mutation | T1+ shadow |
| **Promoted** | F41 EvidenceGate → gateway filter active | after evidence | Controlled | T3+ promote |

**Key UX:** N17 shows "Suggested from KB" cards from `ProceduralClient.search_by_embedding(issue_fingerprint)` — **no gateway change until approved**.

---

## 4. Target behavior

### 4.1 Flywheel events

```
Insight created (detector_loop)
    → KBFlywheelCoordinator.on_insight_created
    → SkillAuthorLLM drafts procedural skill (archivist_reviewed=false)
    → N17 "Proposed" card: "Review KB skill draft"

Issue resolved (F46)
    → N01 regression case (if policy)
    → on_issue_resolved → skill from triage + example traces
    → if stumble_count ≥ 5 → F39 nudge shadow draft

Operator approves skill
    → archivist_reviewed=true
    → Immediate: MCP search returns skill
    → Optional: promote to F39 shadow (N22 may(nudge_shadow))

F41 promotes nudge/guardrail
    → Book chapter update (F40) async
    → N17 "Learned" column
```

### 4.2 Autonomous path (N22)

| Tier | Behavior |
|---|---|
| T1 | Auto-suggest skills in N17/MCP only |
| T2 | Auto-draft skills + shadow nudges (proposed) |
| T3 | Auto-shadow without human if StatGate pre-check pass |
| T4 | Never auto-promote runtime without F41 (hard rule) |

---

## 5. Architecture

```python
# src/eden/kb/flywheel/coordinator.py

class KBFlywheelCoordinator:
    async def on_insight_created(self, insight: Insight) -> None:
        if not await autonomy_policy.may(insight.org_id, insight.agent_id, "kb_draft"):
            return
        skill_draft = await SkillAuthorLLM.from_insight(insight)
        await ProceduralClient().insert({
            **skill_draft,
            "archivist_reviewed": False,
            "source_insight_id": insight.id,
            "confidence_score": insight.confidence,
        })
        await improvement_cockpit.notify("kb_skill_draft", skill_draft.id)

    async def on_issue_resolved(self, issue: AgentIssue) -> None:
        await N01.create_regression_case(issue)  # if policy
        skills = await self._skill_author.from_issue(issue)
        for s in skills:
            await ProceduralClient().insert(s)
        if issue.stumble_count >= 5:
            await nudge_author.draft_shadow(issue)  # F39
        await self._notify_learned(issue)

    async def suggest_for_issue(self, issue: AgentIssue) -> list[SkillMatch]:
        return await ProceduralClient().search_by_embedding(
            issue.triage_summary or issue.title,
            org_id=issue.org_id,
            limit=5,
        )
```

**Wire to:** `detector_loop` output hook + F46 `issue.resolved` event.

---

## 6. ProceduralClient integration (exact)

Use existing fields from `kb/procedural/client.py`:

| Field | Flywheel use |
|---|---|
| `archivist_reviewed: bool` | Must be `true` before runtime promotion |
| `confidence_score: float` | Rank in N17 queue |
| `applicable_env_classes` | Link to N07 generated envs |
| `search_by_embedding()` | Match issue triage text to skills |
| `source_insight_id` / `source_issue_id` | Lineage (new metadata) |

**Do not bypass** archivist for gateway injection — N06 audit logs any attempt.

---

## 7. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{id}/kb/flywheel/status` | Counts: drafts, promoted, skills/week |
| `GET` | `/orgs/{id}/issues/{id}/kb-suggestions` | Ranked skills for issue |
| `POST` | `/orgs/{id}/kb/skills/{id}/approve` | archivist_reviewed=true |
| `POST` | `/orgs/{id}/kb/skills/{id}/promote-shadow` | → F39 draft |

**MCP (F04):** `search_kb_skills(issue_id | query)`, `list_kb_drafts()`

---

## 8. Implementation plan

1. `KBFlywheelCoordinator` + HookBus subscriptions
2. `SkillAuthorLLM` — insight/issue → procedural skill schema
3. N17 card types: `kb_skill_draft`, `kb_suggestion`, `kb_learned`
4. Approve/promote API routes
5. F40 Book chapter hook on promotion
6. MCP search tools
7. Flywheel status dashboard widget

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `kb_flywheel_v1` | off |
| `kb_auto_draft_on_insight` | off |
| `kb_auto_draft_on_issue_resolve` | on when v1 |

---

## 10. Test plan

- Insight fixture → skill draft within 5min (async job)
- Unreviewed skill → gateway filter unchanged
- Approve skill → MCP search returns it
- Issue resolve → regression + skill draft
- N22 T0 → no auto-draft

---

## 11. Acceptance criteria

- [ ] New insight creates procedural skill draft within 5min
- [ ] N17 shows KB suggestion linked to issue
- [ ] Unreviewed skills never reach gateway filter
- [ ] MCP `search_kb_skills(issue_id)` returns ranked skills
- [ ] F41 required for runtime promotion path
- [ ] F40 Book updates after promotion
- [ ] N06 audit logs skill approve/promote

---

## 12. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| suggest_for_issue (embed search) | 50ms | 200ms | 500ms |
| Skill author LLM (async) | 3s | 10s | 20s |
| N17 card notify | 100ms | 500ms | 1s |
| Gateway filter (promoted) | see F39 | | |

### Cost model

| Step | Cost |
|---|---|
| Insight loop (existing) | $0 SQL + optional SLM |
| Skill author LLM | ~$0.02/insight, async |
| Embedding search | ~$0.0001/query |
| Runtime filter (when promoted) | F39/N15 budgets |

**No compounding on hot path** until F41 promotes — gateway p95 stable.

### Caching strategy

- Embedding search results: Redis 60s per issue_id
- Flywheel status counts: Redis 120s

### Degradation modes

- Skill author fail → insight-only card without draft
- ProceduralClient down → N17 shows "KB unavailable"
- Budget exceeded (N22) → skip auto-draft

### Monitoring

```
eden_kb_flywheel_drafts_total{source=insight|issue}
eden_kb_flywheel_promotions_total
eden_kb_suggest_latency_seconds
eden_kb_unreviewed_blocked_total
```

---

## 13. Stand-out narrative

> "Eden compounds organizational learning — **safely** — with archivist review + StatGate promotion, not cowboy prompt edits."

Bento claims compounding; **Eden proves it** with two-speed paths + N06 audit.

---

*Unifies `detector_loop` + `ProceduralClient`; see [CODEBASE-GROUND-TRUTH.md](../CODEBASE-GROUND-TRUTH.md), [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md).*
