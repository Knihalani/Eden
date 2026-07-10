# Eden Autonomous Agent Maintenance

> **What this means:** Eden **maintains and improves the user's production agent on its own** — detecting errors and quality drops, finding root cause, applying fixes when possible, verifying recovery, and preventing recurrence.  
> **Not:** A separate "autonomy mode" for operators. The platform runs agent SRE continuously; humans set bounds and review edge cases.  
> **Specs:** F46 (orchestrator), N20–N21 (fix execution), N22 (safety bounds), N17 (visibility)  
> **Ground truth:** [`CODEBASE-GROUND-TRUTH.md`](CODEBASE-GROUND-TRUTH.md)

---

## 1. Product promise

**Eden is an autonomous agent SRE platform.** Once wired (N14), it:

1. **Watches** production traffic 24/7 — errors, loops, latency, cost, eval scores, MCP health, behavioral drift
2. **Detects** outages and quality degradation in seconds (mostly $0 deterministic — N08, F20)
3. **Diagnoses** root cause — bad deploy, prompt regression, cache poison, tool/MCP failure, model routing drift (F30, InvestigationAgent)
4. **Fixes** what it can without waiting for a human — rollback, cache bust, reweight routing, runtime nudges/guardrails, prompt canary, code patch PR
5. **Verifies** the agent recovered — regression eval, live quality trend, experiment (N01, N03, F33)
6. **Learns** so the same failure is less likely next time — KB skills, Book, permanent regression cases (N19, F40, N01)

Operators stay in the loop for **novel failures, regulated environments, and high-risk code changes** — but routine production incidents should resolve without a 3am page.

---

## 2. The autonomous maintenance loop (core architecture)

This is the loop F46 orchestrates end-to-end:

```
┌──────────────────────────────────────────────────────────────────┐
│                    CONTINUOUS MONITORING                          │
│  N03 prod eval · F42 drift · N05 fleet SLO · N02 MCP · N08 StatGate│
└────────────────────────────┬─────────────────────────────────────┘
                             │ anomaly / error / stumble
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                    DETECT & TRIAGE (<90s)                         │
│  F20/F28 stumble → F29 issue → F30 RCA (InvestigationAgent)      │
│  Classify: deploy_regression | mcp_outage | loop | quality_drop  │
│            cost_spike | tool_misuse | unknown                     │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│              AUTONOMOUS REMEDIATION (pick playbook)               │
│                                                                   │
│  deploy_regression  → N21 rollback prompt/model                    │
│  cache_poison       → N21 cache_bust                               │
│  routing_drift      → N21 reweight away from bad model             │
│  prompt_quality     → N18 canary better prompt → F41 promote     │
│  recurring_pattern  → F39 shadow nudge → F41 promote               │
│  eval_failure       → N15 guardrail from failing eval              │
│  code_bug           → N20 autonomous patch → PR (verify N04+N01)   │
│  mcp_auth_outage    → F47 alert + runbook; F28 track until fixed   │
│  unknown            → N17 escalate human + F04 MCP context         │
└────────────────────────────┬─────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                    VERIFY RECOVERY (5–30 min)                     │
│  N03: eval pass rate back in band?                                │
│  N01: regression suite still green?                               │
│  F33: treatment variant beating control?                          │
│  N08: StatGate P0 clear?                                          │
└────────────────────────────┬─────────────────────────────────────┘
                             │ pass                          │ fail
                             ▼                               ▼
┌─────────────────────────────────────┐   ┌──────────────────────┐
│  RESOLVE + LEARN                     │   │  ESCALATE / RETRY     │
│  N01 regression case                 │   │  Reopen issue (F46)   │
│  N19 KB skill + F40 Book chapter     │   │  N17 urgent + F47     │
│  N06 audit complete                  │   │  Human + F22 fix chat │
└─────────────────────────────────────┘   └──────────────────────┘
```

**N22 is not the loop** — it is the **safety envelope** around remediation (what Eden may execute vs propose vs escalate). See §5.

---

## 3. Incident playbooks (what Eden fixes autonomously)

Concrete scenarios Eden must handle. Each maps to shipped or specced components.

### 3.1 Post-deploy regression (outage / quality cliff)

| Signal | F42 model_mix change + N08 loop spike + stumble_rate ↑ after deploy |
|---|---|
| Diagnosis | F30: "prompt v12 deployed 14:02, loop rate 0.1% → 8%" |
| **Autonomous fix** | N21 `rollback` to last F41-promoted prompt version |
| Verify | N03 eval pass rate recovers within 1h; N08 P0 clears |
| Learn | N01 regression case from incident traces; F40 Book "do not repeat" |

### 3.2 Service quality drop (no obvious deploy)

| Signal | N03 eval pass rate drops >2σ; F42 `tool_distribution` PSI >0.2 |
|---|---|
| Diagnosis | F30 + InvestigationAgent: upstream MCP latency, tool API change, context truncation |
| **Autonomous fix** | If prompt drift: N18 canary. If pattern: F39 nudge shadow → promote. If MCP: cache_bust + F47 |
| Verify | N03 hourly fail_rate back below SLO |
| Learn | N10 save search as signal if novel pattern |

### 3.3 Agent error loop / runaway tool calls

| Signal | N08 StatGate P0 `<200ms` — ETEC loop detector, no LLM |
|---|---|
| Diagnosis | F30: bash invoked 12× on same command |
| **Autonomous fix** | N15 live guardrail block (if eval exists) OR F39 nudge on next request OR N21 rollback if post-deploy |
| Verify | Stumble rate on affected agent → 0 for 30min |
| Learn | N01 permanent regression; N19 KB skill |

### 3.4 MCP / tool chain outage

| Signal | N02 auth failure spike; error_rate >5% on `server_name=github` |
|---|---|
| Diagnosis | F30: OAuth token expired; 401 on 847 traces |
| **Autonomous fix** | Cannot fix credentials — **detect + isolate**: F47 P0 alert, F28 issue, optionally pause agent routing (N21 reweight to fallback path if configured) |
| Verify | N02 auth_failure_count → 0 after customer rotates token |
| Learn | N19 runbook skill "GitHub MCP token rotation" |

### 3.5 Cache poisoning / stale responses

| Signal | Sudden wrong answers, no deploy; semantic cache hit rate anomalous |
|---|---|
| Diagnosis | InvestigationAgent + F42 cost/latency: cache hit pattern |
| **Autonomous fix** | N21 `cache_bust` for org+agent prefix |
| Verify | N03 quality scores recover; sample trace manual spot-check optional |
| Learn | N06 audit + optional guardrail on cache TTL |

### 3.6 Recurring code bug in agent application

| Signal | Same stumble fingerprint ≥5× in 24h; F30 points to application code |
|---|---|
| Diagnosis | F30 triage + example traces → stack trace / file:line |
| **Autonomous fix** | N20 PatchGenerator → proposed patch → PR (default: **human merge**; sandbox: auto-merge after N04+N01) |
| Verify | N01 regression on PR branch; F33 experiment post-merge |
| Learn | N01 case + N19 skill |

### 3.7 Behavioral drift / silent degradation

| Signal | F42 weekly report: `avg_steps` +18%, cost +22%, eval flat |
|---|---|
| Diagnosis | F30: model routing shifted to expensive path |
| **Autonomous fix** | N21 `reweight` toward cheaper model if quality holds; else N18 prompt tune |
| Verify | F42 PSI normalizes over 7d; N05 fleet SLO green |

---

## 4. What Eden fixes vs escalates (honest bounds)

| Eden fixes autonomously (when enabled) | Eden detects + escalates (human required) |
|---|---|
| Rollback bad prompt/model deploy | Novel failure with no playbook match |
| Cache bust / routing reweight | Customer MCP credential rotation |
| Runtime nudge / guardrail promotion (F41 gated) | Architectural agent redesign |
| Prompt canary → promote after evidence | Production code merge (default enterprise) |
| Shadow-mode prevention while gathering evidence | Regulated PHI agents (N22: observe-only) |
| Permanent regression case + KB skill | Third-party API prolonged outage |

**Default enterprise posture:** Eden **executes** runtime heals (rollback, cache, nudge, guardrail) and **proposes** code patches. Customer opts into broader auto-execution via N22.

---

## 5. Safety envelope (N22 — supporting, not the story)

N22 answers: *"How far may Eden go fixing this agent without asking?"* It is **not** the maintenance capability itself.

| Bound | Purpose |
|---|---|
| `maintenance_mode: autonomous` | Eden runs playbooks in §3 without per-incident approval |
| `maintenance_mode: assisted` | Eden executes runtime heals; code patches need approve |
| `maintenance_mode: manual` | Eden detects + diagnoses only; all fixes human-triggered |
| Per-action caps | Max auto-rollbacks/day, max patch LLM spend, max canary % |
| Compliance profile `hipaa` | No autonomous execute on production; detect + audit only |
| F41 + StatGate | **Hard gate** — no production-impacting promote without evidence |
| N06 audit | Every detect → diagnose → fix → verify step logged |

---

## 6. Spec map (by loop stage)

| Stage | Specs | Shipped today |
|---|---|---|
| **Activate** | N14 | ❌ worker/wiring not started |
| **Monitor** | N03, N05, N02, F42, N08 | Partial — hooks exist, UX missing |
| **Detect** | F20, F28, F29, F35, F06/F34 | ❌ issues/ greenfield |
| **Diagnose** | F30, InvestigationAgent | Partial — proposes only |
| **Fix (runtime)** | N21, F39, N15, N18 | Partial — queue only / missing |
| **Fix (code)** | N20, F22, F04 | Partial — Cat 23 not issue-linked |
| **Verify** | N01, N03, F33, N04 | ❌ |
| **Learn** | N19, F40, N01 | Partial — detector_loop running |
| **Orchestrate** | F46 | ❌ greenfield |
| **Visibility** | N17, F47 | Partial |
| **Safety** | N22, F41, N06 | Partial governance |

---

## 7. Codebase foundation (what we build on)

| Capability | Path | Gap to autonomous maintenance |
|---|---|---|
| Deterministic P0 detect | `trace_quality/hooks.py`, StatGate | Wire N14 — not running |
| Investigation / RCA | `autonomous/investigation.py` | Execute fixes, issue-scoped F30 |
| Self-heal | `SelfHealer` rollback/reweight/cache_bust | **Execute path missing** (N21) |
| Autonomous patches | `code_change/scheduler.py` | Not triggered by F29 issues (N20) |
| Prompt evolution | `agents/evolution/components.py` | Wire to quality-drop playbook (N18) |
| Eval→guardrail | `eval_intel/integration.py` | Promote to gateway (N15) |
| Insights→KB | `insights/detector_loop.py` | Flywheel coordinator (N19) |
| Orchestrator | — | F46 greenfield |

---

## 8. Stand-out narrative (correct framing)

> **"Eden keeps your production agent healthy — detecting outages and quality drops, finding root cause, and fixing what it can — while you sleep."**

Competitors help you **observe** or **manually fix**. Eden closes the loop:

- **Raindrop** — issues + experiments; weak on autonomous runtime heal + deterministic P0
- **Bento** — nudges + learning; weak on incident response + code fix + StatGate
- **Laminar** — debug/replay; not production autonomous SRE
- **Eden** — detect ($0) → diagnose → fix (runtime + code) → verify → learn, with audit

N22/F41/N06 exist so autonomous maintenance is **trustworthy**, not so operators configure "autonomy modes" as the primary workflow.

---

## 9. N17 cockpit (visibility, not control panel)

N17 shows **what Eden is doing to your agent**:

| Section | Shows |
|---|---|
| **Active incidents** | Open issues, StatGate P0, SLO breaches |
| **Eden actions in progress** | Rollback executing, canary at 5%, shadow nudge logging |
| **Awaiting you** | Code patch PR, novel failure, credential rotation |
| **Resolved this week** | Fixes applied, quality recovered, learnings added |

Human actions: approve patch merge, provide MCP credentials, snooze noisy alert — not "run the maintenance loop."

---

*See [PRODUCTION-MAINTENANCE-STANDOUT.md](PRODUCTION-MAINTENANCE-STANDOUT.md), [F46](features/f46-closed-loop-orchestrator.md), [N20](features/n20-autonomous-code-modification.md), [N21](features/n21-autonomous-self-heal-remediation.md).*
