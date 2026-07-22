# Surfaces index — Eden portal rebuild

> **Status:** Authoritative index for `docs/portal-rebuild/surfaces/`  
> **Decision date:** 2026-07-21  
> **Contract:** Every must-ship file must satisfy [../README.md](../README.md) Document contracts (Purpose → Acceptance).  
> **Phases:** [../README.md](../README.md) rebuild phases P2–P7.

---

## How to use

1. Implement rows with **Status = Spec** (file present, contract complete).  
2. **Expected** = required must-ship file not yet in folder — IA/bible remain binding.  
3. **Stub** = Later only; do not build in P0–P7.  
4. Debugger is must-ship but **not** a core sidebar leaf.

---

## Must-ship surfaces

| File | Status | Phase | Purpose (one line) |
|------|--------|-------|--------------------|
| [dashboard.md](./dashboard.md) | Spec | P2 | Agent-centric OS landing after login — health, diagnosis, next action. |
| [agents.md](./agents.md) | Spec | P2 | Customer agent list/fleet + connect + agent home (`/agents`, `/agents/[id]`). |
| [traces.md](./traces.md) | Spec | P3 | Observe hub — traces/spans/sessions lenses; transcript-first reader. |
| [sessions.md](./sessions.md) | Spec | P3 | Sessions capability (canonical `/traces?view=sessions`; `/sessions` redirects). |
| [issues.md](./issues.md) | Spec | P3 | Clustered/filed failures — master–detail triage → Improve. |
| [alerts.md](./alerts.md) | Spec | P3 | Alerts inbox + rules + Signals — acknowledge/route to Trace/Issue. |
| [evals.md](./evals.md) | Spec | P4 | Evaluate hub — datasets → playgrounds → experiments (tabs). |
| [improve.md](./improve.md) | Spec | P5 | Closed-loop hub — queue/plans/artifacts/promotions/ledger/history + PR exits. |
| [artifacts.md](./artifacts.md) | Spec | P5 | Artifact list/detail grammar (canonical under Improve `tab=artifacts`). |
| [ledger.md](./ledger.md) | Spec | P5 | Institutional memory of promotions/PRs (Improve `tab=ledger` + agent peek). |
| [cost.md](./cost.md) | Spec | P5 | Spend, budgets, outcomes, forecast, advisor — gateway FinOps. |
| [guardrails.md](./guardrails.md) | Spec | P5 | Guardrail **policies** + violations — **no** red-team UI. |
| [ai-agent.md](./ai-agent.md) | Spec | P6 | Eden AI — `/agent` page **and** clickable bubble; citations + fix/plan/PR actions. |
| [debugger.md](./debugger.md) | Spec | P6 | DebuggerSession replay / compare / time-travel (Laminar investigation energy). |
| [settings.md](./settings.md) | Spec | P7 | Workspace admin — gateway/keys/org/members/billing; ≤8 visible tabs + Advanced. |
| [audit.md](./audit.md) | Spec | P7 | Quiet audit trail + AuditPack export. |

---

## Later stubs (not v1)

| File | Status | Phase | Purpose (one line) |
|------|--------|-------|--------------------|
| [_later-prompts.md](./_later-prompts.md) | Stub | Later | Prompts registry — redirect only in v1. |
| [_later-analytics.md](./_later-analytics.md) | Stub | Later | Analytics/users/tools/insights hub — redirect only in v1. |

---

## Index / meta

| File | Status | Purpose |
|------|--------|---------|
| [_INDEX.md](./_INDEX.md) | Spec | This catalog. |

---

## Phase map

| Phase | Surfaces |
|-------|----------|
| **P2** | Dashboard, Agents |
| **P3** | Traces, Sessions, Issues, Alerts |
| **P4** | Evals |
| **P5** | Improve, Artifacts, Ledger, Cost, Guardrails |
| **P6** | AI Agent, Debugger |
| **P7** | Settings, Audit |
| **Later** | Prompts, Analytics |

---

## Core nav cross-check (12 leaves)

| # | Leaf | Surface file |
|---|------|--------------|
| 1 | `/dashboard` | dashboard.md |
| 2 | `/agents` | agents.md |
| 3 | `/traces` | traces.md (+ sessions.md) |
| 4 | `/issues` | issues.md |
| 5 | `/alerts` | alerts.md |
| 6 | `/evals` | evals.md |
| 7 | `/improve` | improve.md (+ artifacts.md, ledger.md) |
| 8 | `/guardrails` | guardrails.md |
| 9 | `/cost` | cost.md |
| 10 | `/agent` | ai-agent.md |
| 11 | `/audit` | audit.md |
| 12 | `/settings` | settings.md |

**Non-leaf must-ship:** Debugger → [debugger.md](./debugger.md).

**Naming:** `/agent` (Eden AI) ≠ `/agents` (customer agents) — [ai-agent.md](./ai-agent.md) §0.

---

## Folder inventory (on disk)

Present as of index pass: `_INDEX.md`, `_later-analytics.md`, `_later-prompts.md`, `agents.md`, `ai-agent.md`, `alerts.md`, `audit.md`, `artifacts.md`, `cost.md`, `dashboard.md`, `debugger.md`, `evals.md`, `guardrails.md`, `improve.md`, `issues.md`, `ledger.md`, `sessions.md`, `settings.md`, `traces.md`.

No remaining **Expected** must-ship surface files.

---

## Status legend

| Status | Meaning |
|--------|---------|
| **Spec** | File present; treat as implementable contract |
| **Expected** | Must-ship; file not yet written |
| **Stub** | Later — do not build in P2–P7 |

Update Status when Expected files land.

---

## Acceptance (index)

- [x] Links every required must-ship + Later stub filename  
- [x] Phase P2–P7 + Later assigned  
- [x] ai-agent / debugger / settings / audit Spec  
- [x] Remaining Expected (`artifacts.md`) exists as Spec before P7 complete  

---

*End of surfaces/_INDEX.md*
