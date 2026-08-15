# N18: Autonomous Prompt Evolution from Production Judges

| Field | Value |
|---|---|
| **Feature ID** | N18 |
| **Slug** | `autonomous-prompt-evolution` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** — `JudgeScorePromptEvolver` shipped; not issue-driven |
| **Market hypothesis** | Agents should **self-improve prompts** from production judge regressions with safe canary rollout |
| **Dependencies** | N14, N17, F41, `agents/evolution/components.py`, `llmops/promotion.py` |

---

## 1. Problem

`src/eden/agents/evolution/components.py` ships:

- **`JudgeScorePromptEvolver`** — scans judge scores, finds degraded `(agent, judge)` pairs, LLM-generates new prompt variant
- **`PromptEvolvers`** — auto-enrolls variant in canary at `evolver_auto_canary_pct`

This is **production improvement automation** — but it is:
- Not visible in improvement cockpit (N17)
- Not tied to F29 issues or F41 EvidenceGate
- Not exposed via MCP for coding agents

---

## 2. Eden current state (exact)

| Component | Path | Status |
|---|---|---|
| JudgeScorePromptEvolver | `agents/evolution/components.py` L9–14 | **SHIPPED** |
| PromptEvolvers canary | same file L16–20 | **SHIPPED** |
| prompt_versions client | `kb/prompt_versions/client.py` | **SHIPPED** |
| PromotionLoop | `llmops/promotion.py` | **SHIPPED** |
| Issue-triggered evolution | — | **MISSING** |
| Evolver in portal | — | **MISSING** |

---

## 3. Target behavior

```
Judge "task_success" drops below threshold for agent checkout-v2 (7d window)
    → JudgeScorePromptEvolver.trigger(agent, judge)
    → LLM proposes prompt variant v2 (insert active=False, ab_test_active=True)
    → PromptEvolvers enrolls canary at 5% traffic
    → N17 cockpit card: "Prompt canary ready — approve expand to 25%?"
    → F41 EvidenceGate: stumble_rate variant vs control
    → Pass: promote via PromotionLoop; Fail: rollback + F47 alert
    → N01: add failing traces to regression suite before evolution starts
```

**Issue-linked mode:** When F29 issue root_cause=`prompt`, auto-trigger evolver with issue context in LLM prompt.

---

## 4. Architecture

Wire existing classes — minimal new code:

```python
# src/eden/agents/evolution/production_trigger.py

async def on_judge_regression(event: JudgeRegressionEvent):
    evolver = JudgeScorePromptEvolver()
    variant_id = await evolver.evolve_for_pair(event.agent_id, event.judge_id)
    if variant_id:
        await PromptEvolvers().enroll_canary(variant_id)
        await improvement_cockpit.notify("prompt_canary", variant_id)
```

Register on `GuardrailHook` / insights loop / judge tailer events.

---

## 5. Safety gates

| Gate | Rule |
|---|---|
| Max variants/run | `evolver_max_variants_per_run` (existing settings) |
| Auto-canary pct | Default 5%; max 25% without admin |
| EvidenceGate | Required before >25% or full promote |
| Regression block | N01 suite must pass on variant before any promote |
| Kill switch | `evolver_auto_canary_pct=0` disables canary only |

---

## 6. Performance & cost optimization

| Step | Cost | Frequency |
|---|---|---|
| Judge scan | $0 SQL | Hourly |
| LLM variant generation | ~$0.05–0.15 | Only on regression |
| Canary traffic | Customer model cost on 5% | Bounded |
| Rollback | $0 | Instant flag flip |

**Latency:** Evolution trigger async; never on ingest hot path.

**Client experience:** Portal shows diff (N13-style) between prompt versions; one-click approve.

### Monitoring

```
eden_evolver_triggered_total
eden_evolver_canary_enrolled_total
eden_evolver_promoted_total
eden_evolver_rollback_total
```

---

## 7. MCP / Portal

- **Portal:** Agent → Prompts → Evolution history + canary status
- **MCP:** `list_prompt_experiments(agent_id)`, `approve_prompt_canary(variant_id)`

---

## 8. Acceptance criteria

- [ ] Judge regression triggers new variant within 1h
- [ ] Canary enrolls at configured pct without manual SQL
- [ ] F41 blocks full promote on failed evidence
- [ ] Rollback restores previous active prompt within 60s
- [ ] Visible in N17 improvement queue

---

## 9. Stand-out narrative

> "Eden doesn't just tell you the prompt regressed — it **proposes, tests, and promotes** the fix with statistical gates."

Combines Galileo eval + Optimizely canary + StatGate — no competitor has all three in one stack.

---

*Wire existing `evolution/components.py`; do not rewrite evolver logic.*
