"""Worker 6 — backend query / cache optimizations (behavior preservation)."""

from __future__ import annotations

import inspect
import textwrap
import time
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest


class TestUserIdCache:
    @pytest.mark.asyncio
    async def test_resolve_eden_user_id_caches_hit(self, monkeypatch):
        from eden.api import deps

        deps._user_id_cache.clear()
        client = MagicMock()
        client.fetchrow = AsyncMock(
            return_value={"id": "eden-user-1"},
        )
        monkeypatch.setattr(
            deps, "get_postgres_client", AsyncMock(return_value=client)
        )

        first = await deps.resolve_eden_user_id("clerk_user_abc")
        second = await deps.resolve_eden_user_id("clerk_user_abc")

        assert first == "eden-user-1"
        assert second == "eden-user-1"
        assert client.fetchrow.await_count == 1

    @pytest.mark.asyncio
    async def test_resolve_eden_user_id_does_not_cache_on_db_error(
        self, monkeypatch
    ):
        from eden.api import deps

        deps._user_id_cache.clear()
        client = MagicMock()
        client.fetchrow = AsyncMock(side_effect=RuntimeError("blip"))
        monkeypatch.setattr(
            deps, "get_postgres_client", AsyncMock(return_value=client)
        )

        assert await deps.resolve_eden_user_id("u-x") is None
        assert "u-x" not in deps._user_id_cache

    def test_cache_put_evicts_when_full(self):
        from eden.api import deps

        cache: dict[str, tuple[float, str | None]] = {}
        # Fill past max with already-expired entries so eviction is cheap.
        past = time.monotonic() - 10
        for i in range(deps._ID_CACHE_MAX):
            cache[f"k{i}"] = (past, f"v{i}")
        deps._cache_put(cache, "new", time.monotonic() + 60, "fresh")
        assert "new" in cache
        assert len(cache) <= deps._ID_CACHE_MAX


class TestListTracesQueryShape:
    def test_list_traces_uses_page_cte_not_lateral_main_from(self):
        from eden.api.routes import observability

        source = textwrap.dedent(inspect.getsource(observability.list_traces))
        non_comment = "\n".join(
            line for line in source.splitlines()
            if not line.lstrip().startswith("#")
        )
        assert "WITH page AS" in non_comment
        assert "AS _traces" in non_comment
        # Main aggregate must not multiply rows via LATERAL unnest.
        assert "FROM telemetry_events\n                LEFT JOIN LATERAL" not in non_comment

    @pytest.mark.asyncio
    async def test_list_traces_total_is_grouped_not_event_count(
        self, monkeypatch: pytest.MonkeyPatch,
    ):
        from eden.api.routes import observability

        fetch_sqls: list[str] = []
        fetchval_sqls: list[str] = []

        client = MagicMock()

        async def _fetch(sql: str, *args: Any) -> list[dict[str, Any]]:
            fetch_sqls.append(sql)
            return [
                {
                    "trace_id": "t1",
                    "started_at": datetime(2020, 1, 1, tzinfo=UTC),
                    "realm": "production",
                    "agent_id": "a1",
                    "model": None,
                    "provider": None,
                    "session_id": None,
                    "agent_session_id": None,
                    "outcome": "ok",
                    "error": None,
                    "input_tokens": 1,
                    "output_tokens": 2,
                    "cost_usd": 0.01,
                    "span_count": 3,
                    "duration_ms": 10.0,
                    "tags": ["x"],
                }
            ]

        async def _fetchval(sql: str, *args: Any) -> int:
            fetchval_sqls.append(sql)
            return 7

        client.fetch = _fetch
        client.fetchval = _fetchval

        import eden.storage.postgres as real_pg

        monkeypatch.setattr(
            real_pg, "get_postgres_client", AsyncMock(return_value=client)
        )

        result = await observability.list_traces(
            org_id="org-1",
            realm=None,
            outcome=None,
            agent_id=None,
            trace_id=None,
            trace_ids=None,
            limit=50,
            offset=0,
            days=7,
            user={"sub": "u"},
        )

        assert result.total == 7
        assert len(result.traces) == 1
        assert any("AS _traces" in s for s in fetchval_sqls)
        assert any("WITH page AS" in s for s in fetch_sqls)


class TestAgentsListParallel:
    def test_list_agents_uses_gather(self):
        from eden.api.routes import agents

        source = textwrap.dedent(inspect.getsource(agents.list_agents))
        assert "asyncio.gather" in source

    def test_register_agent_uses_returning(self):
        from eden.api.routes import agents

        source = textwrap.dedent(inspect.getsource(agents.register_agent))
        assert "RETURNING" in source
        # No follow-up SELECT after mutate.
        non_comment = "\n".join(
            line for line in source.splitlines()
            if not line.lstrip().startswith("#")
        )
        assert non_comment.count("SELECT agent_id, name") <= 1


class TestSearchTrgmFriendly:
    def test_insights_search_traces_bare_column_ilike(self):
        from eden.llmops import insights_tools

        source = textwrap.dedent(inspect.getsource(insights_tools.search_traces))
        non_comment = "\n".join(
            line for line in source.splitlines()
            if not line.lstrip().startswith("#")
        )
        assert "name ILIKE $3" in non_comment
        assert "agent_id ILIKE $3" in non_comment
        assert "COALESCE(agent_id" not in non_comment
        assert "attributes->>'agent_id'" not in non_comment

    def test_list_jobs_q_uses_trgm_predicates(self):
        from eden.storage.postgres import PostgresClient

        source = textwrap.dedent(inspect.getsource(PostgresClient.list_jobs))
        assert "job_id ILIKE" in source
        assert "request::text ILIKE" in source
