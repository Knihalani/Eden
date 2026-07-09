# F46: Closed-Loop Orchestrator

| Field | Value |
|---|---|
| **Feature ID** | F46 |
| **Slug** | `closed-loop-orchestrator` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | All four (capstone) |
| **Closes gap** | 5.1 |
| **Dependencies** | F20, F28, F29, F30, F22, F39, F41, N01, F47 |

---

## 1. Summary

Wire disconnected hooks into one **issue state machine** that drives detect → triage → fix → verify → learn → alert. Eden has pieces (`promotion_hooks.py`, workers) but no orchestrator ensuring the full loop completes.

---

## 2. Eden current state (codebase-accurate)

| Component | Path | Status |
|---|---|---|
| HookBus + 20+ hooks | `llmops/promotion_hooks.py` | **SHIPPED** |
| `register_all_hooks()` | `promotion_hooks.py:1667` | **STUB** — logs only; lazy singletons |
| Closed-loop executor | `llmops/closed_loop_executor.py` | **PARTIAL** — advisory side effects |
| Closed-loop portal API | `api/routes/intelligence_closed_loop.py` | **SHIPPED** |
| Insights → KB loop | `insights/detector_loop.py` | **SHIPPED** — running in lifespan |
| Issue state machine | `src/eden/closed_loop/orchestrator.py` | **MISSING** |
| Improvement cockpit UX | N17 | **MISSING** |
| `src/eden/issues/` | — | **MISSING** |

**F46 builds orchestrator; N17 provides operator UX** — complementary, not duplicate.

---

## 3. Issue state machine

```
                    ┌─────────────┐
     F20 detect ──► │   OPEN      │
                    └──────┬──────┘
                           │ auto_triage (F30)
                    ┌──────▼──────┐
                    │  TRIAGED    │
                    └──────┬──────┘
              fix chat ────┼──── autofix (F04/F22)
                    ┌──────▼──────┐
                    │ FIX_PENDING │
                    └──────┬──────┘
                           │ verify (N01, F01)
                    ┌──────▼──────┐
                    │  VERIFYING  │
                    └──────┬──────┘
                      pass │ fail
              ┌────────────┼────────────┐
       ┌──────▼──────┐          ┌─────▼─────┐
       │  RESOLVED   │          │ REGRESSED │
       └──────┬──────┘          └───────────┘
              │ nudge author (F39) + regression case (N01)
       ┌──────▼──────┐
       │  LEARNING   │ (optional shadow nudge)
       └─────────────┘
```

---

## 4. Architecture

**`src/eden/closed_loop/orchestrator.py`**

```python
class ClosedLoopOrchestrator:
    async def on_event(self, event: LoopEvent) -> None:
        match event.type:
            case "stumble_created":
                await self._ensure_issue(event)
            case "issue_created":
                await self._schedule_triage(event)
                await self._slack_alert(event)
            case "triage_completed":
                await self._suggest_fix_actions(event)
            case "pr_opened":
                await self._schedule_verify(event)
            case "verify_passed":
                await self._resolve_issue(event)
                await self._create_regression_case(event)  # N01
                await self._author_nudge_shadow(event)     # F39
            case "verify_failed":
                await self._regress_issue(event)
            case "new_stumble_on_resolved":
                await self._reopen_issue(event)
```

Event bus: Redis stream `eden.loop.events` (single consumer group per org shard).

---

## 5. Data model

```sql
CREATE TABLE issue_state_transitions (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    trigger_event TEXT NOT NULL,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_transitions_issue ON issue_state_transitions (issue_id, created_at DESC);
```

Issue `status` enum extended: `open, triaged, fix_pending, verifying, resolved, regressed, ignored`

---

## 6. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{org_id}/agent-issues/{id}/loop-status` | Current state + pending actions |
| `POST` | `/orgs/{org_id}/agent-issues/{id}/loop/retry` | Retry failed step |
| `GET` | `/orgs/{org_id}/closed-loop/metrics` | Loop completion rates |

**Portal:** Kanban board `/issues/board` — columns match states

---

## 7. Loop SLA targets

| Transition | Target time | Owner feature |
|---|---|---|
| stumble → issue | <5s | F29 |
| issue → triaged | <90s | F30 |
| triaged → PR opened | user-paced | F22 |
| PR → verify complete | <10min | N01 |
| resolved → regression case | <60s | N01 |
| resolved → shadow nudge | <24h | F39 |

---

## 8. Performance & cost optimization

### Latency budgets

| Operation | p95 |
|---|---|
| Event dispatch | <50ms |
| State transition persist | <30ms |
| Full automated loop (no human) | demo <30min staging |

### Cost model

- Orchestrator itself: **$0 LLM** — routing only
- Loop cost = sum of F30 + F22 + N01 (each has own budget)
- Idempotent handlers — safe to retry without duplicate PRs

### Reliability

- **Idempotency keys** on every transition: `{issue_id}:{event_type}:{ref_id}`
- Dead letter queue for failed steps with portal retry button
- Saga pattern: compensate on verify fail (reopen issue, don't leave orphan PR)

### Caching

- Loop status: Redis `loop:{issue_id}` → current state + pending jobs

### Degradation

- Worker down → events buffer in Redis stream (7d retention)
- Optional step fail → issue stays in state, alert ops, don't block other issues

### Monitoring

```
eden_loop_transition_total{from,to}
eden_loop_step_duration_seconds{step}
eden_loop_stuck_total{state}  # alert if >24h in fix_pending
eden_loop_completion_total    # resolved with full verify
```

---

## 9. Feature flags

| Flag | Default |
|---|---|
| `closed_loop_orchestrator_v1` | false |
| Per-step kills: `loop_auto_triage`, `loop_auto_nudge`, etc. |

---

## 10. Demo script (acceptance)

Staging walkthrough <30min:
1. Ingest failing trace → issue appears
2. Auto-triage completes
3. Fix chat opens PR (or MCP autofix dry_run)
4. Verify passes → issue resolved
5. Regression case created
6. Slack notifications at P0 + resolve

---

## 11. Acceptance criteria

- [ ] State machine handles all transitions without orphan states
- [ ] Idempotent retry does not duplicate PR/regression case
- [ ] Kanban board reflects live state
- [ ] Stuck issue alert fires after 24h in fix_pending
- [ ] Loop metrics dashboard shows completion rate

---

*Capstone wiring spec — implements no new detection, only orchestration.*
