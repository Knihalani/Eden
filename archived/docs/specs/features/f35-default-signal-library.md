# F35: Default Signal Library

| Field | Value |
|---|---|
| **Feature ID** | F35 |
| **Slug** | `default-signal-library` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **SHIPPED (v0)** — default signal library seeded; classifier stretch deferred |
| **Competitive source** | Raindrop |
| **Closes gap** | 3.6, 5.4 |
| **Dependencies** | F06 (investigator), F34 (optional classifiers), F20, F28, N14 |

---

## 1. Summary

Ship **8 prebuilt signal templates** on org create — Forgetting, Laziness, Wins, Jailbreak, Frustration, etc. — Raindrop parity with zero-config semantic detection beyond F20 deterministic detectors. Jump-starts maintenance on day one; feeds F34 as labels accumulate.

---

## 2. Eden current state

| Shipped | Gap |
|---|---|
| F20 deterministic detectors | No semantic signal library |
| F06 investigator spec | No default templates |
| Signal definitions table | No seed migration |

**Greenfield:** `src/eden/signals/defaults.py`, migration `081_seed_default_signals.sql`

---

## 3. Default library (seed)

| Signal ID | Description | Output schema | LLM? |
|---|---|---|---|
| `forgetting` | Agent ignores earlier context | `{forgot: bool, step: int}` | yes |
| `laziness` | Skips tool use when required | `{lazy: bool, skipped_tool: str}` | yes |
| `win` | Task completed exceptionally well | `{win: bool, reason: str}` | yes |
| `jailbreak_attempt` | User tries policy bypass | `{attempt: bool, quote: str}` | yes |
| `user_frustration` | Negative sentiment/regen | `{frustrated: bool}` | yes |
| `hallucination` | Claims without tool evidence | `{hallucinated: bool}` | yes |
| `looping` | Repetitive tool/message pattern | `{loop: bool}` | **no** (StatGate) |
| `cost_spike` | Trace cost >3σ | `{spike: bool}` | **no** (StatGate) |

---

## 4. Architecture

**`src/eden/signals/defaults.py`**

```python
@dataclass
class SignalTemplate:
    id: str
    name: str
    description: str
    output_schema: dict
    investigator_prompt: str | None
    statgate_rule: str | None  # for deterministic signals
    default_enabled: bool

DEFAULT_SIGNALS: list[SignalTemplate] = [...]

PROFILE_SIGNALS = {
    "minimal": ["looping", "cost_spike"],
    "standard": ["forgetting", "laziness", "user_frustration", "hallucination", "looping", "cost_spike"],
    "advanced": [all 8],
}

async def seed_org_signals(org_id: str, profile: str = "standard") -> SeedResult:
    for tmpl in DEFAULT_SIGNALS:
        if tmpl.id in PROFILE_SIGNALS[profile]:
            await signal_service.create_from_template(org_id, tmpl)
    return SeedResult(count=len(PROFILE_SIGNALS[profile]))
```

**Multi-schema investigator:** Single F06 pass returns all enabled LLM signal schemas — **1 LLM call → up to 6 signals**.

---

## 5. Data model

```sql
-- Global templates (not per org)
CREATE TABLE signal_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    output_schema JSONB NOT NULL,
    investigator_prompt TEXT,
    statgate_rule TEXT,
    version INT DEFAULT 1
);

-- Per-org instance links to template
ALTER TABLE signal_definitions ADD COLUMN IF NOT EXISTS template_id TEXT REFERENCES signal_templates(id);
```

Migration `081_seed_default_signals.sql` inserts 8 global templates.

---

## 6. Org onboarding

| Profile | Signals | Use case |
|---|---|---|
| `minimal` | 2 deterministic | Cost-sensitive / dev |
| `standard` | 6 LLM + 2 deterministic | Default new org |
| `advanced` | all 8 + custom slot | Enterprise eval |

**Trigger:** org create webhook + manual re-seed in settings.

Settings: `/orgs/{id}/settings/signals` — toggle per signal, switch profile.

---

## 7. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{org_id}/signals/library` | Templates + enabled state |
| `POST` | `/orgs/{org_id}/signals/library/{id}/enable` | Enable + optional backfill |
| `POST` | `/orgs/{org_id}/signals/library/{id}/disable` | Disable worker immediately |
| `POST` | `/orgs/{org_id}/signals/library/reseed` | Re-apply profile (idempotent) |

**MCP (F04):** `list_default_signals()`, `enable_signal(signal_id)`

---

## 8. Implementation plan

1. Global template migration
2. `seed_org_signals` on org create hook
3. Multi-schema F06 investigator prompt builder
4. StatGate rules for looping + cost_spike
5. Portal settings UI
6. Enable/disable worker subscription (immediate effect)
7. Optional backfill wizard with cost estimate

---

## 9. Feature flags & rollout

| Flag | Default |
|---|---|
| `default_signal_library_v1` | off |
| `default_signal_profile` | standard |
| `default_signal_multi_schema` | on |

Requires N14 quality worker for F06 execution.

---

## 10. Test plan

- New org → 6+ signals enabled without user action
- Frustration fixture trace → fires
- Multi-schema: 1 LLM call returns 6 signal outputs (mock)
- Disable signal → no investigator call for that schema
- minimal profile → $0 LLM on deterministic only

---

## 11. Acceptance criteria

- [x] New org has 6+ signals enabled without user action
- [x] Frustration fires on fixture trace
- [x] Multi-schema investigator ≤1 LLM call per trace
- [x] Disable signal stops worker immediately
- [x] looping/cost_spike use StatGate ($0)
- [x] Enable shows backfill cost estimate

---

## 12. Performance & cost optimization

### Cost model (F06 investigator per org profile)

| Profile | LLM signals | Est. $/1k traces |
|---|---|---|
| minimal | 0 | $0 |
| standard | 6 (1 call) | $0.06–0.30 (SLM) |
| advanced | 8 (1–2 calls) | $0.08–0.40 |

### Controls

- `cost_spike` + `looping` use StatGate — $0
- LLM signals share single investigator pass — **6× cost reduction** vs separate calls
- Daily cap via F06 org budget + N22 autonomy budget
- N16 tail sampling reduces stored traces but not signal obligation on retained

### Latency budgets

| Operation | p50 | p95 |
|---|---|---|
| Seed on org create | 1s | 5s |
| Multi-schema investigate | 800ms | 3s |
| Enable signal (no backfill) | 50ms | 200ms |

### Degradation modes

- LLM budget exceeded → deterministic signals only + alert
- SLM unavailable → queue investigator, StatGate signals continue

### Monitoring

```
eden_default_signal_seed_total{profile}
eden_multi_schema_investigator_calls_total
eden_signal_fired_total{template_id}
eden_signal_disabled_total
```

---

## 13. Dependencies

| Spec | Relationship |
|---|---|
| F06 | Investigator execution |
| F34 | Train classifiers from fired signals |
| F20 | Complementary deterministic detectors |
| F28 | Stumble on signal fire |
| N14 | Worker required |

---

*Feeds F06; pairs with F34 for trained variants at scale.*
