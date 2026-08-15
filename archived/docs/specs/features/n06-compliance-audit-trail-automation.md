# N06: Compliance Audit Trail Automation

| Field | Value |
|---|---|
| **Feature ID** | N06 |
| **Slug** | `compliance-audit-trail-automation` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** (Cat 10 governance exists; agent-specific automation missing) |
| **Market hypothesis** | Regulated industries block agent rollouts without provable audit trails |
| **Dependencies** | Cat 10 governance, F41, F39, N04, N20, N21, N22, F04 |

---

## 1. Summary

Extend Eden's **existing governance moat** (SOC2, RTBF, audit chain) with agent-specific **append-only ledger**, one-click compliance packs, and policy engine — covering operator actions, MCP/autonomous actions, and promotion events. Required for HIPAA `manual` mode (N22) and enterprise autonomous maintenance trust.

---

## 2. Eden current state

| Shipped | Path | Gap |
|---|---|---|
| Audit chain verify | `governance/audit_chain.py` | No agent event hooks |
| RTBF | governance | No ledger tombstone integration |
| SOC2 controls | docs + partial | No agent compliance export |
| Cat 10 governance API | `api/routes/governance*.py` | No `agent_audit_ledger` |
| Self-heal before_state | `autonomous/_common.py` | Not in unified ledger |

**Competitive edge:** Laminar/Raindrop/Bento lack chain-verified audit — Eden extends, not rebuilds.

---

## 3. Target behavior

### 3.1 Agent Audit Ledger (append-only)

Every material event → signed ledger entry chained to existing audit verify:

| Event type | Examples | Actor types |
|---|---|---|
| `config_change` | Prompt, model, tool schema, nudge promote | user, system |
| `access` | MCP fix PR opened, trace exported, PII unmask | user, mcp, system |
| `runtime` | StatGate block, nudge applied, delegation | system |
| `promotion` | F41 evidence gate pass/fail | system |
| `autonomous` | N20 patch proposed/approved, N21 heal executed | mcp, system |
| `policy` | N22 tier change, budget exceeded downgrade | user, system |
| `regression` | N01 run blocked promotion | system |

```sql
CREATE TABLE agent_audit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    event_subtype TEXT,
    agent_id TEXT,
    actor_id UUID,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user','mcp','system','service_account')),
    payload JSONB NOT NULL,
    prev_hash TEXT,
    entry_hash TEXT NOT NULL,
    compliance_tags TEXT[] DEFAULT '{}',  -- 'hipaa', 'phi', 'soc2'
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX agent_audit_ledger_org_agent_ts_idx
    ON agent_audit_ledger (org_id, agent_id, created_at DESC);
```

**Hash chain:** `entry_hash = sha256(prev_hash + canonical_json(payload) + created_at)` — compatible with `governance/audit_chain.py` verify endpoint.

### 3.2 Compliance packs

One-click export (PDF + JSON bundle):
- Prompt version history for agent (30/90/365d)
- All F39 nudge promotions with F41 evidence refs
- N04 impact preview reports per deploy
- N20/N21 autonomous actions with before/after state
- N22 policy history
- Sample traces with PII redacted per org policy
- Chain verification attestation JSON

**Portal:** `/compliance/agents/{id}/export`

### 3.3 Policy engine (compliance overlays)

```yaml
policies:
  - name: hipaa_no_live_debug
    rule: debugger.live_rerun forbidden for agents tagged phi=true
    audit: log_denied_attempt
  - name: dual_approval_promotion
    rule: nudge.promote requires 2 approvers for tier=critical
  - name: autonomous_heal_forbidden
    rule: self_heal.execute forbidden when compliance_profile=hipaa
    maps_to: N22 T0-T1
  - name: mcp_export_requires_reason
    rule: trace.export requires reason field length >= 20
```

Policies evaluated **before** N22 `may()` — compliance is hard deny, not tier downgrade.

---

## 4. Architecture

```
HookBus (all material events)
    → AgentAuditLedgerWriter (async, batched)
    → agent_audit_ledger + hash chain
    → CompliancePackGenerator (on-demand)
    → S3 presigned bundle + PDF renderer

PolicyEngine (compliance rules)
    → pre-check before N22 / F04 / F01 debugger
    → denied → ledger entry event_subtype=denied
```

| Component | Path |
|---|---|
| `AgentAuditLedgerWriter` | `src/eden/governance/agent_ledger.py` |
| `CompliancePackGenerator` | `src/eden/governance/compliance_pack.py` |
| `CompliancePolicyEngine` | `src/eden/governance/compliance_policies.py` |

**Wire existing:** `governance/audit_chain.py` verify includes agent ledger segment.

---

## 5. API specification

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/orgs/{id}/compliance/ledger` | Query with filters |
| `POST` | `/orgs/{id}/compliance/agents/{agent_id}/export` | Generate pack |
| `GET` | `/orgs/{id}/compliance/exports/{export_id}` | Download status |
| `POST` | `/orgs/{id}/compliance/verify` | Chain verify (extend existing) |
| `GET/PATCH` | `/orgs/{id}/compliance/policies` | Compliance policy CRUD |

**MCP (F04):**

| Tool | Purpose |
|---|---|
| `export_audit_pack` | Generate compliance export for agent + date range |
| `verify_audit_chain` | Run chain verify, return attestation |
| `query_audit_ledger` | Filter events (read-only) |

---

## 6. Autonomous maintenance audit requirements

| Action | Required ledger fields |
|---|---|
| N20 patch propose | `payload.patch_id`, `payload.issue_id`, LLM cost |
| N20 patch approve/merge | `actor_id`, `payload.pr_url`, N04 report ref |
| N21 heal execute | `payload.before_state`, `payload.after_state`, StatGate verdict |
| N18 canary promote | `payload.prompt_version`, F41 evidence id |
| N22 budget downgrade | `payload.from_tier`, `payload.to_tier`, `payload.spend_usd` |
| F04 run_autofix | `actor_type=mcp`, tool sequence, dry_run flag |

**Principle:** Every autonomous side effect is reconstructable without LLM inference.

---

## 7. Implementation plan

1. Migration + `AgentAuditLedgerWriter` HookBus subscriptions
2. Hash chain integration with existing verify
3. Compliance pack generator (JSON first, PDF phase 2)
4. Policy engine pre-checks for HIPAA profile
5. Portal compliance tab + export UX
6. MCP tools (read-only except export trigger)

---

## 8. Feature flags & rollout

| Flag | Default |
|---|---|
| `agent_audit_ledger_v1` | off |
| `compliance_pack_export_v1` | off |
| `compliance_policy_engine_v1` | off |

Enable for regulated design partners first.

---

## 9. Test plan

- Prompt merge webhook → `config_change` entry within 60s
- F04 MCP autofix → `actor_type=mcp` entry
- Export 90d range → completes <5min, verify passes
- HIPAA policy → live debugger blocked + denied attempt logged
- N21 heal → before/after in payload

---

## 10. Acceptance criteria

- [ ] Prompt merge to main creates `config_change` ledger entry within 60s
- [ ] F04 MCP `run_autofix` logged as `actor_type=mcp`
- [ ] Audit pack export completes for 90d range in <5 min
- [ ] Chain verify passes on exported pack
- [ ] HIPAA org: live debugger blocked with audit log of attempt
- [ ] N20/N21 autonomous actions appear in pack with before/after state
- [ ] N22 policy changes auditable with actor attribution

---

## 11. Performance & cost optimization

### Latency budgets

| Operation | p50 | p95 | p99 |
|---|---|---|---|
| Ledger write (async) | 5ms | 20ms | 50ms |
| Ledger query (100 rows) | 30ms | 150ms | 400ms |
| Compliance pack (90d) | 60s | 4min | 8min |
| Chain verify | 2s | 10s | 30s |
| Policy pre-check | 1ms | 5ms | 15ms |

### Cost model

- **LLM tier:** 0 for ledger; PDF summary optional SLM ~$0.05/pack
- **Storage:** ~1–5KB/entry; 90d agent ≈ 5–50MB pack
- **S3:** Standard export lifecycle 30d retention

### Caching strategy

- Policy rules: Redis 60s
- Export jobs: idempotent by `(org, agent, date_range)` hash

### Degradation modes

- Ledger writer backlog → spool to Redis queue, never drop
- Export timeout → partial pack + resume token
- Verify failure → export marked `attestation_failed` with details

### Monitoring

```
eden_agent_audit_ledger_writes_total{event_type}
eden_compliance_export_duration_seconds
eden_compliance_policy_denied_total{policy}
eden_audit_chain_verify_failures_total
```

---

## 12. Dependencies

| Spec | Relationship |
|---|---|
| N22 | Compliance profiles gate autonomy |
| N20/N21 | Autonomous action logging |
| N04 | Deploy impact in compliance pack |
| F41 | Promotion evidence refs |
| F04 | MCP actor attribution |
| Cat 10 | Existing chain verify |

---

*Leverages Eden moat vs all four competitors. See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.6, [AUTONOMOUS-MAINTENANCE.md](../AUTONOMOUS-MAINTENANCE.md).*
