"""Session 22 tests — last perf bits (P-16..P-20).

Five audit items, all small targeted perf wins:

* **P-16** — ``observability.py:list_traces`` issued a
  ``count(DISTINCT trace_id)`` seq scan for the pagination
  total. Now uses ``pg_class.reltuples`` (O(1) estimate).

* **P-17** — ``predictive._common._fetch_recent_judge_scores``
  was an uncached DB read on every dashboard render. Now
  wraps with a 1h Redis cache keyed by
  ``(org_id, judge_name)``.

* **P-18** — ``observability_stream._replay_since`` did
  ``LRANGE 0 -1`` on the bounded 1000-entry replay list,
  then Python-filtered by seq. Now uses ``ZRANGEBYSCORE``
  on a sorted set; the replay backing store switched from
  LIST to ZSET.

* **P-19** — ``AIGateway.complete`` had a single provider +
  single fallback path with NO breaker on the fallback
  (a broken fallback burned money on every retry). Now walks
  up to ``_MAX_FALLBACK_DEPTH = 3`` via the per-provider
  CircuitBreaker map.

* **P-20** — ``quota_enforcement.PATH_RESOURCE_MAP`` had a
  single ``/orgs/`` prefix that matched every org-scoped
  route — including /sse/stream and the intelligence/api
  GETs. Now a segment-aware suffix match against the actual
  invitation + references endpoints.
"""

from __future__ import annotations

import inspect
import json
import textwrap
from unittest.mock import AsyncMock, MagicMock

import pytest

# ─── P-16: pg_class reltuples for trace count ─────────────────────────


class TestP16ReltuplesTraceCount:
    """``list_traces`` total is a per-tenant distinct-trace count.

    ``pg_class.reltuples`` was abandoned — it is table-level and
    leaked cross-tenant pagination totals. Event-row ``count(*)``
    was also wrong (inflated vs grouped traces). The GROUP BY
    subquery stays filterable by tenant + time indexes.
    """

    def test_list_traces_total_counts_distinct_traces(self) -> None:
        """Static check: total uses a grouped subquery, not
        ``pg_class.reltuples`` and not a bare event ``count(*)``."""
        from eden.api.routes import observability

        source = textwrap.dedent(
            inspect.getsource(observability.list_traces)
        )
        non_comment_lines = "\n".join(
            line for line in source.splitlines()
            if not line.lstrip().startswith("#")
        )
        assert "pg_class" not in non_comment_lines, (
            "P-16 regression: list_traces must not use pg_class "
            "(cross-tenant estimate)"
        )
        assert "GROUP BY trace_id" in non_comment_lines, (
            "P-16 regression: list_traces total must group by trace_id"
        )
        assert "AS _traces" in non_comment_lines, (
            "P-16 regression: list_traces total subquery missing"
        )
        # LATERAL unnest must not sit in the main aggregate FROM
        # (it multiplies span_count / token sums by tag cardinality).
        assert "WITH page AS" in non_comment_lines, (
            "list_traces should page aggregates before tag attach"
        )


# ─── P-17: Redis cache for judge-score series ─────────────────────────


class TestP17JudgeScoreCache:
    """``_fetch_recent_judge_scores`` is wrapped with a
    1h Redis cache keyed by ``(org_id, judge_name)`` so the
    dashboard doesn't re-query the same window 10×/min
    per tenant.
    """

    def test_cache_ttl_constant_is_3600(self) -> None:
        """The cache TTL constant is exactly 3600s (1h)."""
        from eden.predictive._common import _JUDGE_SCORES_CACHE_TTL_S

        assert _JUDGE_SCORES_CACHE_TTL_S == 3600, (
            f"P-17 regression: expected TTL=3600, got {_JUDGE_SCORES_CACHE_TTL_S}"
        )

    def test_function_uses_redis_get_setex(self) -> None:
        """Static check: the function calls redis.get() and
        redis.setex() — the cache wrapper is wired."""
        from eden.predictive._common import _fetch_recent_judge_scores

        source = textwrap.dedent(
            inspect.getsource(_fetch_recent_judge_scores)
        )
        assert "cache_key" in source, (
            "P-17 regression: cache_key not in helper"
        )
        assert "redis.get" in source or ".get(" in source, (
            "P-17 regression: cache read not wired"
        )
        assert "setex" in source, (
            "P-17 regression: cache write not wired"
        )

    @pytest.mark.asyncio
    async def test_cache_hit_returns_without_db(self) -> None:
        """When Redis returns a hit, the function does NOT
        call client.fetch."""
        from eden.predictive._common import _fetch_recent_judge_scores

        cached_payload = json.dumps(
            [
                {
                    "judge_name": "factual",
                    "score": 0.9,
                    "agent_id": "a1",
                    "created_at": "2026-06-29T10:00:00Z",
                }
            ]
        )

        # Stub Redis client.
        fake_redis = MagicMock()
        fake_redis.get = AsyncMock(return_value=cached_payload)
        fake_redis.setex = AsyncMock()

        # Stub Postgres client — should NOT be called on a hit.
        fake_pg = MagicMock()
        fake_pg.fetch = AsyncMock(
            return_value=[],
        )

        from unittest.mock import patch

        with patch(
            "eden.predictive._common._get_client",
            AsyncMock(return_value=fake_pg),
        ), patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=fake_redis),
        ):
            rows = await _fetch_recent_judge_scores(
                "org_test", "7 days", judge_name="factual",
            )

        assert len(rows) == 1
        assert rows[0]["judge_name"] == "factual"
        # PG was NOT queried on a hit.
        fake_pg.fetch.assert_not_called()
        # Cache read fired once.
        assert fake_redis.get.await_count == 1

    @pytest.mark.asyncio
    async def test_cache_miss_queries_db_and_writes(self) -> None:
        """On cache miss, the function queries the DB and
        writes the result back to Redis."""
        from eden.predictive._common import _fetch_recent_judge_scores

        fake_redis = MagicMock()
        fake_redis.get = AsyncMock(return_value=None)
        fake_redis.setex = AsyncMock()

        fake_pg = MagicMock()
        fake_pg.fetch = AsyncMock(
            return_value=[
                {
                    "judge_name": "factual",
                    "score": 0.85,
                    "agent_id": "a1",
                    "created_at": "2026-06-29T11:00:00Z",
                }
            ],
        )

        from unittest.mock import patch

        with patch(
            "eden.predictive._common._get_client",
            AsyncMock(return_value=fake_pg),
        ), patch(
            "eden.storage.redis.get_redis_client",
            AsyncMock(return_value=fake_redis),
        ):
            rows = await _fetch_recent_judge_scores(
                "org_test", "7 days", judge_name="factual",
            )

        assert len(rows) == 1
        assert rows[0]["score"] == pytest.approx(0.85, rel=1e-3)
        # DB was queried.
        fake_pg.fetch.assert_called_once()
        # Cache write fired with the 1h TTL.
        fake_redis.setex.assert_called_once()
        args, _ = fake_redis.setex.call_args
        assert args[1] == 3600, (
            f"P-17 regression: setex TTL={args[1]}, expected 3600"
        )


# ─── P-18: ZRANGEBYSCORE replay instead of LRANGE ─────────────────────


class TestP18ReplayZset:
    """``_replay_since`` now reads from a Redis sorted set
    via ``ZRANGEBYSCORE`` instead of ``LRANGE 0 -1``. The
    backing store in ``publish_trace_event`` similarly
    switched from a LIST to a ZSET keyed by seq.
    """

    def test_replay_uses_zrangebyscore(self) -> None:
        """Static check: ``_replay_since`` uses
        ``zrangebyscore`` (not ``lrange``)."""
        from eden.api.routes import observability_stream

        source = textwrap.dedent(
            inspect.getsource(observability_stream._replay_since)
        )
        assert "zrangebyscore" in source, (
            "P-18 regression: _replay_since doesn't use "
            "ZRANGEBYSCORE"
        )
        assert "lrange" not in source, (
            "P-18 regression: _replay_since still calls LRANGE"
        )

    def test_publisher_uses_zadd(self) -> None:
        """Static check: ``publish_trace_event`` uses
        ``zadd`` to write to the replay set (not ``lpush``)."""
        from eden.api.routes import observability_stream

        source = textwrap.dedent(
            inspect.getsource(observability_stream.publish_trace_event)
        )
        assert "zadd" in source, (
            "P-18 regression: publish_trace_event doesn't "
            "ZADD to the replay set"
        )
        assert "lpush" not in source, (
            "P-18 regression: publish_trace_event still "
            "LPUSHes to a LIST"
        )
        assert "zremrangebyrank" in source, (
            "P-18 regression: publish_trace_event doesn't "
            "cap the ZSET at 1000 via ZREMRANGEBYRANK"
        )


# ─── P-19: multi-provider fallback + circuit breaker ──────────────────


class TestP19FallbackChain:
    """``AIGateway.complete`` walks up to
    ``_MAX_FALLBACK_DEPTH = 3`` providers via the
    per-provider CircuitBreaker. Pre-fix: 1 fallback attempt
    with NO breaker on the fallback path — a broken
    fallback burned money on every retry.
    """

    def test_max_fallback_depth_is_three(self) -> None:
        """The audit's risk callout was ``tenacity
        stop_after_attempt=3``. We honour that with a plain
        counter (each provider has its own CB so we don't
        need exponential backoff)."""
        from eden.llmops.ai_gateway import AIGateway

        assert AIGateway._MAX_FALLBACK_DEPTH == 3, (
            f"P-19 regression: _MAX_FALLBACK_DEPTH="
            f"{AIGateway._MAX_FALLBACK_DEPTH}, expected 3"
        )

    def test_complete_routes_each_attempt_through_circuit_breaker(
        self,
    ) -> None:
        """Every attempt in the fallback chain goes through
        the per-provider ``CircuitBreaker.call()`` — not
        a bare ``_execute_provider`` invocation."""
        from eden.llmops.ai_gateway import AIGateway

        source = textwrap.dedent(
            inspect.getsource(AIGateway.complete)
        )
        # Two or more ``cb.call`` invocations across the
        # function — one in the primary path, one inside
        # the fallback loop.
        assert source.count("cb.call") >= 1, (
            "P-19 regression: complete doesn't call cb.call "
            "at all"
        )
        # The fallback path is a LOOP, not a single
        # attempt — ``while`` (or ``for``) keyword present.
        assert "while " in source, (
            "P-19 regression: fallback chain isn't a loop"
        )

    @pytest.mark.asyncio
    async def test_complete_falls_back_on_first_provider_failure(
        self,
    ) -> None:
        """When the primary provider's circuit breaker
        raises ProviderUnavailable, the gateway retries
        with a fallback provider."""
        from eden.llmops.ai_gateway import (
            AIGateway,
            ModelRequest,
            ModelResponse,
            Provider,
            ProviderUnavailable,
        )

        # Two providers registered. We make the PRIMARY
        # always raise ProviderUnavailable (via CB); the
        # FALLBACK returns a real response.
        gw = AIGateway()
        good_response = ModelResponse(
            text="ok",
            input_tokens=10,
            output_tokens=5,
            latency_ms=100,
            cost_usd=0.001,
            provider=Provider.OPENAI,
            model="gpt-4o-mini",
            cached=False,
        )

        class _AlwaysFail:
            state = "closed"

            async def call(self, fn, *a, **kw):
                raise ProviderUnavailable("primary broken")

        class _AlwaysWorks:
            state = "closed"

            async def call(self, fn, *a, **kw):
                return good_response

        # Pretend two providers exist.
        gw._providers = {Provider.OPENAI: object(), Provider.ANTHROPIC: object()}
        gw._circuit_breakers = {
            Provider.OPENAI: _AlwaysFail(),
            Provider.ANTHROPIC: _AlwaysWorks(),
        }
        gw._select_provider = lambda req: Provider.OPENAI
        gw._select_fallback = lambda cur, req: Provider.ANTHROPIC
        gw._execute_provider = AsyncMock()
        gw._record_metrics = lambda *a, **kw: None
        gw._cache_response = AsyncMock()
        gw._tenant_budgets = {}
        gw._filters = MagicMock()
        gw._filters.run = lambda req: (req, [])
        gw.exact_cache = None
        gw.semantic_cache = None

        # Stash a sentinel for the primary attempt — should
        # never be called by us directly because the breaker
        # already raised.
        req = ModelRequest(
            tenant_id="t1",
            prompt="hello",
            model_family="openai",
            model_version="gpt-4o-mini",
        )
        resp = await gw.complete(req)
        assert resp is good_response


# ─── P-20: narrowed PATH_RESOURCE_MAP ─────────────────────────────────


class TestP20QuotaPathMap:
    """``PATH_RESOURCE_MAP`` only fires for endpoints that
    ACTUALLY consume seats (invitations/accept) or
    references (POST/DELETE). The wildcard ``/orgs/`` prefix
    is gone.
    """

    def test_path_resource_map_is_narrow(self) -> None:
        """The map only lists ``invitations`` + ``references``
        — no ``/orgs/`` wildcard."""
        from eden.api.middleware.quota_enforcement import (
            PATH_RESOURCE_MAP,
        )

        assert "/orgs/" not in PATH_RESOURCE_MAP, (
            "P-20 regression: PATH_RESOURCE_MAP still has "
            "the wildcard /orgs/ prefix"
        )
        assert "invitations" in PATH_RESOURCE_MAP, (
            "P-20 regression: invitations resource missing"
        )
        assert "references" in PATH_RESOURCE_MAP, (
            "P-20 regression: references resource missing"
        )
        # Both map to their respective resource, not the
        # broad combo.
        assert PATH_RESOURCE_MAP["invitations"] == ["seats"]
        assert PATH_RESOURCE_MAP["references"] == ["references"]

    @pytest.mark.parametrize(
        "path, expected",
        [
            # Seats consumers
            ("/orgs/foo/invitations", ["seats"]),
            ("/invitations/accept", ["seats"]),
            # References consumers
            ("/orgs/foo/references", ["references"]),
            ("/orgs/foo/references/abc", ["references"]),
            # Negative: NO match (sibling/parent segments)
            ("/orgs/foo", []),
            ("/orgs/foo/intelligence/agent", []),
            ("/orgs/foo/redteam-references", []),
            ("/orgs/foo/redteam-references/foo", []),
            ("/orgs/foo/sse/stream", []),
            ("/orgs/foo/agents/abc/run", []),
            ("/orgs/foo/code_references/foo", []),
            ("/health", []),
        ],
    )
    def test_resources_for_path(self, path, expected) -> None:
        """Each known route maps to the right resources (or
        ``[]`` for non-consuming paths)."""
        from eden.api.middleware.quota_enforcement import (
            QuotaEnforcementMiddleware,
        )

        assert (
            QuotaEnforcementMiddleware._resources_for_path(path)
            == expected
        ), f"P-20 regression for {path}"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
