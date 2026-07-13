# N22: Autonomous Maintenance Safety Bounds

| Field | Value |
|---|---|
| **Feature ID** | N22 |
| **Slug** | `autonomy-policy-engine` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **SHIPPED (v0)** — `closed_loop/autonomy_policy.py` unified policy engine |
| **Role in autonomous maintenance** | **Safety envelope** — how far Eden may go fixing the user's agent without asking (not the maintenance capability itself) |
| **Dependencies** | N14, N17, N20, N21, N18, F39, F41, F46 |

---

## 1. Problem

Eden will autonomously detect, diagnose, and fix production agents (see [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md)). Enterprises need **configurable bounds**:

- Which agents may Eden **auto-rollback** on outage?
- May Eden **open PRs** without human? Auto-merge?
- HIPAA/regulated: detect + diagnose only?
- Daily spend cap on autonomous LLM (triage, patches)?

Today these are **disconnected flags** (`autonomous_actions_v0`, `code_change_enabled`, etc.) — not a coherent safety model.

---

## 2. Target: maintenance bounds (not "autonomy modes" as product)

```python
@dataclass
class AutonomousMaintenancePolicy:
    org_id: str
    agent_id: str | None  # None = org default

    # Primary knob — what users configure
    maintenance_mode: Literal[
        "autonomous",   # Eden runs playbooks: runtime heal + propose/merge code per below
        "assisted",     # Eden auto runtime heal; code patches need approve
        "observe",      # Eden detect + diagnose + recommend only
    ]

    # Fine-grained bounds (defaults depend on maintenance_mode)
    auto_runtime_heal: bool = True       # rollback, cache_bust, reweight — N21
    auto_code_patch_pr: bool = True      # N20 opens PR
    auto_code_patch_merge: bool = False  # N20 auto-merge (sandbox only default)
    auto_prompt_canary: bool = True      # N18 on quality drop
    auto_nudge_promote: bool = False     # F39 — requires F41 evidence always
    auto_guardrail_promote: bool = False # N15 — requires F41 evidence always

    daily_maintenance_budget_usd: float = 25.0  # triage + patch LLM cap
    max_auto_rollbacks_per_day: int = 3
    compliance_profile: Literal["standard", "hipaa", "soc2_strict"] = "standard"
```

**HIPAA profile:** `maintenance_mode=observe` — Eden detects/diagnoses/alerts; zero autonomous execute.

---

## 3. maintenance_mode semantics

| Mode | Eden behavior on outage/quality drop |
|---|---|
| **autonomous** | Execute runtime heals (N21). Open PRs (N20). Opt-in auto-merge. Run prompt canaries. Promote nudges/guardrails only with F41 pass. |
| **assisted** | Same as autonomous for **runtime heals**. Code patches → PR + human merge. |
| **observe** | Detect (F20/N08), diagnose (F30), alert (F47), recommend in N17 — **no execute** |

F41 + StatGate are **hard gates** in all modes — no unverified production mutation.

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
