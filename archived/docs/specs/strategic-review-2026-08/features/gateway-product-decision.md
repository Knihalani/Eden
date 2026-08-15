# Gateway product decision (FEAT-124 / FEAT-150)

**Status:** ✅ DONE — 2026-08-06

## Decision

Eden will **not** build or market its own multi-provider LLM
gateway/router (cost-based selection, circuit-breaker failover across a
provider pool, load-balancing). That market is already served by
OpenRouter, Portkey / Palo Alto Networks, LiteLLM, and similar.

## What `/gateway/v1` is

`/gateway/v1` remains a **single-upstream pass-through** with Eden
observability add-ons (PII / nudge / guardrail filters, cost attribution,
optional semantic cache, telemetry). Each request is forwarded to exactly
one upstream (per-request `X-Upstream-*` override, else server config).

It is intentionally **not** a multi-provider router.

## Code consequences

- **FEAT-137:** dormant `AIGateway` multi-provider routing engine deleted;
  filter / cost / cache shell retained for the pass-through path.
- **FEAT-124:** `src/eden/api/routes/gateway.py` module docs and
  `get_ai_gateway()` docstring state the single-upstream scope explicitly.
- Do not allocate roadmap / pitch / engineering time to resurrecting
  multi-provider routing inside Eden.

## Narrative hygiene (FEAT-150)

Repo sweep (2026-08-06): no active product/pitch docs outside this
strategic-review tree claim Eden will ship a competitive multi-provider
gateway. Historical review notes under `features/10-model-gateway.md` and
`aigateway-callsite-audit.md` retain pre-decision analysis; this file is
the canonical forward-looking decision record.
