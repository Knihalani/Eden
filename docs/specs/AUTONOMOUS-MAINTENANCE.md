# Eden Autonomous & Operator Maintenance Model

> **Purpose:** Define how Eden maintains and improves production agents in **two modes** — operator-driven (normal) and **autonomous** — with shared safety gates.  
> **Specs:** N17 (cockpit), N20–N22 (autonomous), F46 (orchestrator), F41 (evidence)  
> **Ground truth:** [`CODEBASE-GROUND-TRUTH.md`](CODEBASE-GROUND-TRUTH.md)

---

## 1. Two maintenance modes (one platform)

| Mode | Who acts | Eden specs | Shipped foundation |
|---|---|---|---|
| **Operator (normal)** | Human via portal, MCP, Slack | F30 triage, F22 fix chat, F04 MCP, N17 cockpit | Portal, GitHub App |
| **Assisted autonomous** | Eden proposes → human approves | N18, N20, N21, Cat 14 InvestigationAgent | `investigation.py`, `code_change/scheduler.py` |
| **Fully autonomous** | Eden acts within policy | N22 + F41 + StatGate | `SelfHealer`, `PromotionLoop`, flags |

**Principle:** Autonomous never bypasses **F41 EvidenceGate** or **StatGate** for production-impacting changes. HIPAA/regulated orgs default to operator-only.

---

## 2. Autonomous capability matrix (codebase today)

| Capability | Shipped path | Executes today? | Spec to complete |
|---|---|---|---|
| Investigation / RCA | `autonomous/investigation.py:InvestigationAgent` | Proposes only | F30 issue-scoped ReAct |
| Self-heal queue | `SelfHealer` — rollback/reweight/cache_bust | **Queues only** — `pending_approval` | **N21** |
| Autonomous patches | `code_change/scheduler.py` | Generates `proposed_patches` when opted-in | **N20** |
| Prompt evolution | `agents/evolution/components.py` | Canary at 5% default | **N18** |
| Closed-loop apply | `closed_loop_executor.py` | v0 advisory | F46 + N14 wiring |
| Eval→guardrail | `eval_intel/integration.py` | DB row only | **N15** |
| Runtime nudges | — | Missing | **F39** |

Config flags (`config.py`):
- `autonomous_actions_v0` — destructive heal (default gated)
- `code_change_enabled` — org policy JSONB
- `evolver_auto_canary_pct` — default 5
- `evolver_min_samples` — default 20
- `patch_max_per_day`, `patch_cluster_min_size` — cost bounds

---

## 3. Autonomous maintenance loop

```
Detect (F20/N08, $0)
    → Issue (F29)
    → AutonomyPolicy.evaluate(issue)  [N22]
        │
        ├─ manual_only → N17 card for operator
        ├─ propose_patch → Cat23 scheduler [N20] → inbox approve
        ├─ propose_heal → SelfHealer queue [N21] → admin approve
        ├─ evolve_prompt → N18 canary → F41 promote
        ├─ shadow_nudge → F39 → F41 promote
        └─ auto_mcp_handoff → F04 run_autofix (dry_run default)

Verify: N01 regression + N04 impact preview + F33 experiment
Learn: N19 KB flywheel + F40 Book
```

---

## 4. Safety tiers (N22)

| Tier | Actions allowed | Default for |
|---|---|---|
| **T0 Observe** | Detect, alert, triage suggest | All orgs |
| **T1 Suggest** | MCP/portal recommendations, shadow nudges | Standard |
| **T2 Approve-to-act** | Patches/heals queued; prompt canary 5% | Default enterprise |
| **T3 Evidence-auto** | Promote if F41 passes; heal if StatGate P0 | Opt-in |
| **T4 Full auto** | Autofix PR + merge if CI+N01 pass | Sandbox only |

---

## 5. Normal vs autonomous UX (N17 cockpit)

| Queue column | Operator mode | Autonomous mode |
|---|---|---|
| Urgent | Issues needing human | + auto-escalations failed policy |
| Proposed | Empty until human requests | Patches, heals, canaries auto-populated |
| Awaiting approval | — | Self-heal + proposed_patches inbox |
| Running autonomously | — | Active canaries, shadow nudges |

---

## 6. Spec index (autonomous)

| ID | Title |
|---|---|
| N20 | Autonomous code modification (Cat 23 → F29) |
| N21 | Autonomous self-heal & remediation (Cat 14) |
| N22 | Autonomy policy engine (tiers + flags) |
| N18 | Prompt evolution (already spec'd) |
| F46 | Closed-loop orchestrator (state machine) |

---

## 7. Stand-out narrative

> "Eden is the only platform with **graded autonomy** — from operator-led debugging to evidence-gated self-healing — on the same StatGate backbone."

Raindrop automates fix loops; Bento automates learning; **Eden automates with deterministic gates + audit (N06)**.

---

*See [PRODUCTION-MAINTENANCE-STANDOUT.md](PRODUCTION-MAINTENANCE-STANDOUT.md) for full stack.*
