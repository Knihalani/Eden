# Phase 2 fact-check: is the "deferred mount table" real, and are the subsystems other forks found actually wired?

**Verdict: the deferred mount table is real, comprehensive, and every subsystem checked below IS wired and reachable at runtime — except `llmops/model_comparator.py`, which is genuinely orphaned (defined, never imported/registered anywhere).**

The apparent "125 router files vs ~13 `include_router` calls" mismatch that triggered this audit is explained: eden moved from eager `app.include_router(...)` calls to a two-tier deferred-mount mechanism in `src/eden/api/app.py` (comment: "FastAPI's per-route Dependant/signature analysis for these ~100 routers dominated the 3.3s cold `import eden.api.app`"), mounted during FastAPI's `lifespan` instead of at import time:

- **Eager** (import-time, e.g. L1256-1258): `gateway.router`, `gateway_models.router`, `gateway_analytics.router` — these three are NOT even deferred, they're mounted immediately.
- **`_DEFERRED_INTELLIGENCE_ROUTERS`** (`app.py:140-162`), mounted by `mount_deferred_routers()`, called at `app.py:710` before the server accepts traffic (B26).
- **`_DEFERRED_ROUTERS`** (`app.py:188-307`), mounted by `mount_tier2_routers()` (W15-c), same idempotent import-and-include pattern, order-preserving (documented ordering constraints for shadowed routes like `prompts_v2` before `prompts`).

Both are asserted against a route-inventory snapshot test (`tests/unit/api/test_api_surface_snapshot.py`), so the served HTTP surface is claimed to be identical to the old eager-mount version — I did not run that test myself in this pass, flagging as unverified-by-me.

## Module-by-module verdict

| Module | Wired? | Evidence |
|---|---|---|
| `playground/` (`service.py`, `scorers.py`, `llm_handler.py`, +more) | **Yes** | Route file `api/routes/playgrounds.py` registered `app.py:250` (`"eden.api.routes.playgrounds", "router"` → `/orgs/{org_id}/playgrounds`, W18 U03/F49) |
| `evaluation/` (golden datasets, CI eval) | **Yes** | `api/routes/intelligence_eval.py` imports `from eden.evaluation.eval_intel import (...)`; registered in `_DEFERRED_INTELLIGENCE_ROUTERS` (`app.py:148`). Also `production_eval` registered `app.py:267`. |
| `guardrails/` | **Yes** | `intelligence_guardrails` in `_DEFERRED_INTELLIGENCE_ROUTERS`, `app.py:151` |
| `time_travel/` | **Yes** | `intelligence_time_travel` in `_DEFERRED_INTELLIGENCE_ROUTERS`, `app.py:159` |
| `alerts/` (`compiler.py`, `repo.py`, `routes.py`, `triage_judge.py`) | **Yes** | `("eden.alerts.routes", "router")` registered `app.py:244` — "F81 NL alerts compile + rules". Note: this is distinct from `api/routes/replay.py` (`app.py:286`, "/orgs/{org_id}/alerts/.../replay/ack") — two different routers both live under the `/alerts` URL space, not a naming collision bug, just two features sharing a prefix. |
| `analytics/funnels.py`, `analytics/cohorts.py` | **Yes** | `("eden.api.routes.analytics_v2", "router")`, `app.py:289` — comment explicitly says `"analytics/{cohorts,funnel} (8.2)"` |
| `gateway.py` / `gateway_analytics.py` / `gateway_models.py` | **Yes (eagerly, not even deferred)** | `app.py:1256-1258`, `app.include_router(...)` at import time |
| `cost.py` | **Yes** | `("eden.api.routes.cost", "router")`, `app.py:200` |
| `sdk/a2a.py` | **N/A — not a router, doesn't need mounting** | This is client-SDK code (`src/eden/sdk/a2a.py`), not a server route. The related server-side endpoint is `api/routes/observability_a2a.py`, which imports `from eden.services.observability import get_a2a_service` (not from `sdk/a2a.py` directly) and IS registered — `("eden.api.routes.observability_a2a", "router")`, `app.py:213`. Don't conflate the two "a2a" things; both are fine, they're just unrelated to each other. |
| `llmops/model_comparator.py` | **NO — genuinely orphaned** | `api/routes/llmops.py` imports `from eden.llmops import (...)` but grepping the whole repo for `model_comparator`/`ModelComparator` outside its own file returns zero hits. Defined, never imported, never routed. This one is real dead code, not a false alarm. |
| `replay/` (rrweb) | **Yes** | `("eden.api.routes.replay", "router")`, `app.py:286` |
| `governance_intel/` | **Yes** | `intelligence_governance` in `_DEFERRED_INTELLIGENCE_ROUTERS`, `app.py:150` |
| `redteam/` (`probes.py` 699 lines, `findings_store.py` 125 lines) | **Yes** | `("eden.api.routes.redteam", "router")`, `app.py:241` — "/orgs/{org_id}/redteam (Phase L)". (I initially mis-grepped and thought this was orphaned — corrected within this same pass; the reference is real.) |
| `data_platform/` | **Yes** | `("eden.api.routes.data_platform", "router")`, `app.py:288` |
| `closed_loop/` | **Yes** | `intelligence_closed_loop` in `_DEFERRED_INTELLIGENCE_ROUTERS`, `app.py:144` |
| `nudges/` | **Yes** | `("eden.api.routes.learn", "router")`, `app.py:266` — comment: "nudges/promotions/book/drift (WS2)" |
| `improvement/` (issue→patch→test→auto-merge→auto-revert) | **Yes** | `("eden.api.routes.improve", "router")`, `app.py:265` — "/orgs/{org_id}/improve (N17 + F04 autofix)" |

## Bottom line for the rest of this review

Every prior fork's "eden already has X" correction in this session checks out **except one detail**: `llmops/model_comparator.py` is dead code, not a live feature — any roadmap item that assumed it's reachable needs to instead treat it as "exists but needs to be wired up," same bucket as `record_shadow_feedback`.

Everything else — including things that sound almost too good to be true (guardrails, time_travel, redteam, nudges, improvement, alerts/NL-compile, funnels/cohorts) — is genuinely mounted and reachable via HTTP today. **Router registration alone doesn't prove UI-level reachability or that the feature works correctly** — several other forks in this review (frontend/test-failures, API-contract) already separately confirmed things like the "ignored" issue-dismiss action has no portal button despite the backend accepting it. Backend-wired ≠ user-reachable ≠ bug-free; those are three different questions and this audit only answers the first one.
