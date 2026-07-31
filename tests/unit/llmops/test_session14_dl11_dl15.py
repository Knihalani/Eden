"""Session 14 tests — Hooks bus + gateway metrics + budgets (DL-11..DL-15).

Five audit items:

* **DL-11** — ``hooks_bus.HookBus`` kept dedup/suppressions/events
  in three dicts that grew without bound for long-lived pods.
  A separate bug: the cascade chain had no depth cap so a
  bad automation could ``parent_hook_id``-loop forever.
  Fix: ``sweep(now)`` evicts expired entries; ``_MAX_CASCADE_DEPTH = 5``
  rejects events that would extend the chain past 5.

* **DL-12** — ``AIGateway._metrics`` was a plain ``list``. A
  long-lived pod serving millions of requests eventually
  OOM'd. Fix: ``collections.deque(maxlen=10_000)``.

* **DL-13** — ``AIGateway._tenant_budgets`` was a per-pod
  in-memory dict. Each pod counted its own slice, so the
  tenant effectively had ``N × cap`` (where N = pod count).
  Fix: DL-15 wires the same spend into ``BudgetService.record_usage``
  (DB-backed, shared across pods).

* **DL-14** — ``QuotaEnforcementMiddleware`` failed open on a
  hard-limit exception — a DB blip meant requests sailed
  through and a free-tier tenant could blow past their cap.
  Also, the budget status was treated as fresh forever —
  a >60s stale value could miss a cap. Fix: fail closed
  on exception OR staleness > 60s; cache the last known
  hard limit per org to fail against.

* **DL-15** — ``BudgetService.record_usage`` was defined but
  never called from the gateway hot path, so the per-org
  spend in the DB stayed at 0. Fix: ``AIGateway.complete()``
  now calls ``record_usage(tenant_id, cost_usd)`` after a
  successful response (best-effort, never breaks the chat).
"""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.config import Settings


def _quota_enabled_settings() -> Settings:
    """Settings with ``quota_enabled=True`` for DL-14 fail-closed tests.

    The conftest's ``patch_settings`` autouse fixture flips
    ``quota_enabled`` to False so the observability / onboarding
    suites can exercise mutating routes without seeding
    org_resource_limits. The DL-14 fail-closed tests need
    enforcement ON so the ``quota_enabled`` short-circuit at
    the top of ``dispatch`` is skipped.
    """
    return Settings(quota_enabled=True)


# ─── DL-11: HookBus sweep + cascade depth cap ──────────────────────
class TestDl11HookBusSweep:
    """Pre-fix: _dedup / _suppressions / _events / _cascade_depth
    dicts grew unbounded. A noisy org emitting millions of
    distinct events per day would OOM the worker. Fix: periodic
    sweep evicts expired entries; cascade chain capped at 5."""

    @pytest.mark.asyncio
    async def test_sweep_evicts_expired_dedup(self) -> None:
        from eden.llmops.hooks_bus import HookBus

        bus = HookBus()
        # Inject a stale dedup entry.
        bus._dedup["k1"] = ("h1", time.time() - 1)
        # Inject a live dedup entry.
        bus._dedup["k2"] = ("h2", time.time() + 60)
        evicted = bus.sweep()
        assert evicted >= 1
        assert "k1" not in bus._dedup
        assert "k2" in bus._dedup

    @pytest.mark.asyncio
    async def test_sweep_evicts_old_suppressions(self) -> None:
        from eden.llmops.hooks_bus import HookBus

        bus = HookBus()
        bus._suppressions[("org-1", "p-1")] = ("high", time.time() - 3700)
        evicted = bus.sweep()
        assert evicted >= 1
        assert ("org-1", "p-1") not in bus._suppressions

    @pytest.mark.asyncio
    async def test_cascade_depth_cap_rejects(self) -> None:
        """A chain deeper than _MAX_CASCADE_DEPTH is rejected
        with ``None`` so a runaway automation can't loop forever."""
        from eden.llmops.hooks_bus import HookBus, HookEvent

        bus = HookBus()

        # Build a chain of 5 events: p1 → p2 → p3 → p4 → p5.
        prev_id = None
        for _i in range(5):
            ev = HookEvent(
                reason="test_cascade",
                severity="low",
                org_id="org-1",
                source={"primary_entity_id": "entity-1"},
                parent_hook_id=prev_id,
            )
            hook_id = await bus.emit(ev)
            assert hook_id is not None
            prev_id = hook_id

        # The 6th event (depth 6) MUST be rejected.
        ev = HookEvent(
            reason="test_cascade",
            severity="low",
            org_id="org-1",
            source={"primary_entity_id": "entity-1"},
            parent_hook_id=prev_id,
        )
        result = await bus.emit(ev)
        assert result is None, (
            "DL-11 regression: cascade depth cap not enforced — "
            "events deeper than _MAX_CASCADE_DEPTH were admitted"
        )

    @pytest.mark.asyncio
    async def test_cascade_depth_tracked_per_hook(self) -> None:
        """Depth is recorded on each hook so a child can compute
        its own depth from the parent's."""
        from eden.llmops.hooks_bus import HookBus, HookEvent

        bus = HookBus()

        # Root event.
        root = HookEvent(
            reason="root",
            severity="low",
            org_id="org-1",
            source={"primary_entity_id": "e-1"},
        )
        root_id = await bus.emit(root)
        assert bus._cascade_depth[root_id] == 1

        # Child.
        child = HookEvent(
            reason="child",
            severity="low",
            org_id="org-1",
            source={"primary_entity_id": "e-1"},
            parent_hook_id=root_id,
        )
        child_id = await bus.emit(child)
        assert bus._cascade_depth[child_id] == 2

    @pytest.mark.asyncio
    async def test_sweep_clears_dead_events(self) -> None:
        """Events no longer referenced by any dedup entry are
        evicted along with their cascade_depth entry."""
        from eden.llmops.hooks_bus import HookBus

        bus = HookBus()
        bus._events["orphan-1"] = MagicMock(parent_hook_id=None)
        bus._cascade_depth["orphan-1"] = 1

        evicted = bus.sweep()
        assert "orphan-1" not in bus._events
        assert "orphan-1" not in bus._cascade_depth
        assert evicted >= 1


# ─── DL-12: AIGateway._metrics is bounded ─────────────────────────
class TestDl12GatewayMetricsBounded:
    """Pre-fix: ``AIGateway._metrics`` was a plain list. A
    long-lived pod serving millions of requests eventually
    OOM'd. Post-fix: ``collections.deque(maxlen=10_000)``."""

    def test_metrics_is_deque_with_maxlen(self) -> None:
        from eden.llmops.ai_gateway import AIGateway

        g = AIGateway()
        from collections import deque

        assert isinstance(g._metrics, deque), "DL-12 regression: _metrics is not a deque"
        assert g._metrics.maxlen == 10_000

    def test_metrics_overflow_evicts_oldest(self) -> None:
        """Appending past maxlen silently evicts the oldest —
        OOM protection."""
        from eden.llmops.ai_gateway import AIGateway

        g = AIGateway()
        # Push 10_001 entries.
        for i in range(10_001):
            g._metrics.append({"i": i})
        # Length is capped at 10_000.
        assert len(g._metrics) == 10_000
        # Oldest (i=0) was evicted; newest (i=10_000) is at the right.
        assert g._metrics[-1] == {"i": 10_000}
        assert g._metrics[0] == {"i": 1}


# ─── DL-13 + DL-15: BudgetService is the source of truth ──────────
class TestDl13Dl15BudgetServiceWired:
    """DL-13: the in-memory _tenant_budgets dict in AIGateway
    is a per-pod fast cache, not the source of truth. DL-15
    wires BudgetService.record_usage into complete() so the
    DB-backed spend stays in sync."""

    @pytest.mark.asyncio
    async def test_record_usage_called_on_successful_response(
        self,
    ) -> None:
        """A successful chat completion calls record_usage with
        the response cost_usd."""
        from eden.llmops.ai_gateway import (
            AIGateway,
            ModelRequest,
            ModelResponse,
            Provider,
        )

        gateway = AIGateway()
        # Register a provider so the circuit-breaker lookup
        # in complete() doesn't KeyError.
        gateway.register_provider(Provider.OPENAI, MagicMock())

        response = ModelResponse(
            text="hello",
            input_tokens=10,
            output_tokens=5,
            latency_ms=50,
            cost_usd=0.001,
            provider=Provider.OPENAI,
            model="gpt-4o-mini",
        )
        gateway._execute_provider = AsyncMock(return_value=response)
        gateway._select_provider = MagicMock(return_value=Provider.OPENAI)
        gateway._cache_response = AsyncMock()

        request = ModelRequest(
            tenant_id="org-budget-test",
            prompt="hi",
            model_family="openai",
            model_version="gpt-4o-mini",
            estimated_tokens=20,
        )

        with patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(return_value=True),
        ) as mock_record:
            await gateway.complete(request)

        mock_record.assert_awaited_once()
        call = mock_record.await_args
        assert call.args[0] == "org-budget-test"
        assert call.args[1] == 0.001

    @pytest.mark.asyncio
    async def test_record_usage_failure_does_not_break_response(
        self,
    ) -> None:
        """A DB blip on record_usage MUST NOT break the chat
        response. Budget writes are best-effort."""
        from eden.llmops.ai_gateway import (
            AIGateway,
            ModelRequest,
            ModelResponse,
            Provider,
        )

        gateway = AIGateway()
        gateway.register_provider(Provider.OPENAI, MagicMock())

        response = ModelResponse(
            text="hello",
            input_tokens=10,
            output_tokens=5,
            latency_ms=50,
            cost_usd=0.002,
            provider=Provider.OPENAI,
            model="gpt-4o-mini",
        )
        gateway._execute_provider = AsyncMock(return_value=response)
        gateway._select_provider = MagicMock(return_value=Provider.OPENAI)
        gateway._cache_response = AsyncMock()

        request = ModelRequest(
            tenant_id="org-budget-fail",
            prompt="hi",
            model_family="openai",
            model_version="gpt-4o-mini",
            estimated_tokens=20,
        )

        with patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(side_effect=RuntimeError("db down")),
        ):
            # MUST NOT raise.
            result = await gateway.complete(request)

        assert result.text == "hello"

    @pytest.mark.asyncio
    async def test_record_usage_not_called_for_zero_cost(
        self,
    ) -> None:
        """A response with cost_usd=0 (cache hit) does NOT
        call record_usage — no row to update, no noise."""
        from eden.llmops.ai_gateway import (
            AIGateway,
            ModelRequest,
            ModelResponse,
            Provider,
        )

        gateway = AIGateway()
        gateway.register_provider(Provider.OPENAI, MagicMock())

        response = ModelResponse(
            text="cached",
            input_tokens=0,
            output_tokens=0,
            latency_ms=1,
            cost_usd=0.0,
            provider=Provider.OPENAI,
            model="gpt-4o-mini",
            cached=True,
        )
        gateway._execute_provider = AsyncMock(return_value=response)
        gateway._select_provider = MagicMock(return_value=Provider.OPENAI)
        gateway._cache_response = AsyncMock()

        request = ModelRequest(
            tenant_id="org-cached",
            prompt="hi",
            model_family="openai",
            model_version="gpt-4o-mini",
            estimated_tokens=20,
        )

        with patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(),
        ) as mock_record:
            await gateway.complete(request)

        mock_record.assert_not_awaited()


# ─── DL-14: Quota middleware fail-closed + cache ──────────────────
class TestDl14QuotaFailClosed:
    """Pre-fix: a DB blip during hard-limit check logged a
    warning and let the request through (fail-open). For a
    free-tier cap, fail-open is the worst possible behaviour.
    Fix: fail closed on exception OR staleness > 60s; cache
    last known hard limit per org."""

    def test_staleness_limit_constant(self) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        assert mw._BUDGET_STALENESS_LIMIT_S == 60.0

    def test_record_hard_limits_caches_values(self) -> None:
        """A live budget response caches the hard_limit values
        per org so the fail-closed path has a recent fallback."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        mw._record_hard_limits(
            "org-1",
            {
                "cost_usd": {
                    "used": 5.0,
                    "soft_limit": 10.0,
                    "hard_limit": 20.0,
                    "status": "ok",
                    "percentage": 25.0,
                },
                "seats": {
                    "used": 2,
                    "soft_limit": 5,
                    "hard_limit": 10,
                    "status": "ok",
                },
            },
        )
        assert "org-1" in mw._last_known_hard_limits
        _ts, cached = mw._last_known_hard_limits["org-1"]
        assert cached["cost_usd"] == 20.0
        assert cached["seats"] == 10.0
        # references was absent — not cached.
        assert "references" not in cached

    def test_budget_staleness_returns_none_when_never_seen(self) -> None:
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        assert mw._budget_staleness("org-never-seen") is None

    def test_cached_block_check_fails_open_when_no_cache(self) -> None:
        """LP-10: missing snapshot must not 429 — fail-open so the
        live ``_check_hard_limits`` path can warm the cache."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        blocked, detail = mw._cached_block_check(
            "org-fresh",
            ["cost_usd"],
        )
        assert blocked is False
        assert detail == ""

    def test_cached_block_check_fails_open_when_stale(self) -> None:
        """LP-10: stale snapshot fails open (live check runs next)."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        mw._record_hard_limits(
            "org-stale",
            {"cost_usd": {"used": 100.0, "hard_limit": 50.0, "status": "hard_exceeded"}},
        )
        old_ts, cached = mw._last_known_hard_limits["org-stale"]
        mw._last_known_hard_limits["org-stale"] = (
            time.monotonic() - 120.0,
            cached,
        )
        blocked, detail = mw._cached_block_check(
            "org-stale",
            ["cost_usd"],
        )
        assert blocked is False
        assert detail == ""

    def test_cached_block_check_blocks_on_hard_breach(self) -> None:
        """A cached HARD breach still blocks, with the cap surfaced."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        mw._record_hard_limits(
            "org-cached",
            {
                "cost_usd": {
                    "used": 20.0,
                    "hard_limit": 20.0,
                    "status": "hard_exceeded",
                },
            },
        )
        blocked, detail = mw._cached_block_check(
            "org-cached",
            ["cost_usd"],
        )
        assert blocked is True
        assert "$20" in detail
        assert "fail-closed" in detail.lower()

    def test_soft_exceeded_does_not_block(self) -> None:
        """plan_tiers.py:71 — "Soft caps fire a warning header + UI
        banner but don't block; hard caps 429."

        These two tests previously asserted the opposite, encoding a
        real bug. cost_usd is in GLOBAL_MUTATING_RESOURCES, so this ran
        on EVERY POST/PUT/PATCH/DELETE on every path: the first customer
        to reach $2.00 against a $3.00 cap lost all write operations
        across the whole product — and the 429 told them the $3.00 cap
        had been reached while they were at two thirds of it.
        """
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        mw._record_hard_limits(
            "org-soft",
            {
                "cost_usd": {
                    "used": 15.0,
                    "hard_limit": 20.0,
                    "status": "soft_exceeded",
                },
            },
        )
        blocked, _ = mw._cached_block_check("org-soft", ["cost_usd"])
        assert blocked is False, (
            "a soft cap must warn, not 429 every mutating request"
        )

    def test_high_utilisation_does_not_block(self) -> None:
        """80% of a cap is not a breach.

        The removed branch blocked whenever used/hard >= 0.8 even when
        the live status was "ok".
        """
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        mw._record_hard_limits(
            "org-high",
            {"cost_usd": {"used": 16.0, "hard_limit": 20.0, "status": "ok"}},
        )
        blocked, _ = mw._cached_block_check("org-high", ["cost_usd"])
        assert blocked is False, "80% of the cap must not 429"

    def test_cached_block_check_uses_cached_seats(self) -> None:
        """Seats at or over the hard limit still block."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        mw = QuotaEnforcementMiddleware(MagicMock())
        mw._record_hard_limits(
            "org-seats",
            {
                "seats": {"used": 10, "hard_limit": 10},
            },
        )
        blocked, detail = mw._cached_block_check(
            "org-seats",
            ["seats"],
        )
        assert blocked is True
        assert "seats" in detail.lower()

    @pytest.mark.asyncio
    async def test_dispatch_fails_closed_on_check_exception(
        self,
    ) -> None:
        """End-to-end: when _check_hard_limits raises, the
        middleware returns 429 (fail-closed) — NOT a 500 and
        NOT a free pass through."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        # The conftest's ``patch_settings`` fixture flips
        # ``quota_enabled`` to False so observability / onboarding
        # suites can exercise mutating routes without seeding
        # org_resource_limits. The fail-closed tests need the
        # enforcement ON so the ``quota_enabled`` short-circuit at
        # the top of dispatch is skipped — patch the source
        # ``eden.config.get_settings`` for the entire test so the
        # middleware reads the enabled settings at dispatch time.
        with patch(
            "eden.config.get_settings",
            return_value=_quota_enabled_settings(),
        ):
            mw = QuotaEnforcementMiddleware(MagicMock())

            # Stub _resolve_org_id to return a fixed org.
            mw._resolve_org_id = AsyncMock(return_value="org-x")  # type: ignore[method-assign]
            # Stub _build_quota_headers (returns empty dict).
            mw._build_quota_headers = AsyncMock(return_value={})  # type: ignore[method-assign]
            # _check_hard_limits raises (DB blip).
            mw._check_hard_limits = AsyncMock(  # type: ignore[method-assign]
                side_effect=RuntimeError("postgres unreachable"),
            )
            # Cache has a recent credits breach so GLOBAL fail-closed fires.
            mw._record_hard_limits(
                "org-x",
                {
                    "credits": {
                        "used": 400.0,
                        "hard_limit": 400.0,
                        "status": "hard_exceeded",
                    },
                },
            )

            async def inner(scope, receive, send):
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"", "more_body": False})

            mw.app = inner

            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.0"},
                "method": "POST",
                "path": "/some/mutating/path",
                "raw_path": b"/some/mutating/path",
                "headers": [],
                "query_string": b"",
            }
            sent: list = []

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(msg):
                sent.append(msg)

            await mw(scope, receive, send)

            # 429 fail-closed — inner app was NOT invoked.
            starts = [m for m in sent if m["type"] == "http.response.start"]
            assert starts and starts[0]["status"] == 429

    @pytest.mark.asyncio
    async def test_dispatch_fails_open_on_stale_budget_then_live_ok(
        self,
    ) -> None:
        """LP-10: stale cache must not 429 — live check proceeds."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        with patch(
            "eden.config.get_settings",
            return_value=_quota_enabled_settings(),
        ):
            inner_called = {"n": 0}

            async def inner(scope, receive, send):
                inner_called["n"] += 1
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b"", "more_body": False})

            mw = QuotaEnforcementMiddleware(inner)
            mw._resolve_org_id = AsyncMock(return_value="org-stale")  # type: ignore[method-assign]
            mw._build_quota_headers = AsyncMock(return_value={})  # type: ignore[method-assign]
            # Live check returns ok (under cap).
            mw._check_hard_limits = AsyncMock(  # type: ignore[method-assign]
                return_value=(False, ""),
            )
            mw._record_hard_limits(
                "org-stale",
                {"cost_usd": {"used": 0, "hard_limit": 50.0}},
            )
            old_ts, cached = mw._last_known_hard_limits["org-stale"]
            mw._last_known_hard_limits["org-stale"] = (
                time.monotonic() - 120.0,
                cached,
            )

            scope = {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.0"},
                "method": "POST",
                "path": "/some/path",
                "raw_path": b"/some/path",
                "headers": [],
                "query_string": b"",
            }
            sent: list = []

            async def receive():
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(msg):
                sent.append(msg)

            await mw(scope, receive, send)

            assert inner_called["n"] == 1
            mw._check_hard_limits.assert_awaited()
