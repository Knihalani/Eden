# N06: Compliance Audit Trail Automation

| Field | Value |
|---|---|
| **Feature ID** | N06 |
| **Slug** | `compliance-audit-trail-automation` |
| **Priority** | P1 |
| **Effort** | M |
| **Eden status** | **PARTIAL** (Cat 10 governance exists; agent-specific automation missing) |
| **Market hypothesis** | Regulated industries (finance, health) block agent rollouts without provable audit trails |
| **Dependencies** | Cat 10 governance, F41, F39, N04 |

---

## 1. Problem

Eden has SOC2, RTBF, audit chain verification — **ahead of competitors**. But buyers ask:
- "Show every prompt change and who approved it"
- "Prove this agent run used approved model version"
- "Export audit pack for regulator in one click"

Today this requires manual SQL + portal navigation. **Automation** is the gap.

---

## 2. Target behavior

### 2.1 Agent Audit Ledger (append-only)

Every material event gets a signed ledger entry:

| Event type | Examples |
|---|---|
| `config_change` | Prompt, model, tool schema, nudge promote |
| `access` | MCP fix PR opened, trace exported, PII unmask |
| `runtime` | StatGate block, nudge applied, delegation |
| `promotion` | F41 evidence gate pass/fail |

```sql
CREATE TABLE agent_audit_ledger (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    agent_id TEXT,
    actor_id UUID,          -- user or service account
    actor_type TEXT,        -- user, mcp, system
    payload JSONB NOT NULL,
    prev_hash TEXT,
    entry_hash TEXT NOT NULL,  -- chain link to existing audit verify
    created_at TIMESTAMPTZ DEFAULT now()
);
```

### 2.2 Compliance packs

One-click export (PDF + JSON):
- Prompt version history for agent
- All F39 nudge promotions with evidence
- N04 impact preview reports for each deploy
- Sample traces with PII redacted per policy

### 2.3 Policy engine

```yaml
policies:
  - name: hipaa_no_live_debug
    rule: debugger.live_rerun forbidden for agents tagged phi=true
  - name: dual_approval_promotion
    rule: nudge.promote requires 2 approvers for tier=critical
```

---

## 3. MCP integration

| Tool | Purpose |
|---|---|
| `export_audit_pack` | Generate compliance export for agent + date range |
| `verify_audit_chain` | Run existing chain verify, return attestation |

---

## 4. Eden competitive advantage

**Do not rebuild governance** — extend Cat 10:
- `src/eden/governance/audit_chain.py` → hook ledger writes
- Portal compliance tab → consume ledger
- Reuse existing RTBF for trace deletion with ledger tombstone

---

## 5. Acceptance criteria

- [ ] Prompt merge to main creates `config_change` ledger entry within 60s
- [ ] F04 MCP `run_autofix` logged as `actor_type=mcp`
- [ ] Audit pack export completes for 90d range in <5 min
- [ ] Chain verify passes on exported pack
- [ ] HIPAA org: live debugger blocked with audit log of attempt

---

*Leverages Eden moat vs all four competitors. See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §3.6.*
