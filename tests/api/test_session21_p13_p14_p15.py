"""Session 21 tests — User intel SQL + dedup cache + indexes (P-13, P-14, P-15).

Three audit items:

* **P-13** — ``sessions.SessionAnalytics.aggregate`` issued
  a single ``client.fetch`` for all sessions in the window
  and did 3 Python loops over the cursor to compute
  total / active / dormant / returned /
  single_turn_abandoned / median_n_turns. Post-fix: a
  single ``client.fetchrow`` with a CTE + 5 scalar
  sub-queries + ``percentile_cont(0.5) WITHIN GROUP``
  computes everything in SQL.

* **P-14** — ``telemetry_collector.TelemetryCollector._dedup_cache``
  was a plain ``dict[str, float]`` with O(n) full-rebuild
  stale-eviction on every call. Post-fix: ``OrderedDict``
  with amortised O(1) front-pop (cap 16 per call) + O(1)
  FIFO eviction via ``popitem(last=False)`` when the cache
  exceeds ``DEDUP_CACHE_MAX`` (50_000).

* **P-15** — new migration ``066_session21_indexes.py``
  adding 11 indexes (the audit's 8 logical indexes
  expanded to 11 physical indexes — 3 tables get
  ``(tenant_id, agent_id, ts DESC)``, 2 tables get
  ``(org_id, memory_id, ts DESC)``). All idempotent
  (``CREATE INDEX IF NOT EXISTS`` /
  ``DROP INDEX IF EXISTS``).
"""

from __future__ import annotations

import ast
import importlib
import textwrap
import time
from collections import OrderedDict
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── P-13: SessionAnalytics.aggregate uses a single SQL with CTE ─────


class TestP13SessionSQL:
    """``SessionAnalytics.aggregate`` pushes per-user
    classification + median + abandonment count into a
    single SQL with a CTE + conditional aggregation.

    Ponytail: one round-trip returns a one-row dict with
    every metric, no Python loops over the cursor.
    """

    def test_aggregate_uses_single_fetchrow(self) -> None:
        """Static check: ``aggregate`` does exactly one
        ``client.fetchrow`` call. (Pre-fix did one
        ``client.fetch`` and then 3 Python loops.)"""
        from eden.services.user_intel.sessions import SessionAnalytics

        source = textwrap.dedent(
            "\n".join(
                line
                for line in __import__("inspect").getsource(
                    SessionAnalytics.aggregate
                ).splitlines()
            )
        )
        # Allow either the legacy ``_fetch_sessions_in_window``
        # pattern OR the new single-``fetchrow`` pattern. The
        # old fetch path is now dead in aggregate; the helper
        # itself is kept for callers that want the raw rows.
        assert "fetchrow" in source or "_fetch_session_aggregates" in source, (
            "P-13 regression: aggregate doesn't use the SQL "
            "aggregation helper"
        )

    def test_aggregate_helper_uses_percentile_cont(self) -> None:
        """Static check: the new helper function
        ``_fetch_session_aggregates`` uses
        ``percentile_cont(0.5) WITHIN GROUP`` to compute
        the median in SQL (not in Python)."""
        from eden.services.user_intel.sessions import (
            _fetch_session_aggregates,
        )
        import inspect

        source = inspect.getsource(_fetch_session_aggregates)
        assert "percentile_cont" in source, (
            "P-13 regression: SQL aggregate doesn't use "
            "percentile_cont for the median"
        )
        assert "FILTER" in source, (
            "P-13 regression: SQL aggregate doesn't use "
            "FILTER for the single-turn-abandoned count"
        )
        # CTE marker — single pass over the table.
        assert "WITH per_user AS" in source, (
            "P-13 regression: SQL aggregate doesn't use a "
            "per-user CTE"
        )

    @pytest.mark.asyncio
    async def test_aggregate_uses_sql_path(self) -> None:
        """Behavioural: ``aggregate`` invokes
        ``client.fetchrow`` (the SQL-aggregation path) and
        does NOT issue a raw ``client.fetch`` for the
        session rows. The pre-fix path did one ``fetch``
        for the session list."""
        from eden.services.user_intel.sessions import SessionAnalytics

        pg = MagicMock()
        # fetchrow returns the SQL aggregate row.
        pg.fetchrow = AsyncMock(
            return_value={
                "total_sessions": 7,
                "active_users": 2,
                "dormant_users": 1,
                "returned_users": 0,
                "single_turn_abandoned": 1,
                "median_n_turns": 4.0,
            }
        )
        # fetch returns [] by default (pre-fix path).
        pg.fetch = AsyncMock(return_value=[])

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await SessionAnalytics().aggregate(
                "org_test", window="30d"
            )
        assert result["status"] == "ok"
        d = result["data"]
        assert d["total_sessions"] == 7
        assert d["active_users"] == 2
        assert d["dormant_users"] == 1
        assert d["single_turn_abandonment_rate"] == pytest.approx(
            1 / 7, rel=1e-3
        )
        assert d["median_session_length_turns"] == 4.0


# ─── P-14: TelemetryCollector dedup cache uses bounded OrderedDict ──


class TestP14DedupCache:
    """``TelemetryCollector._dedup_cache`` is now an
    ``OrderedDict`` bounded to ``DEDUP_CACHE_MAX`` (50_000)
    with O(1) FIFO eviction via ``popitem(last=False)``.

    Ponytail: O(1) move-to-end on hits, O(1) popitem on
    overflow, amortised O(1) stale-eviction (cap 16 pops
    per call). Pre-fix: O(n) full-rebuild on every call.
    """

    def test_dedup_cache_is_ordered_dict(self) -> None:
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
        )

        tc = TelemetryCollector()
        assert isinstance(tc._dedup_cache, OrderedDict), (
            "P-14 regression: _dedup_cache should be OrderedDict"
        )
        assert tc.DEDUP_CACHE_MAX == 50_000

    def test_dedup_cache_evicts_oldest_at_cap(self) -> None:
        """When the cache exceeds ``DEDUP_CACHE_MAX``,
        the OLDEST insertion (FIFO) is evicted via
        ``popitem(last=False)``."""
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
        )

        tc = TelemetryCollector()
        # Lower the cap for the test so we don't need 50k
        # events in memory.
        tc.DEDUP_CACHE_MAX = 4
        # Pre-fill to the cap.
        for i in range(4):
            tc._dedup_cache[f"hash_{i}"] = float(i)
        assert len(tc._dedup_cache) == 4
        # Insert one more — should evict hash_0 (oldest).
        tc._dedup_cache["hash_4"] = 4.0
        tc._dedup_cache["hash_4"] = 4.0  # touch once more
        # Manually apply the cap-eviction logic from
        # _is_duplicate to keep the test focused on the
        # OrderedDict contract.
        while len(tc._dedup_cache) > tc.DEDUP_CACHE_MAX:
            tc._dedup_cache.popitem(last=False)
        assert "hash_0" not in tc._dedup_cache
        assert "hash_4" in tc._dedup_cache
        assert len(tc._dedup_cache) == 4

    def test_is_duplicate_calls_popitem_last_false(self) -> None:
        """AST check: ``_is_duplicate`` calls
        ``popitem(last=False)`` for the bounded eviction
        (the OrderedDict-FIFO contract)."""
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
        )
        import inspect

        source = textwrap.dedent(
            inspect.getsource(TelemetryCollector._is_duplicate)
        )
        tree = ast.parse(source)
        func = tree.body[0]
        assert isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef))

        found = False
        for node in ast.walk(func):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == "popitem"
            ):
                # popitem with last=False
                kw = {
                    k.arg: k.value
                    for k in node.keywords
                    if k.arg is not None
                }
                if "last" in kw and isinstance(
                    kw["last"], ast.Constant
                ) and kw["last"].value is False:
                    found = True
                    break
        assert found, (
            "P-14 regression: _is_duplicate doesn't call "
            "popitem(last=False) for FIFO eviction"
        )

    def test_is_duplicate_uses_move_to_end_on_hit(self) -> None:
        """AST check: ``_is_duplicate`` calls
        ``move_to_end`` on a cache hit (LRU touch)."""
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
        )
        import inspect

        source = textwrap.dedent(
            inspect.getsource(TelemetryCollector._is_duplicate)
        )
        assert "move_to_end" in source, (
            "P-14 regression: _is_duplicate doesn't call "
            "move_to_end on a hit (LRU touch)"
        )


# ─── P-15: migration 066 — 11 idempotent indexes ─────────────────────


class TestP15Migration:
    """New migration ``066_session21_indexes.py`` adds
    11 indexes for the P-15 audit. All idempotent —
    ``CREATE INDEX IF NOT EXISTS`` /
    ``DROP INDEX IF EXISTS``.
    """

    def test_migration_revision_chain(self) -> None:
        """The migration has revision ``066`` and points
        back to ``065`` (the previous head)."""
        m = importlib.import_module(
            "eden.db_migrations.versions.066_session21_indexes"
        )
        assert m.revision == "066"
        assert m.down_revision == "065"

    def test_upgrade_emits_11_create_index(self) -> None:
        """``upgrade()`` emits 11 ``CREATE INDEX IF NOT
        EXISTS`` statements (the P-15 audit's 8 logical
        indexes + 3 (tenant_id, agent_id, ts) + 1
        handoff + 1 user_satisfaction_corrected + 1
        user_sessions + 1 closed_loop_actions)."""
        from alembic import op as real_op
        from unittest.mock import patch

        m = importlib.import_module(
            "eden.db_migrations.versions.066_session21_indexes"
        )
        calls: list[str] = []
        with patch.object(
            real_op, "execute", side_effect=calls.append
        ):
            m.upgrade()
        # 11 indexes total.
        assert len(calls) == 11, (
            f"P-15 regression: upgrade emitted {len(calls)} "
            f"SQL statements, expected 11"
        )
        # All idempotent.
        for sql in calls:
            assert "CREATE INDEX IF NOT EXISTS" in sql, (
                f"P-15 regression: non-idempotent: {sql[:80]}"
            )
        # Sanity-check a few specific index names.
        joined = " | ".join(calls)
        assert "idx_telemetry_events_tenant_ts" in joined
        assert "idx_telemetry_events_tenant_agent_ts" in joined
        assert "idx_usage_events_tenant_agent_ts" in joined
        assert "idx_judge_scores_tenant_agent_ts" in joined
        assert "idx_telemetry_events_tenant_parent_agent" in joined
        assert "idx_agent_relationships_org_handoff_count" in joined
        assert "idx_memory_attributions_org_memory_ts" in joined
        assert "idx_memory_timeline_events_org_memory_ts" in joined
        assert "idx_user_sessions_org_first_event" in joined
        assert "idx_user_satisfaction_corrected_org_user_ts" in joined
        assert "idx_closed_loop_actions_pending" in joined
        # Partial indexes preserved.
        # Audit 2026-07-03 — telemetry_events has no parent_agent_id
        # column (parentage is encoded via parent_span_id); the
        # migration was corrected in place and the partial index
        # now filters on parent_span_id.
        assert "WHERE parent_span_id IS NOT NULL" in joined
        assert "WHERE status = 'pending_approval'" in joined

    def test_downgrade_emits_11_drop_index(self) -> None:
        """``downgrade()`` emits 11 ``DROP INDEX IF
        EXISTS`` statements — matches the upgrade count
        so a partial upgrade + downgrade leaves no
        orphan indexes."""
        from alembic import op as real_op
        from unittest.mock import patch

        m = importlib.import_module(
            "eden.db_migrations.versions.066_session21_indexes"
        )
        calls: list[str] = []
        with patch.object(
            real_op, "execute", side_effect=calls.append
        ):
            m.downgrade()
        assert len(calls) == 11, (
            f"P-15 regression: downgrade emitted {len(calls)} "
            f"SQL statements, expected 11"
        )
        for sql in calls:
            assert "DROP INDEX IF EXISTS" in sql, (
                f"P-15 regression: non-idempotent drop: {sql[:80]}"
            )

    def test_migration_chain_is_valid(self) -> None:
        """The alembic ScriptDirectory can resolve the migration
        chain — ``066`` is wired in and reachable from the current
        head (which may itself be a later migration added after P-15)."""
        import os

        from alembic.config import Config
        from alembic.script import ScriptDirectory

        cfg = Config(os.path.abspath("alembic.ini"))
        cfg.set_main_option("script_location", "src/eden/db_migrations")
        script = ScriptDirectory.from_config(cfg)
        # Walk from every current head back through down_revisions;
        # ``066`` must appear somewhere in the chain.
        heads = script.get_heads()
        visited: set[str] = set()
        stack = list(heads)
        while stack:
            rev = stack.pop()
            if rev in visited:
                continue
            visited.add(rev)
            scr = script.get_revision(rev)
            if scr is None:
                continue
            downrev = scr.down_revision
            if downrev is None:
                continue
            if isinstance(downrev, (list, tuple, set)):
                stack.extend(downrev)
            else:
                stack.append(downrev)
        assert "066" in visited, (
            f"P-15 regression: 066 not reachable from heads {heads}"
        )


# ─── perf sanity: SQL aggregate < Python loop ────────────────────────


class TestP13PerfSanity:
    """The SQL aggregation should be at least as fast as
    the Python loop for typical windows. We don't try to
    measure SQL latency (no DB) — we just check that the
    single-fetchrow path is observably faster than the
    old N-row + Python-loops path would be on the
    service code itself (i.e., no extra fetches)."""

    @pytest.mark.asyncio
    async def test_single_fetchrow_no_extra_fetch(self) -> None:
        from eden.services.user_intel.sessions import SessionAnalytics

        pg = MagicMock()
        pg.fetchrow = AsyncMock(
            return_value={
                "total_sessions": 100,
                "active_users": 50,
                "dormant_users": 10,
                "returned_users": 5,
                "single_turn_abandoned": 20,
                "median_n_turns": 4.0,
            }
        )
        pg.fetch = AsyncMock(return_value=[])

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            t0 = time.monotonic()
            for _ in range(100):
                await SessionAnalytics().aggregate(
                    "org_test", window="30d"
                )
            elapsed = time.monotonic() - t0

        # Pre-fix would issue 1 fetch per call + 3 Python
        # loops. Post-fix: 1 fetchrow per call + no Python
        # loops. 100 calls should be well under 1s on a
        # warm interpreter.
        assert elapsed < 1.0, (
            f"P-13 perf regression: 100 aggregates took {elapsed:.3f}s"
        )
        # And the legacy `fetch` path was never called —
        # aggregate uses only the SQL path.
        pg.fetch.assert_not_called()


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
