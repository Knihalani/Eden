# Feature Implementation Specs

> **Master:** [`../FEATURE-GAP-MASTER.md`](../FEATURE-GAP-MASTER.md)  
> **Autonomous model:** [`../AUTONOMOUS-MAINTENANCE.md`](../AUTONOMOUS-MAINTENANCE.md)  
> **Performance SLAs:** [`../PERFORMANCE-COST-STANDARDS.md`](../PERFORMANCE-COST-STANDARDS.md)  
> **Market thesis:** [`../MARKET-HYPOTHESES.md`](../MARKET-HYPOTHESES.md)

## Inventory

| Category | Count |
|---|---|
| F-features (parity) | 24 |
| N-features (differentiation + platform + autonomous) | 21 |
| **Total** | **45** |

## Mandatory in every spec

- Latency budgets (p50/p95)
- Cost model ($/1k ops or $0 deterministic)
- Caching & degradation modes
- Prometheus metrics
- Normal vs autonomous behavior where applicable (N22 tiers)

## P0 ship list

**N14** (blocker), **N22** (autonomy gate), F48, F28, F29, F20, N08, N16, F04, N17, F30, F22, F39, F41, N15, N01, N20, D6, D7, D12

**Autonomous agent maintenance:** F46 orchestrates detect → diagnose → fix → verify. N21 fixes runtime outages; N20 fixes code. N22 sets safety bounds.

| ID | Role |
|---|---|
| F46 | Orchestrator — runs the maintenance loop |
| N21 | Runtime fix — rollback, cache bust, reweight |
| N20 | Code fix — autonomous patch PR from diagnosis |
| N22 | Safety bounds — how far Eden may auto-fix |

See [`../AUTONOMOUS-MAINTENANCE.md`](../AUTONOMOUS-MAINTENANCE.md).

## Production maintenance stand-outs (N14–N19)

| ID | Why it matters |
|---|---|
| N14 | Activates ETEC/StatGate/worker — **unblocks moats** |
| N15 | Evals become live gateway guardrails (shipped EvalToGuardrailLink) |
| N16 | 80% cost cut, keep all failures |
| N17 | Single improvement queue (operator + autonomous columns) |
| N18 | Auto prompt evolution + canary (shipped evolver) |
| N19 | KB compounding with safe two-speed promotion |

See [`../PRODUCTION-MAINTENANCE-STANDOUT.md`](../PRODUCTION-MAINTENANCE-STANDOUT.md).

## Restored high-value (N09–N13)

| ID | Was | Why |
|---|---|---|
| N09 | F11 | Storage cost at scale |
| N10 | F36 | Search → signal conversion |
| N11 | F10 | Live trace tail |
| N12 | F17 | Session timeline |
| N13 | F38 | Transcript polish |

## Spec depth (third pass — July 2026)

All **45** specs expanded with implementation detail + performance/cost sections.

**Fully deepened:** F01, F03, F04, F06, F09, F20, F21, F28–F30, F22, F33–F35, F39–F42, F44, F46–F48, N01–N06, N08–N22.

## Autopilot status refresh (2026-07-12)

Honest SHIPPED (v0) after Full Autopilot core loop + cost/MCP waves (see `.omc/autopilot/phase-validate-gate.md`):

| ID | Status |
|---|---|
| F30 | **SHIPPED (v0)** — TriageAgent anti-spam |
| F46 | **SHIPPED (v0)** — closed_loop orchestrator |
| N20 | **SHIPPED (v0)** — issue-scoped patch + weekly schedule; auto_pr opt-in |
| N22 | **SHIPPED (v0)** — autonomy policy |
| F04 | **SHIPPED (v0)** — MCP server |
| N17 | **SHIPPED (v0)** — improve cockpit |
| N16 / N09 | **SHIPPED (core)** — sampling + content-addressed blobs |
| F03, F12, F20, F28, F29, F35, F47, F48, N08, N14 | **SHIPPED (v0)** — see per-spec headers |
| Wave 7 (N10–N13, F44/…) | **PARTIAL** — save-as-signal / session UI stretch |

## Generator

`generate_specs.py` — skeleton F-specs only; never overwrites hand-edited files.
