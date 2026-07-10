# F39: Runtime Nudge Injection

| Field | Value |
|---|---|
| **Feature ID** | F39 |
| **Priority** | P0 |
| **Effort** | XL |
| **Eden status** | MISSING |
| **Competitive source** | BentoLabs AI (core moat) |
| **Dependencies** | F29 (issues), F41 (evotion gate), F28–F20 (detection) |

---

## 1. Summary

Bento closes the loop **inside the agent run**: recurring failures become trigger-based nudges (skills/tools/prompt appends) that ship in **shadow mode**, prove helpful, then promote to 100% traffic. Eden's KB (`ProceduralClient`) stores skills for analysts — nothing injects at `AIGateway` pre_invoke today.

This is Eden's counter to Bento's "Run 101 > Run 1" positioning.

---

## 2. Eden current state (codebase-accurate)

| Component | Path | Status |
|---|---|---|
| Skill storage | `src/eden/kb/procedural/client.py:24` | **SHIPPED** — no runtime hook |
| Gateway filter registry | `src/eden/llmops/filters/base.py:18–41` | **SHIPPED** — extension point for F39 |
| `AIGateway.register_filter` | `src/eden/llmops/ai_gateway.py:459–499` | **SHIPPED** |
| Nudge engine / filter | — | **MISSING** |
| StatGate (promotion only today) | `trace_quality/wiring.py` | **SHIPPED** — gates apply, not nudges |
| Cat 23 patches | `src/eden/code_change/` | Code changes, not runtime hints |

---

## 3. Nudge object model

```python
@dataclass
class Nudge:
    id: UUID
    org_id: str
    agent_id: str
    name: str
    trigger: dict  # JSON DSL — see §4
    action_type: Literal[
        "system_append",   # append markdown to system message
        "tool_block",      # prevent tool call matching pattern
        "tool_rewrite",    # suggest different tool/args
        "subagent_hint",   # inject delegation instruction
    ]
    content: str         # markdown/yaml body
    mode: Literal["shadow", "promoted", "archived"]
    source_issue_id: UUID | None
    evidence: dict       # promotion stats
```

**Customer repo export (absorbed F45):** `eden-nudges/{agent_id}/{nudge_id}.yaml` — version-controlled nudges in customer repo; CI can diff on PR

---

## 4. Trigger DSL

```yaml
# Example: bash command not found loop
trigger:
  all:
    - event: tool_result
      tool_name: bash
      result_contains: "command not found"
    - event: trace_context
      same_tool_repeats: { tool: bash, min: 3, window_steps: 10 }
action_type: system_append
content: |
  When `python` fails on macOS, use `python3`. Never retry the same shell command more than twice.
```

**Evaluator:** `src/eden/nudges/trigger_eval.py` — compile trigger JSON to predicate functions over `AgentContext`.

---

## 5. Gateway integration (critical path — codebase-accurate)

**Extension point:** `GatewayFilter` protocol in `src/eden/llmops/filters/base.py:18–41`.  
**Registration:** `AIGateway.register_filter()` in `ai_gateway.py:459–499`.  
**Pipeline order:** Filters run **before** cache and budget checks (`ai_gateway.py:593–629`).

**Do NOT monkey-patch `AIGateway.complete()`** — implement nudges as a filter.

```python
# src/eden/llmops/filters/nudge_filter.py

class NudgeGatewayFilter:
    name = "runtime_nudge"

    def enabled(self, request: ModelRequest) -> bool:
        return request.context.get("nudges_enabled", True)

    def apply(self, request: ModelRequest) -> tuple[ModelRequest, list[str]]:
        nudges = self._engine.evaluate_sync(request.context)  # Redis-cached triggers
        applied = []
        for nudge in nudges:
            if nudge.mode == "shadow":
                self._outcomes.log_shadow(nudge, request)
                continue
            request.messages, meta = apply_nudge(nudge, request.messages)
            applied.append(meta)
        return request, [str(a) for a in applied]
```

Register on startup after N14 platform activation:

```python
gateway.register_filter(NudgeGatewayFilter(nudge_engine))
```

**Parallel path (already shipped):** trajectory guardrails via `POST /v1/guardrails/trajectory/check` (`trace_quality.py:333`) — compose with filter for full coverage.

**`AgentContext` fields** (passed via `ModelRequest.context`):
- org_id, agent_id, trace_id, step_number
- recent_tool_calls (last 10)
- session metadata
- prompt_version_id

---

## 6. Authoring pipeline

```
Recurring issue (F29, stumble_count ≥ 5)
    → NudgeAuthor LLM (reads example traces + triage F30)
    → Draft nudge in shadow mode
    → NudgePromotionWorker (F41) scores shadow outcomes
    → Promote or archive
```

**`src/eden/nudges/author.py`**

---

## 7. Data model

```sql
CREATE TABLE nudges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    trigger JSONB NOT NULL,
    action_type TEXT NOT NULL,
    content TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'shadow'
        CHECK (mode IN ('shadow','promoted','archived')),
    source_issue_id UUID REFERENCES agent_issues(id),
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    promoted_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ
);

CREATE TABLE nudge_outcomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nudge_id UUID NOT NULL REFERENCES nudges(id) ON DELETE CASCADE,
    trace_id UUID NOT NULL,
    mode TEXT NOT NULL,
    matched BOOLEAN NOT NULL,
    applied BOOLEAN NOT NULL,
    outcome_success BOOLEAN,
    metric_delta JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 8. API

| Method | Path |
|---|---|
| `GET/POST` | `/orgs/{org_id}/nudges` |
| `GET/PATCH` | `/orgs/{org_id}/nudges/{id}` |
| `POST` | `/orgs/{org_id}/nudges/{id}/promote` — manual override |
| `POST` | `/orgs/{org_id}/nudges/{id}/archive` |
| `POST` | `/orgs/{org_id}/nudges/export` — zip yaml for repo |

---

## 9. Safety

- **Shadow default** — all auto-authored nudges start shadow
- **F41 mandatory** — auto-promote only if EvidenceGate passes
- **Demotion** — 7d rolling success drops >5% → archive + alert
- **Kill switch** — org `nudges_enabled=false`
- **Human review queue** — optional require approval before promote

---

## 10. Acceptance criteria

- [ ] Shadow nudge matches but does not alter messages (logged only)
- [ ] Promoted `system_append` visible in trace system message audit field
- [ ] Wrong nudge archived automatically on regression test
- [ ] Export produces valid YAML committed to test repo
- [ ] Gateway overhead p95 <5ms for nudge evaluation (cached triggers)

---

## 11. Performance & cost optimization

### Gateway hot path

| Step | p95 budget |
|---|---|
| Load active nudges for agent | <2ms (Redis cache) |
| Trigger evaluation (compiled predicates) | <3ms |
| Apply promoted nudge to messages | <1ms |
| **Total gateway overhead** | **<5ms** |

### Cost

- Shadow mode: **$0** — log only
- Nudge author LLM: async on issue resolve (~$0.02/nudge)
- Promoted nudges: $0 at inference

### Caching & degradation

- Compile trigger DSL on save; Redis cache by nudge_id
- Max 50 active nudges/agent; eval timeout → skip + log
- `nudges_enabled=false` → zero overhead early exit

---

## 12. Repo export workflow (absorbed F45)

Previously spec'd as standalone F45; merged here because export is part of nudge lifecycle, not a separate product surface.

### 11.1 Export format

```yaml
# eden-nudges/checkout-agent/bash-python3.yaml
apiVersion: eden.ai/v1
kind: Nudge
metadata:
  agent_id: checkout-agent
  source_issue_id: "..."
spec:
  trigger:
    all:
      - event: tool_result
        tool_name: bash
        result_contains: "command not found"
  action_type: system_append
  content: |
    On macOS use python3 instead of python.
  mode: promoted
```

### 11.2 Sync modes

| Mode | Behavior |
|---|---|
| **Pull** | `POST /nudges/export` → zip for git commit |
| **Git sync** | GitHub App watches `eden-nudges/**` → upsert nudges in Eden |
| **MCP** | F04 `export_nudges(agent_id)` for coding-agent workflow |

### 11.3 Safety

- Import always lands in **shadow** mode until F41 EvidenceGate promotes
- Git PR changing nudge triggers N04 impact preview (optional)

---

*Bento FAQ parity: "Run 101 measurably better" — measure via A/B on issue stumble rate with nudges enabled vs disabled.*

*See [DELETED-FEATURES.md](./DELETED-FEATURES.md) for F45 merge rationale.*
