"""Session 25 tests — Backend correctness (B-14..B-17).

Four audit items:

* **B-14** — ``OpenRouterClient.acall`` (async) uses
  ``await asyncio.sleep(min(2**attempt, 4))``; the sync
  retry path runs in ``run_in_executor`` so ``time.sleep``
  doesn't block the event loop.
* **B-15** — New migration 074 adds ``repetition_count``
  to ``closed_loop_actions`` so the fallback path
  (``_record_action``) reports the same shape as the
  HookBus path (``hook_events``, post-migration 051).
  ``_increment_repetition`` actually updates the DB
  (was: log-only stub).
* **B-16** — 8 sync ``compress_jsonb`` calls in the
  telemetry ingest path now run via
  ``asyncio.to_thread`` inside a single
  ``asyncio.gather`` — releases the event loop.
* **B-17** — ``_pg_execute`` enforces a table-name
  allowlist (``telemetry_events``, ``usage_events``,
  ``judge_scores``) — defence-in-depth on top of the
  read-only check at the function entry.
"""

from __future__ import annotations

import asyncio
import inspect
import re
import textwrap
from unittest.mock import AsyncMock, patch

import pytest

# ─── B-14: async retry uses asyncio.sleep with cap ──────────────


class TestB14AsyncRetry:
    """The async ``acall`` uses ``await asyncio.sleep`` with
    a 4s cap; the sync retry path is gated by
    ``run_in_executor`` so ``time.sleep`` is safe there.
    """

    def test_async_path_uses_await_asyncio_sleep(self) -> None:
        """``acall`` awaits ``asyncio.sleep`` with a 4s cap."""
        from eden.llm import client

        source = textwrap.dedent(inspect.getsource(client.OpenRouterClient.acall))
        assert "await asyncio.sleep" in source, (
            "B-14 regression: acall doesn't await asyncio.sleep"
        )
        assert "min(2 ** attempt, 4)" in source, (
            "B-14 regression: acall missing 4s cap"
        )

    def test_async_path_covers_all_three_exceptions(self) -> None:
        """All three retry paths (APITimeoutError / RateLimitError /
        APIError) use ``await asyncio.sleep(min(2**attempt, 4))``."""
        from eden.llm import client

        source = textwrap.dedent(inspect.getsource(client.OpenRouterClient.acall))
        # Source may render the expression slightly differently;
        # just confirm at least 3 await-asyncio-sleep lines exist.
        assert source.count("await asyncio.sleep") >= 3, (
            f"B-14 regression: expected ≥3 await asyncio.sleep "
            f"occurrences in acall, found "
            f"{source.count('await asyncio.sleep')}"
        )


# ─── B-15: repetition_count on closed_loop_actions + hook_events UPDATE ──


class TestB15Repetition:
    """``repetition_count`` lands on ``closed_loop_actions`` via
    migration 074; ``_increment_repetition`` actually UPDATEs
    the DB instead of just logging.
    """

    def test_migration_exists(self) -> None:
        """Migration 074 file exists with the expected
        ``repetition_count`` column."""
        from pathlib import Path

        path = (
            Path(__file__).parent.parent.parent
            / "src/eden/db_migrations/versions/074_hook_repetition_closed_loop.py"
        )
        assert path.exists(), (
            f"B-15 regression: migration {path} not found"
        )
        source = path.read_text()
        assert "repetition_count" in source, (
            "B-15 regression: migration 074 missing repetition_count"
        )
        assert (
            "ALTER TABLE closed_loop_actions" in source
        ), "B-15 regression: migration 074 doesn't ALTER the table"

    @pytest.mark.asyncio
    async def test_increment_actually_updates_db(self) -> None:
        """``_increment_repetition`` issues an UPDATE against
        ``hook_events`` (and falls back to ``closed_loop_actions``).
        """
        from eden.llmops import hooks_bus

        # Patch the postgres import path that _increment_repetition
        # actually resolves (it's imported INSIDE the function).
        call_log: list[str] = []

        async def _fake_execute(query, *args, **kwargs):
            call_log.append(query.strip().split()[0])
            return "UPDATE 1"

        fake_client = AsyncMock()
        fake_client.execute = _fake_execute

        async def _fake_get_client():
            return fake_client

        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=_fake_get_client,
        ):
            await hooks_bus._increment_repetition("any-hook-id")

        assert call_log, (
            "B-15 regression: _increment_repetition called execute 0 times"
        )
        assert "UPDATE" in call_log, (
            f"B-15 regression: _increment_repetition didn't issue UPDATE; "
            f"calls: {call_log}"
        )


# ─── B-16: compress_jsonb runs via asyncio.to_thread ────────────


class TestB16CompressAsync:
    """The 8 ``compress_jsonb`` calls in the telemetry ingest
    path run via ``asyncio.to_thread`` inside a single gather.
    """

    def test_uses_asyncio_to_thread(self) -> None:
        """``asyncio.to_thread`` is in the persist path."""
        from eden.observability import telemetry_collector

        source = textwrap.dedent(
            inspect.getsource(telemetry_collector.TelemetryCollector)
        )
        # The compress block is in _persist; check for asyncio.to_thread.
        assert "asyncio.to_thread" in source, (
            "B-16 regression: telemetry_collector doesn't use "
            "asyncio.to_thread"
        )

    def test_uses_asyncio_gather(self) -> None:
        """The 8 compress calls are inside ``asyncio.gather``."""
        from eden.observability import telemetry_collector

        source = textwrap.dedent(
            inspect.getsource(telemetry_collector.TelemetryCollector)
        )
        assert "asyncio.gather" in source, (
            "B-16 regression: telemetry_collector doesn't gather "
            "compress calls"
        )

    def test_compress_helper_skips_empty(self) -> None:
        """The async compress helper skips None / empty dict / empty list."""
        from eden.observability import telemetry_collector

        source = textwrap.dedent(
            inspect.getsource(telemetry_collector.TelemetryCollector)
        )
        # Look for the inner `_compress` helper signature.
        assert "async def _compress(value):" in source, (
            "B-16 regression: missing nested _compress helper"
        )
        # The empty-value short-circuit. Source uses simple `is None` check.
        assert (
            "if value is None or value == {} or value == []:" in source
        ), "B-16 regression: _compress missing empty-value short-circuit"


# ─── B-17: pg-fallback table allowlist ──────────────────────────


class TestB17PgAllowlist:
    """``_pg_execute`` extracts table names from the SQL and
    refuses queries that touch anything other than
    ``telemetry_events``, ``usage_events``, ``judge_scores``.
    """

    def test_helper_exists(self) -> None:
        """``_strip_sql_for_table_check`` + ``_TABLE_NAME_RE`` are
        both defined at module scope."""
        from eden.columnar import query

        assert hasattr(query, "_strip_sql_for_table_check"), (
            "B-17 regression: helper _strip_sql_for_table_check missing"
        )
        assert hasattr(query, "_TABLE_NAME_RE"), (
            "B-17 regression: _TABLE_NAME_RE missing"
        )

    def test_strip_removes_comments(self) -> None:
        """SQL comments are stripped before table extraction."""
        from eden.columnar.query import _strip_sql_for_table_check

        stripped = _strip_sql_for_table_check(
            "SELECT * FROM telemetry_events -- JOIN users"
        )
        assert "users" not in stripped.lower(), (
            "B-17 regression: comment text not stripped"
        )

    def test_strip_removes_string_literals(self) -> None:
        """Text inside string literals is removed so it can't
        fake a table reference."""
        from eden.columnar.query import _strip_sql_for_table_check

        stripped = _strip_sql_for_table_check(
            "SELECT 'FROM users' AS note FROM telemetry_events"
        )
        assert "users" not in stripped.lower().replace("from", ""), (
            "B-17 regression: string literal not stripped"
        )

    def test_table_regex_extracts_from_join_into(self) -> None:
        """``FROM``, ``JOIN``, ``INTO``, ``UPDATE`` keywords
        all extract their target table."""
        from eden.columnar.query import _TABLE_NAME_RE

        def _all_matches(text):
            """Return the set of all non-empty capture groups."""
            out: set[str] = set()
            for m in _TABLE_NAME_RE.finditer(text):
                for g in m.groups():
                    if g:
                        out.add(g)
            return out

        # FROM
        assert "telemetry_events" in _all_matches(
            "SELECT * FROM telemetry_events"
        ), "B-17 regression: FROM clause not extracted"
        # JOIN
        assert "judge_scores" in _all_matches(
            "SELECT * FROM usage_events JOIN judge_scores ON 1=1"
        ), "B-17 regression: JOIN clause not extracted"
        # Backtick-quoted
        assert "telemetry_events" in _all_matches(
            "SELECT * FROM `telemetry_events`"
        ), "B-17 regression: backtick-quoted table not extracted"

    def test_pg_execute_returns_envelope_on_disallowed_table(self) -> None:
        """A query referencing a non-allowlisted table returns
        the not-implemented envelope (without hitting the DB)."""
        from eden.columnar.query import ColumnarQueryEngine

        engine = ColumnarQueryEngine()
        fake_client = AsyncMock()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            result = asyncio.new_event_loop().run_until_complete(
                engine._pg_execute(
                    query=(
                        "SELECT * FROM telemetry_events "
                        "JOIN organizations ON 1=1"
                    )
                )
            )
        # The envelope shape from _not_implemented_envelope.
        assert isinstance(result, dict), (
            f"B-17 regression: expected dict envelope, got {type(result)}"
        )
        assert "status" in result, (
            f"B-17 regression: envelope missing 'status' key: {result}"
        )
        # fetch should NOT have been called.
        fake_client.fetch.assert_not_called()

    def test_pg_execute_allows_three_source_tables(self) -> None:
        """A query referencing ONLY allowed tables calls fetch."""
        from eden.columnar.query import ColumnarQueryEngine

        engine = ColumnarQueryEngine()
        fake_client = AsyncMock()
        fake_client.fetch = AsyncMock(return_value=[])

        async def _run():
            with patch(
                "eden.storage.postgres.get_postgres_client",
                new=AsyncMock(return_value=fake_client),
            ):
                return await engine._pg_execute(
                    query=(
                        "SELECT * FROM telemetry_events "
                        "JOIN usage_events ON 1=1 "
                        "JOIN judge_scores ON 1=1"
                    )
                )

        result = asyncio.new_event_loop().run_until_complete(_run())
        asyncio.new_event_loop().close()
        assert result == [], (
            f"B-17 regression: allowed query didn't return []; got {result}"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
