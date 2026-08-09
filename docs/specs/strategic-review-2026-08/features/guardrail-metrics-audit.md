# FEAT-38 — Guardrail enforcement metrics audit

**Date:** 2026-08-07  
**Status:** Complete — no customer-facing conflation found; one client wiring fix applied  
**Depends on:** FEAT-3 (bypass removed), FEAT-33 (bypass monitoring)

## Risk statement

When `install_cat15_trajectory_replaces_intervention` was active, cost/loop/latency
trajectory checks could substitute for `InterventionEngine.evaluate_and_act`. Any
customer-facing dashboard that reported "guardrail enforcement" from the wrong path
would show unrelated metrics as content-safety enforcement.

## What was searched

### Portal (`clients/portal/src/**`)

| Pattern / surface | Result |
|---|---|
| `guardrails/metrics`, `guardrails/log`, `scan-history`, `GuardrailMetrics`, `InterventionLog` | **0 matches** — portal does not call intelligence metrics/log endpoints |
| `clients/portal/src/app/(portal)/guardrails/**` | Policy list + detail UI; red-team page (probe findings, not enforcement counters) |
| `clients/portal/src/lab/guardrails/**` | Production guardrails chrome wired via `dynamic()` from the real `/guardrails` route |
| `enforcement`, `blocked`, `intervened`, `matchCount`, `hits / 24h` under guardrails | Only `matchCount24h` / "Hits / 24h" on policy detail and page header meta |
| `clients/portal/src/components/marketing/**` | Decorative trace mock only — no live metrics |

### Backend APIs feeding portal guardrails

| Endpoint | Used by portal? | Enforcement metrics? | Source |
|---|---|---|---|
| `GET /orgs/{org}/portal/guardrails/policies` | **Yes** (`portalApi.guardrailPolicies`) | `matchCount24h` per policy | `intervention_log` grouped by `policy_id` (24h window, `policy_id IS NOT NULL`) |
| `GET /orgs/{org}/intelligence/guardrails/metrics` | No | `GuardrailMetrics.dashboard()` aggregates | `intervention_log` (7d) |
| `GET /orgs/{org}/intelligence/guardrails/log` | No | `InterventionLog.query()` | `intervention_log` |
| `GET /orgs/{org}/intelligence/guardrails/scan-history` | No | Scan feed (not wired to portal today) | `intervention_log` |
| `GET /orgs/{org}/intelligence/guardrails/policies` | No (portal uses `/portal/` route) | CRUD only — no hit counts | `guardrail_policies` table |

## What exists today

1. **Policy UI (customer-facing):** `/guardrails` — list, filters, detail with enforcement
   section (action, status, severity, hits/24h). No full metrics dashboard chart.
2. **Red-team UI:** `/guardrails/redteam` — probe catalog and findings; separate from
   runtime enforcement counters.
3. **Server `GuardrailMetrics`:** Implemented in `eden.guardrails.intervention`; exposed
   at `/intelligence/guardrails/metrics` but **not consumed by the portal**.
4. **`intervention_log` writers:**
   - `InterventionEngine.evaluate_and_act` — canonical content-safety enforcement (always
     sets `live: true` on success).
   - Standalone detector scans (e.g. `PromptInjectionDetector.scan`) — best-effort rows with
     `policy_id IS NULL`; excluded from per-policy `matchCount24h` by the portal SQL filter.

## Bypass path vs metrics — conclusion

**No conflation found.**

- FEAT-3 removed the trajectory monkey-patch; `evaluate_and_act` is no longer substitutable.
- FEAT-33's `record_guardrail_bypass_if_detected()` alerts on responses tagged
  `feature=trajectory_guardrail`; that bypass path **never inserted into `intervention_log`**.
- All customer-visible enforcement counts (`matchCount24h`, and the unused
  `GuardrailMetrics` API) read **`intervention_log` only** — the audit trail for the real
  InterventionEngine path.
- The portal `counts` prop on `guardrails-list-view.tsx` is a **policy-count filter tally**,
  not an enforcement metric.

## Fix applied during audit

`portalApi.guardrailPolicies` was still typed for the intelligence `GuardrailPolicy.list`
ok-envelope (`{data: {policies}}`) even though the portal route returns a bare
`GuardrailPolicyCard[]` with `matchCount24h`. Updated the client to map the correct shape
so hits/24h render honestly from `intervention_log` (see `clients/portal/src/lib/api/portal.ts`
and `portal.test.ts`).

## Guidance for future metrics UI

When wiring a guardrail enforcement dashboard:

1. **Read `intervention_log` only** — via `GuardrailMetrics`, `InterventionLog.query()`, or
   the portal `_fetch_match_counts` pattern. Do not aggregate cost/loop/latency trajectory
   signals into content-safety enforcement views.
2. **Require `InterventionEngine.evaluate_and_act` provenance** — responses used for live
   enforcement must have `live: true` and must **not** carry `feature: "trajectory_guardrail"`.
   Reject or alert on the latter (same as `record_guardrail_bypass_if_detected`).
3. **Per-policy counts** — filter `policy_id IS NOT NULL` so orphan scan rows do not
   attribute hits to the wrong policy.
4. **Do not mix policy CRUD with metrics** — `guardrail_policies` has no hit columns; keep
   metrics queries separate from `GuardrailPolicy.list`.

## Files touched

- `docs/specs/strategic-review-2026-08/features/guardrail-metrics-audit.md` (this note)
- `clients/portal/src/lib/api/portal.ts` — correct portal card mapping + `matchCount24h`
- `clients/portal/src/lib/api/__tests__/portal.test.ts` — FEAT-38 regression test
- `clients/portal/src/lab/fixtures/guardrails.ts` — type comment for `matchCount24h`
- `src/eden/api/routes/portal.py` — `policy_id IS NOT NULL` filter + FEAT-38 docstring
- `src/eden/guardrails/intervention.py` — `GuardrailMetrics` FEAT-38 guidance comment

## Related docs

- `docs/docs/observability/37-runtime-guardrails.md` — Portal dashboard audit (FEAT-38) section
- `docs/specs/strategic-review-2026-08/features/12-runtime-guardrails.md` — original guardrails spec
