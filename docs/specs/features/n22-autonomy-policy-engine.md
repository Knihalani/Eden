# N22: Autonomy Policy Engine (Graded Self-Maintenance)

| Field | Value |
|---|---|
| **Feature ID** | N22 |
| **Slug** | `autonomy-policy-engine` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **MISSING** — flags exist scattered in config; no unified policy |
| **Mode** | Governs **normal + autonomous** maintenance |
| **Dependencies** | N14, N17, N20, N21, N18, F39, F41, F46 |

---

## 1. Problem

Autonomous capabilities are gated by **disconnected flags**:
- `autonomous_actions_v0` (`config.py:157`)
- `code_change_enabled` (org JSONB)
- `evolver_auto_canary_pct` (default 5)
- `mcp_autofix_v1`, `nudges_enabled`, etc.

Enterprise buyers need **one policy object**: "What can Eden do autonomously for agent X?" with HIPAA/regulated overrides.

---

## 2. Target: AutonomyPolicy model

```python
@dataclass
class AutonomyPolicy:
    org_id: str
    agent_id: str | None  # None = org default

    maintenance_mode: Literal["manual", "assisted", "autonomous"]

    # Per-action tiers (T0–T4 from AUTONOMOUS-MAINTENANCE.md)
    detect_and_alert: AutonomyTier = T0  # always
    triage_llm: AutonomyTier = T1          # suggest
    mcp_autofix: AutonomyTier = T2         # dry_run default
    code_patch: AutonomyTier = T2          # propose → inbox
    self_heal: AutonomyTier = T2           # queue approve
    prompt_canary: AutonomyTier = T2       # 5% auto
    nudge_shadow: AutonomyTier = T1        # auto shadow
    nudge_promote: AutonomyTier = T3       # F41 required
    guardrail_promote: AutonomyTier = T3   # N15 + F41
    pr_auto_merge: AutonomyTier = T4       # sandbox only

    daily_autonomy_budget_usd: float = 25.0
    require_statgate_for_auto: bool = True
    require_regression_pass: bool = True
```

---

## 3. Tier semantics

| Tier | Behavior | Example |
|---|---|---|
| **T0** | Detect + alert only | HIPAA PHI agents |
| **T1** | Suggest in N17/MCP; no side effects | Default triage |
| **T2** | Auto-create **proposals** (patches, heals, shadow nudges) | Enterprise default |
| **T3** | Auto-execute if **F41 + StatGate** pass | Opt-in production |
| **T4** | Auto-merge/deploy if CI+N01 pass | Dev/sandbox agents |

**Evaluation:**

```python
class AutonomyPolicyEngine:
    async def may(self, org_id: str, agent_id: str, action: AutonomyAction) -> PolicyDecision:
        policy = await self._resolve(org_id, agent_id)  # agent override > org default
        tier = getattr(policy, action.field)
        if tier == T0:
            return PolicyDecision(deny=True, reason="manual_only")
        if await self._budget_exceeded(org_id):
            return PolicyDecision(deny=True, reason="budget")
        return PolicyDecision(allow=True, tier=tier, requires_approval=tier <= T2)
```

---

## 4. Data model

```sql
CREATE TABLE autonomy_policies (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES organizations(id),
    agent_id TEXT,  -- NULL = org default
    policy JSONB NOT NULL,
    compliance_profile TEXT CHECK (compliance_profile IN ('standard','hipaa','soc2_strict')),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (org_id, agent_id)
);

CREATE TABLE autonomy_audit_log (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    agent_id TEXT,
    action TEXT NOT NULL,
    tier_applied TEXT NOT NULL,
    decision TEXT NOT NULL,  -- allow, deny, require_approval
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

**Preset profiles:**

| Profile | maintenance_mode | Key restrictions |
|---|---|---|
| `standard` | assisted | T2 patches, T3 nudge promote with F41 |
| `hipaa` | manual | T0–T1 only; no auto-heal |
| `sandbox` | autonomous | T4 allowed for pr_auto_merge |
| `cost_sensitive` | assisted | Lower budgets, T1 triage SLM only |

---

## 5. Integration points

| Consumer | Calls |
|---|---|
| F46 orchestrator | `may(action)` before each transition |
| N20 patch trigger | `may(code_patch)` |
| N21 self-heal | `may(self_heal)` + `autonomous_actions_v0` |
| N18 evolver | `may(prompt_canary)` → caps `evolver_auto_canary_pct` |
| F39 nudge author | `may(nudge_shadow)`, `may(nudge_promote)` |
| F04 run_autofix | `may(mcp_autofix)` |
| N17 cockpit | Display effective policy + blocked actions |

---

## 6. API

| Method | Path |
|---|---|
| `GET/PATCH` | `/orgs/{id}/autonomy-policy` |
| `GET/PATCH` | `/orgs/{id}/agents/{agent_id}/autonomy-policy` |
| `GET` | `/orgs/{id}/autonomy-audit` |

**Portal:** Settings → Autonomy → matrix UI (action × tier grid)

**MCP:** `get_autonomy_policy(agent_id)`

---

## 7. Performance & cost optimization

| Concern | Mitigation |
|---|---|
| Policy lookup | Redis cache 60s keyed `(org_id, agent_id)` |
| Evaluation | O(1) JSON field lookup — p95 <1ms |
| Budget tracking | Redis daily counter `autonomy_spend:{org_id}:{date}` |
| Audit writes | Async batch insert |

**daily_autonomy_budget_usd** covers: patch LLM, triage, evolver, autofix — prevents runaway autonomous COGS.

---

## 8. Acceptance criteria

- [ ] HIPAA profile blocks T2+ actions
- [ ] Agent override beats org default
- [ ] F46 calls policy engine on every autonomous transition
- [ ] Budget exceeded → downgrade to T1 suggest-only + alert
- [ ] Audit log queryable for N06 compliance pack
- [ ] Portal matrix saves and applies within 60s

---

## 9. Stand-out narrative

> **Graded autonomy** — not binary "AI on/off" — with per-action tiers, compliance presets, and spend caps. Required for enterprise autonomous agent maintenance.

---

*Central gate for all autonomous specs. See [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md).*
