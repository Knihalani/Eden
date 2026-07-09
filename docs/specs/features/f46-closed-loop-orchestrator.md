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
| **Dependencies** | F20, F28, F29, F30, F22, F39, F41, N01, F47, **N22, N20, N21, N18, N19** |

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

**Autonomous maintenance:** F46 is the **state machine** that N20/N21/N18 plug into. Every autonomous side effect passes `N22.may()` before transition. See [`AUTONOMOUS-MAINTENANCE.md`](../AUTONOMOUS-MAINTENANCE.md).

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
       │  LEARNING   │ (optional shadow nudge + N19 KB)
       └─────────────┘
```

### 3.1 Normal (operator-led) vs autonomous transitions

| Transition | Operator mode | Autonomous mode (N22 gated) |
|---|---|---|
| stumble → issue | Always (F29) | Same |
| issue → triaged | F30 on demand or auto | T1+: auto F30 ReAct |
| triaged → fix_pending | Human opens F22 fix chat | T2: N20 propose patch; T2: F04 autofix dry_run |
| fix_pending → verifying | Human opens PR | T4: N20 auto-merge PR after N04+N01 |
| verifying → resolved | Human confirms | T3: auto-resolve if N01+StatGate pass |
| resolved → learning | Manual nudge/KB | T2: F39 shadow + N19 skill draft auto |
| any → regressed | Manual or N01 fail | T3: auto-reopen + N21 rollback suggest |

**Hard rules (all tiers):**
- F41 required for gateway-impacting promotion (nudge/guardrail)
- N06 audit log on every transition
- `autonomous_actions_v0=false` → N21 execute blocked regardless of tier

---

## 4. Architecture

**`src/eden/closed_loop/orchestrator.py`**

```python
class ClosedLoopOrchestrator:
    async def on_event(self, event: LoopEvent) -> None:
        policy = await autonomy_policy.resolve(event.org_id, event.agent_id)
        match event.type:
            case "stumble_created":
                await self._ensure_issue(event)
            case "issue_created":
                await self._schedule_triage(event, policy)
                await self._slack_alert(event)
            case "triage_completed":
                await self._suggest_fix_actions(event, policy)
                await self._maybe_autonomous_patch(event, policy)   # N20
                await self._maybe_autonomous_heal(event, policy)    # N21
            case "patch_proposed":
                await self._transition(event, "fix_pending")
                await cockpit.notify("proposed_patch", event)
            case "pr_opened":
                await self._schedule_verify(event)
            case "verify_passed":
                await self._resolve_issue(event)
                await self._create_regression_case(event, policy)  # N01
                await self._author_nudge_shadow(event, policy)     # F39
                await self._kb_flywheel_on_resolve(event, policy)  # N19
            case "verify_failed":
                await self._regress_issue(event)
                await self._maybe_rollback_heal(event, policy)     # N21
            case "new_stumble_on_resolved":
                await self._reopen_issue(event)
            case "statgate_p0":
                await self._maybe_autonomous_heal(event, policy)    # N21 priority

    async def _maybe_autonomous_patch(self, event, policy):
        if not await autonomy_policy.may(policy, "code_patch"):
            return
        await issue_patch_trigger.on_issue_promoted(event.issue_id)

    async def _maybe_autonomous_heal(self, event, policy):
        if not await autonomy_policy.may(policy, "self_heal"):
            return
        await SelfHealer().heal_from_issue(event.issue_id)
```

Event bus: Redis stream `eden.loop.events` (single consumer group per org shard).

**Wire existing stubs:** Replace no-op `register_all_hooks()` body with `ClosedLoopOrchestrator.subscribe()` — N14 activation task.

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
- [ ] N22 policy denies autonomous transition with audit log (N06)
- [ ] N20 patch_proposed event transitions issue to fix_pending
- [ ] N21 heal on StatGate P0 queues with before_state
- [ ] N17 receives WebSocket update within 2s of transition
- [ ] T0 org: zero autonomous transitions; operator paths only

---

## 12. Autonomous maintenance matrix

| Event source | F46 handler | Downstream spec |
|---|---|---|
| F28 stumble | `_ensure_issue` | F29 |
| F30 triage done | `_maybe_autonomous_patch/heal` | N20, N21 |
| N08 StatGate P0 | `_maybe_autonomous_heal` | N21 |
| N20 patch ready | `patch_proposed` → fix_pending | N17 inbox |
| N04 impact pass + N01 pass | verify_passed (T4) | N20 auto-merge |
| N18 canary success | promotion via F41 | N15/F39 |
| N19 issue resolved | `_kb_flywheel_on_resolve` | KB draft |

---

*Capstone wiring spec — orchestrates normal + autonomous maintenance. See N22, N17, [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md).*
