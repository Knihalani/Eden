"""Cross-tenant isolation tests (S-11, S-12, S-13).

Three related fixes from the per-session fix-everything plan:

* **S-11** — ``eden.debugger.checkpoints`` no longer hardcodes
  ``tenant_id="org-stub"``; the tenant is taken from the auth
  context (the caller passes ``org_id``). Verified by reading the
  current code; no new behaviour to test.

* **S-12** — ``eden.kb.strategy_store`` queries all filter by
  ``org_id`` so one tenant's strategy rows cannot leak. The pre-fix
  code scoped by ``collection`` only and silently logged a warning
  when ``org_id`` was omitted. Post-fix: org_id is REQUIRED and the
  SQL actually filters by it.

* **S-13** — ``eden.data_platform.lineage`` exposes four
  read methods (``get_upstream``, ``get_downstream``,
  ``get_lineage_for_job``, ``export_openlineage``). All four now
  take ``org_id`` as a required parameter and filter by it in SQL.

These tests are pure-Python: they capture every SQL string the
service sends to Postgres and assert (a) the bound org_id parameter
matches the caller's value, and (b) the WHERE clause text contains
an ``org_id`` predicate. They run against the conftest's
``patch_postgres`` mock so we never touch real DB.
"""

from __future__ import annotations

from datetime import UTC
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest


# ─── S-12: KB strategy_store isolation ──────────────────────────────
class TestS12StrategyStoreOrgFilter:
    @pytest.fixture
    def store(self, mock_postgres_client, patch_postgres):
        from eden.kb.strategy_store import RetrievalStrategyStore

        return RetrievalStrategyStore()

    @pytest.mark.asyncio
    async def test_get_strategy_filters_by_org_id(self, store, mock_postgres_client) -> None:
        mock_postgres_client.fetchrow = AsyncMock(return_value=None)
        mock_postgres_client.execute = AsyncMock(return_value="INSERT")

        await store.get_strategy("my-coll", org_id="org-A")

        # The fetchrow SELECT must include ``org_id`` in WHERE.
        select_query = mock_postgres_client.fetchrow.call_args.args[0]
        assert "org_id" in select_query
        assert "WHERE collection" in select_query
        # The bound param is (collection, org_id).
        bound = mock_postgres_client.fetchrow.call_args.args[1:]
        assert bound == ("my-coll", "org-A")

    @pytest.mark.asyncio
    async def test_update_strategy_filters_by_org_id(self, store, mock_postgres_client) -> None:
        mock_postgres_client.execute = AsyncMock(return_value="UPDATE 1")

        await store.update_strategy(
            "my-coll",
            {"score_threshold": 0.5},
            org_id="org-A",
        )

        update_query = mock_postgres_client.execute.call_args.args[0]
        assert "org_id" in update_query
        assert "WHERE collection" in update_query
        # The bound params end with (collection, org_id).
        bound = mock_postgres_client.execute.call_args.args[1:]
        assert bound[-2:] == ("my-coll", "org-A")

    @pytest.mark.asyncio
    async def test_record_relevant_filters_by_org_id(self, store, mock_postgres_client) -> None:
        mock_postgres_client.execute = AsyncMock(return_value="UPDATE 1")

        await store.record_relevance("my-coll", True, org_id="org-A")

        update_query = mock_postgres_client.execute.call_args.args[0]
        assert "org_id" in update_query
        assert "WHERE collection" in update_query
        bound = mock_postgres_client.execute.call_args.args[1:]
        assert bound == ("my-coll", "org-A")

    @pytest.mark.asyncio
    async def test_record_irrelevant_filters_by_org_id(self, store, mock_postgres_client) -> None:
        mock_postgres_client.execute = AsyncMock(return_value="UPDATE 1")

        await store.record_relevance("my-coll", False, org_id="org-A")

        update_query = mock_postgres_client.execute.call_args.args[0]
        assert "org_id" in update_query
        bound = mock_postgres_client.execute.call_args.args[1:]
        assert bound == ("my-coll", "org-A")

    @pytest.mark.asyncio
    async def test_get_all_strategies_filters_by_org_id(self, store, mock_postgres_client) -> None:
        mock_postgres_client.fetch = AsyncMock(return_value=[])

        await store.get_all_strategies(org_id="org-A")

        select_query = mock_postgres_client.fetch.call_args.args[0]
        assert "org_id" in select_query
        assert mock_postgres_client.fetch.call_args.args[1] == "org-A"

    @pytest.mark.asyncio
    async def test_missing_org_id_raises(self, store, mock_postgres_client) -> None:
        # S-12 fix: the audit intent is that the SQL actually filters
        # by org_id, which is impossible without one. Hard-require it.
        with pytest.raises(ValueError, match="org_id"):
            await store.get_strategy("coll", org_id="")
        with pytest.raises(ValueError, match="org_id"):
            await store.get_strategy("coll", org_id=None)  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="org_id"):
            await store.update_strategy("coll", {"x": 1}, org_id="")
        with pytest.raises(ValueError, match="org_id"):
            await store.record_relevance("coll", True, org_id="")
        with pytest.raises(ValueError, match="org_id"):
            await store.get_all_strategies(org_id="")


# ─── S-13: lineage tracker isolation ───────────────────────────────
class TestS13LineageOrgFilter:
    @pytest.fixture
    def tracker(self):
        from eden.data_platform.lineage import LineageTracker

        return LineageTracker()

    @pytest.mark.asyncio
    async def test_get_upstream_filters_by_org_id(self, tracker, mock_postgres_client) -> None:
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        await tracker.get_upstream("dataset-x", org_id="org-A")

        query = mock_postgres_client.fetch.call_args.args[0]
        assert "org_id" in query
        # The org_id is the LAST bound parameter (after pattern + limit).
        bound = mock_postgres_client.fetch.call_args.args[1:]
        assert "org-A" in bound

    @pytest.mark.asyncio
    async def test_get_downstream_filters_by_org_id(self, tracker, mock_postgres_client) -> None:
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        await tracker.get_downstream("dataset-x", org_id="org-A")

        query = mock_postgres_client.fetch.call_args.args[0]
        assert "org_id" in query
        assert "org-A" in mock_postgres_client.fetch.call_args.args[1:]

    @pytest.mark.asyncio
    async def test_get_lineage_for_job_filters_by_org_id(self, tracker, mock_postgres_client) -> None:
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        await tracker.get_lineage_for_job("job-1", org_id="org-A")

        query = mock_postgres_client.fetch.call_args.args[0]
        assert "org_id" in query
        assert "org-A" in mock_postgres_client.fetch.call_args.args[1:]

    @pytest.mark.asyncio
    async def test_export_openlineage_no_since_filters_by_org_id(self, tracker, mock_postgres_client) -> None:
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        await tracker.export_openlineage(org_id="org-A", limit=50)

        query = mock_postgres_client.fetch.call_args.args[0]
        assert "org_id" in query
        assert "org-A" in mock_postgres_client.fetch.call_args.args[1:]

    @pytest.mark.asyncio
    async def test_export_openlineage_with_since_filters_by_org_id(self, tracker, mock_postgres_client) -> None:
        from datetime import datetime, timezone
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        await tracker.export_openlineage(
            org_id="org-A",
            since=datetime(2026, 1, 1, tzinfo=UTC),
            limit=50,
        )

        query = mock_postgres_client.fetch.call_args.args[0]
        assert "org_id" in query
        assert "org-A" in mock_postgres_client.fetch.call_args.args[1:]

    @pytest.mark.asyncio
    async def test_all_four_methods_require_org_id(self, tracker, mock_postgres_client) -> None:
        """S-13 fix: missing org_id raises — the audit's intent is that
        SQL actually filters by it.
        """
        from datetime import datetime, timezone
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        with pytest.raises(ValueError, match="org_id"):
            await tracker.get_upstream("ds", org_id="")
        with pytest.raises(ValueError, match="org_id"):
            await tracker.get_downstream("ds", org_id="")
        with pytest.raises(ValueError, match="org_id"):
            await tracker.get_lineage_for_job("job", org_id="")
        with pytest.raises(ValueError, match="org_id"):
            await tracker.export_openlineage(org_id="")
        # The mock wasn't called at all — guard fires before SQL.
        assert mock_postgres_client.fetch.call_count == 0

    @pytest.mark.asyncio
    async def test_two_orgs_get_different_org_id_in_where(self, tracker, mock_postgres_client) -> None:
        """Sanity check: org-A and org-B calls each bind their own
        org_id. A regression that hardcodes org_id="X" would fail
        this test on one of the two assertions.
        """
        mock_postgres_client.fetch = AsyncMock(return_value=[])
        await tracker.get_upstream("ds", org_id="org-A")
        await tracker.get_upstream("ds", org_id="org-B")

        first_call = mock_postgres_client.fetch.call_args_list[0]
        second_call = mock_postgres_client.fetch.call_args_list[1]
        assert "org-A" in first_call.args[1:]
        assert "org-B" in second_call.args[1:]


# ─── S-11: debugger checkpoints tenant (verified by inspection) ────
class TestS11DebuggerCheckpointTenant:
    """S-11 ships via the explicit fix comment at
    ``src/eden/debugger/checkpoints.py:157``. The new behaviour is
    ``tenant_id = org_id or "default"`` — no longer a hardcoded
    ``"org-stub"``. The function is internal; the integration test
    is the boot smoke test.
    """

    def test_no_org_stub_in_source(self) -> None:
        """The fix comment + module docstring reference "org-stub" to
        document the REMOVED behaviour — that's fine. We only check
        that no code still USES the literal as a tenant value.
        """
        import re
        from pathlib import Path

        src = Path("src/eden/debugger/checkpoints.py").read_text()
        # Strip docstrings + comments so we only look at code.
        code_only = re.sub(r'""".*?"""', "", src, flags=re.DOTALL)
        code_only = re.sub(r"#.*$", "", code_only, flags=re.MULTILINE)
        assert '"org-stub"' not in code_only, (
            "S-11 fix: org-stub must not appear as a string literal in "
            "checkpoints.py code (it's OK in comments / docstrings)."
        )

    def test_tenant_id_uses_org_id(self) -> None:
        """Static check: the line that sets ``tenant_id`` references
        ``org_id`` rather than a string literal.
        """
        from pathlib import Path

        src = Path("src/eden/debugger/checkpoints.py").read_text()
        # Look for ``tenant_id = org_id`` (or equivalent).
        assert "tenant_id = org_id" in src
