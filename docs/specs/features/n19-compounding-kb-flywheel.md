# N19: Compounding KB Flywheel (Analyst + Runtime Paths)

| Field | Value |
|---|---|
| **Feature ID** | N19 |
| **Slug** | `compounding-kb-flywheel` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** — insights loop + procedural KB shipped; paths not unified |
| **Market hypothesis** | Agent maintenance compounds when every production failure makes the **next** run smarter — safely |
| **Dependencies** | `insights/detector_loop.py`, `kb/procedural/client.py`, F39, N15, N17 |

---

## 1. Problem

Eden already runs a compounding loop **partially**:

```
judge_scores → insights/detector_loop.py (60s) → Insight → KB
Issue resolve → (planned) procedural skill via ProceduralClient
Promoted nudge → (F39) gateway filter
Promoted guardrail → (N15) gateway filter
```

But operators cannot see the flywheel, and **runtime injection is gated** while **analyst/MCP recommendations are immediate** — the safe pattern Bento claims but Eden can prove with StatGate.

---

## 2. Two-speed improvement model (stand-out)

| Speed | Path | Latency | Risk |
|---|---|---|---|
| **Immediate** | MCP + portal suggest skill/nudge/guardrail | <1s | Zero — read-only recommendation |
| **Shadow** | F39 nudge / N15 guardrail in log mode | next request | Low — no mutation |
| **Promoted** | F41 EvidenceGate → gateway filter active | after evidence | Controlled |

**Key UX:** N17 cockpit shows "Suggested from KB" cards sourced from `ProceduralClient.search_by_embedding()` on issue fingerprint — **no gateway change until approved**.

---

## 3. Architecture

```python
# src/eden/kb/flywheel/coordinator.py

class KBFlywheelCoordinator:
    async def on_insight_created(self, insight: Insight):
        skill_draft = await self._skill_author.from_insight(insight)
        await ProceduralClient().insert({**skill_draft, "archivist_reviewed": False})
        await improvement_cockpit.notify("kb_skill_draft", skill_draft.id)

    async def on_issue_resolved(self, issue: AgentIssue):
        await N01.create_regression_case(issue)
        await self.on_insight_created_from_issue(issue)
        if issue.stumble_count >= 5:
            await nudge_author.draft_shadow(issue)  # F39
```

Wire to existing `detector_loop` output and F46 `issue_resolved` event.

---

## 4. ProceduralClient integration (exact)

Use existing fields from `kb/procedural/client.py:30–44`:

- `archivist_reviewed: bool` — must be `true` before runtime promotion
- `confidence_score: float` — rank in N17 queue
- `applicable_env_classes` — link to N07 generated envs
- `search_by_embedding()` — match issue triage text to skills

---

## 5. Performance & cost optimization

| Step | Cost |
|---|---|
| Insight loop (existing) | $0 SQL + optional SLM |
| Skill author LLM | ~$0.02/insight, async |
| Embedding search | ~$0.0001/query |
| Runtime filter (when promoted) | see F39/N15 budgets |

**No compounding on hot path** until F41 promotes — keeps gateway p95 stable.

---

## 6. Acceptance criteria

- [ ] New insight creates procedural skill draft within 5min
- [ ] N17 shows KB suggestion linked to issue
- [ ] Unreviewed skills never reach gateway filter
- [ ] MCP `search_kb_skills(issue_id)` returns ranked skills

---

## 7. Stand-out narrative

> "Eden compounds organizational learning — **safely** — with archivist review + StatGate promotion, not cowboy prompt edits."

---

*Unifies existing `detector_loop` + `ProceduralClient`; see CODEBASE-GROUND-TRUTH.md.*
