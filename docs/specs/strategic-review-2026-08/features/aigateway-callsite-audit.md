# FEAT-151 — AIGateway production call-site audit

> **FEAT-137 applied (2026-08-06)**
>
> **Deleted** from `AIGateway` (dormant multi-provider routing engine):
> provider registry (`register_provider`, `_providers`); CircuitBreaker +
> failover `.complete()` routing loop; `_select_provider` /
> `_select_fallback` / `_execute_provider`; `PROVIDER_SPECS` /
> `ProviderSpec` / `WireFormat` / `MODEL_PERFORMANCE`; `OllamaClient` /
> `OpenAICompatibleClient` / `AnthropicCompatibleClient`;
> `register_providers_from_env` / `register_default_providers`.
>
> **Kept** (live `/gateway/v1` shell): filter chain
> (`register_filter` / `_filters.run` / default PII); `cost_resolver` +
> pricing refresh / `resolve_cost` / `_estimate_cost`; semantic/exact
> cache hooks; honest empty `get_metrics` / `get_provider_health` stubs;
> `.complete()` raises `ProviderUnavailableError` directing callers to
> `/gateway/v1` or `eden.llm.internal_router.route_async`.
>
> **Callers fixed:** `time_travel/replayer.py` `_re_execute_step` →
> `internal_router.route_async` (same pattern as
> `improvement/replay_verify.py`); llmops `/gateway/metrics` +
> `/gateway/health` documented as retired-empty.
>
> **FEAT-150 (2026-08-06):** multi-provider gateway is **not** an Eden
> product bet. Canonical decision: `gateway-product-decision.md`.
> `/gateway/v1` stays a single-upstream pass-through (FEAT-124).
>
> Status columns in the original audit below reflect **pre-FEAT-137** state.

**Date:** 2026-08-06  
**Scope:** Every production (`src/eden/**`) reference that constructs or invokes `eden.llmops.ai_gateway.AIGateway`, classified live / broken / dormant.  
**Out of scope:** Unit/API tests that construct `AIGateway()` for isolation.

## Summary

`AIGateway` is a real multi-provider routing engine (circuit breakers, cost-based selection, fallback). In production today **no call site ever registers providers** (`register_providers_from_env` / `register_default_providers` have zero production callers). The class is still constructed and used for **filters / semantic cache / cost_resolver** on the customer `/gateway/v1` path. The multi-provider `.complete()` routing path is **broken when called** (empty `_providers` → `ProviderUnavailableError`).

| Status | Count | Meaning |
|--------|------:|---------|
| **Live** | 3 surfaces | Filters/cache/cost on `/gateway/v1`; learn-filter install; llmops metrics/health (empty but reachable) |
| **Broken** | 1 | Time Travel re-execute still calls `.complete()` against an empty provider map |
| **Dormant / retired** | 3 | Module-level singleton with no routing use; 410 stub; unused constructor fallback |

---

## Production call sites

### 1. `src/eden/api/routes/gateway.py` — **LIVE** (filters / cache / cost only)

| Symbol | Line (approx) | Use | Status |
|--------|---------------|-----|--------|
| `AIGateway(...)` via `get_ai_gateway()` | ~332 | Lazy singleton with optional `semantic_cache` | **Live** construction |
| `get_ai_gateway()._filters` | ~947, ~1304 | PII / nudge / guardrail / learn filters on chat completions | **Live** |
| `get_ai_gateway().cost_resolver` | ~1671 | Cost attribution for gateway traffic | **Live** |
| `.complete()` | — | Not called | N/A |

Customer traffic goes through the OpenAI-compatible HTTP client in this module; `AIGateway` is not used for provider selection. Docstring at `get_ai_gateway()` states this explicitly.

### 2. `src/eden/api/routes/llmops.py` — **LIVE (empty metrics) / RETIRED stub**

| Symbol | Line (approx) | Use | Status |
|--------|---------------|-----|--------|
| `_ai_gateway = AIGateway()` | ~42 | Module singleton | **Dormant for routing** (never gets providers) |
| `gateway_complete` | ~584 | Raises HTTP **410** — retired 2026-07-04; points callers to `/gateway/v1` | **Retired** |
| `_ai_gateway.get_metrics(...)` | ~612 | `/gateway/metrics` | **Live endpoint, empty data** (metrics only written inside `.complete()` / `_execute_provider`) |
| `_ai_gateway.get_provider_health()` | ~622 | `/gateway/health` | **Live endpoint, empty data** (same reason) |

### 3. `src/eden/llmops/learn_wiring.py` — **LIVE** (filter install)

| Symbol | Line (approx) | Use | Status |
|--------|---------------|-----|--------|
| Prefer `llmops._ai_gateway` | ~43–45 | Shared singleton when import works | **Live** wiring target |
| `AIGateway()` fallback | ~47–49 | Only if import of shared singleton fails | **Dormant fallback** |
| `install_learn_filters(gateway=...)` | ~67+ | Registers nudge/book/guardrail/prompt_deploy filters | **Live** (also invoked from `gateway.get_ai_gateway()` startup) |

Does **not** call `register_providers_from_env` or `.complete()`.

### 4. `src/eden/time_travel/replayer.py` — **BROKEN**

| Symbol | Line (approx) | Use | Status |
|--------|---------------|-----|--------|
| `get_ai_gateway()` + `gw.complete(req)` | ~442–453 | `_re_execute_step` live model re-execution | **Broken** |

With empty `_providers`, `_select_provider` returns `None` and `.complete()` raises `ProviderUnavailableError`. Call site catches `Exception` and falls back to recorded values (`cannot_replay` / not claiming re-executed). Feature appears to work but **never actually re-executes live**.

### 5. `src/eden/improvement/replay_verify.py` — **FIXED / no longer an AIGateway caller**

`_gateway_complete` previously called `AIGateway.complete()`; it now routes through `eden.llm.internal_router.route_async` (comment documents the empty-provider bug). **Not an AIGateway production call site anymore.**

### 6. `src/eden/llmops/ai_gateway.py` — definition only

| Symbol | Status |
|--------|--------|
| `class AIGateway` | Implementation |
| `register_providers_from_env` / `register_default_providers` | **Dormant** — zero callers under `src/eden` outside this file |

### 7. Related but **not** `AIGateway`

These look gateway-adjacent in greps but are separate stacks:

- `eden.llm.client.OpenRouterClient` — **live** internal LLM traffic
- `eden.llm.internal_router` / `ModelRouter` — **live** internal routing
- `eden.sdk.provider_routing` / observability provider-routing routes — **live** observation of *customer* gateways, not `AIGateway`
- `/gateway/v1/*` HTTP proxy — **live** single-upstream pass-through (uses `AIGateway` only for filters/cache/cost as in §1)

---

## Inventory checklist (construct / invoke)

| File | Construct `AIGateway()` | Call `.complete()` | Other `AIGateway` API | Verdict |
|------|:-----------------------:|:------------------:|-----------------------|---------|
| `api/routes/gateway.py` | Yes (`get_ai_gateway`) | No | `_filters`, `cost_resolver` | **Live** (non-routing) |
| `api/routes/llmops.py` | Yes (module singleton) | No (410 stub) | `get_metrics`, `get_provider_health` | **Live empty** + **retired** stub |
| `llmops/learn_wiring.py` | Fallback only | No | `register_filter` / `unregister_filter` | **Live** filters |
| `time_travel/replayer.py` | Via `get_ai_gateway` | **Yes** | — | **Broken** |
| `improvement/replay_verify.py` | No | No (migrated) | — | N/A |
| `llmops/ai_gateway.py` | Definition | Definition | `register_providers_from_env` unused | **Dormant** registration |

---

## Recommendation (audit only; no code change in this feat)

1. Treat multi-provider routing inside `AIGateway` as dead product surface unless `register_providers_from_env` is wired and Settings grows real provider credentials.
2. Fix or explicitly retire `TraceReplayer._re_execute_step` (repoint at `OpenRouterClient` / `internal_router`, matching `replay_verify`).
3. Keep `/gateway/v1` filter/cache/cost use of the class; that path is real customer value and does not need the routing engine.
