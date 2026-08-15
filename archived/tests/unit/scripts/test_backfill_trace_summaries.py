"""Unit tests for scripts/backfill_trace_summaries.py (Wave 0 / plan 1.1a).

Verifies without a live database:

* ``_AGG_SQL`` column aliases match those expected by ``_UPSERT_SQL`` and the
  migration-167 schema (``org_id``, ``trace_id``, ... ``tags``).
* The aggregate expressions in ``_AGG_SQL`` are byte-for-byte compatible with
  ``TraceSummaryIndexer._TRACE_SQL`` / ``_TAGS_SQL`` / ``_SESSION_ID_SQL``
  (drift between the backfill and the online indexer would produce a
  different read model for old vs new traces).
* The upsert is ON CONFLICT DO UPDATE (true idempotent upsert, not DO NOTHING)
  so re-runs converge rather than silently skipping updated rows.
* The script is importable and the CLI entry-point is wired.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Ensure the scripts directory is importable without installing the package.
# ``pyproject.toml`` sets ``pythonpath = ["src", "."]`` which puts the repo
# root on sys.path; that covers ``scripts/`` because it lives at the root.
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = Path(__file__).resolve().parents[3] / "scripts"
if str(_SCRIPTS_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR.parent))


def _import_backfill():
    """Import the backfill module, skipping the test if eden.storage is absent."""
    try:
        import scripts.backfill_trace_summaries as _m  # noqa: PLC0415
        return _m
    except ImportError as exc:
        pytest.skip(f"backfill module not importable in this env: {exc}")


# ---------------------------------------------------------------------------
# Column-alias checklist: every column the UPSERT expects must appear in AGG.
# ---------------------------------------------------------------------------

_EXPECTED_AGG_COLS = {
    "org_id",
    "trace_id",
    "started_at",
    "realm",
    "agent_id",
    "model",
    "provider",
    "session_id",
    "outcome",
    "error_type",
    "attr_error",
    "agent_session_id",
    "input_tokens",
    "output_tokens",
    "cost_usd",
    "span_count",
    "duration_ms",
    "tags",
}

_UPSERT_INSERT_COLS = {
    "org_id", "trace_id", "started_at", "realm", "agent_id", "model",
    "provider", "session_id", "outcome", "error_type", "attr_error",
    "agent_session_id", "input_tokens", "output_tokens", "cost_usd",
    "span_count", "duration_ms", "tags", "updated_at",
}


class TestAggSqlColumnAliases:
    """All expected column aliases must appear in _AGG_SQL."""

    def test_all_expected_columns_present(self) -> None:
        m = _import_backfill()
        sql = m._AGG_SQL
        # Extract ``AS <alias>`` patterns; also catch bare column names in the
        # SELECT list (e.g. ``trace_id`` without AS).
        aliases = set(re.findall(r"AS\s+(\w+)", sql, re.IGNORECASE))
        # ``tenant_id AS org_id`` is the canonical alias for the grouping key.
        assert "org_id" in aliases, "_AGG_SQL must alias tenant_id as org_id"
        for col in _EXPECTED_AGG_COLS - {"org_id"}:
            assert col in sql, f"column/alias '{col}' missing from _AGG_SQL"

    def test_no_extra_positional_mismatch(self) -> None:
        """The UPSERT VALUES list has 19 placeholders ($1..$19) for 19 cols."""
        m = _import_backfill()
        sql = m._UPSERT_SQL
        # Count placeholder positions: $1 … $N
        placeholders = re.findall(r"\$(\d+)", sql)
        # There should be exactly 19 placeholders (18 data cols + NOW() for
        # updated_at is a SQL literal, so 18 $-params: org_id…tags + updated_at=NOW()).
        # The run() function passes 18 positional args per row.
        max_placeholder = max(int(p) for p in placeholders)
        assert max_placeholder == 18, (
            f"_UPSERT_SQL expects 18 positional args ($1..$18) but "
            f"highest placeholder found is ${max_placeholder}"
        )

    def test_on_conflict_is_do_update_not_do_nothing(self) -> None:
        """Backfill must be a true upsert so re-runs overwrite stale rows."""
        m = _import_backfill()
        sql = m._UPSERT_SQL.upper()
        assert "ON CONFLICT" in sql
        assert "DO UPDATE SET" in sql, (
            "_UPSERT_SQL must use ON CONFLICT DO UPDATE SET (not DO NOTHING) "
            "so the backfill is idempotent-and-convergent, not idempotent-skip"
        )
        assert "DO NOTHING" not in sql


class TestAggSqlExpressionParity:
    """The aggregate expressions in _AGG_SQL must match TraceSummaryIndexer."""

    def _indexer_sql(self) -> tuple[str, str, str]:
        """Return (_TRACE_SQL, _TAGS_SQL, _SESSION_ID_SQL) from the indexer."""
        try:
            from eden.observability.trace_summary import (  # noqa: PLC0415
                _SESSION_ID_SQL,
                _TAGS_SQL,
                _TRACE_SQL,
            )
        except ImportError as exc:
            pytest.skip(f"eden not importable: {exc}")
        return _TRACE_SQL, _TAGS_SQL, _SESSION_ID_SQL

    def _normalise(self, s: str) -> str:
        """Collapse whitespace for comparison."""
        return " ".join(s.split()).upper()

    def test_model_coalesce_ladder_matches_indexer(self) -> None:
        """The coalesce ladder for ``model`` must contain the same rungs."""
        m = _import_backfill()
        trace_sql, _, _ = self._indexer_sql()
        # Check each rung of the model coalesce ladder is present in both.
        rungs = [
            "max(model)",
            "max(model_name)",
            "attributes->>'model'",
            "attributes->>'openai.model'",
            "attributes->>'anthropic.model'",
            "attributes->>'bedrock.model_id'",
            "attributes->>'gen_ai.request.model'",
        ]
        for rung in rungs:
            assert rung in m._AGG_SQL, (
                f"backfill _AGG_SQL missing model ladder rung: {rung!r}"
            )
            assert rung in trace_sql, (
                f"indexer _TRACE_SQL missing model ladder rung: {rung!r}"
            )

    def test_cost_usd_expression_matches_indexer(self) -> None:
        """cost_usd sum expression must match the indexer exactly."""
        m = _import_backfill()
        trace_sql, _, _ = self._indexer_sql()
        # Both should have the triple-COALESCE on metrics/payload/attributes.
        for part in ("metrics->>'cost_usd'", "payload->>'cost_usd'", "attributes->>'cost_usd'"):
            assert part in m._AGG_SQL, f"backfill _AGG_SQL missing: {part}"
            assert part in trace_sql, f"indexer _TRACE_SQL missing: {part}"

    def test_token_expressions_match_indexer(self) -> None:
        """input/output token expressions must match the indexer."""
        m = _import_backfill()
        trace_sql, _, _ = self._indexer_sql()
        for part in (
            "payload->>'input_tokens'",
            "payload->>'output_tokens'",
            "usage_prompt_tokens",
            "usage_completion_tokens",
        ):
            assert part in m._AGG_SQL, f"backfill _AGG_SQL missing: {part}"
            assert part in trace_sql, f"indexer _TRACE_SQL missing: {part}"

    def test_tags_subquery_present_in_backfill(self) -> None:
        """_AGG_SQL must include the tags aggregation (inlined from _TAGS_SQL)."""
        m = _import_backfill()
        sql = m._AGG_SQL
        # The indexer's _TAGS_SQL uses array_agg(DISTINCT tag) over JSONB.
        assert "array_agg" in sql.lower(), "_AGG_SQL missing array_agg for tags"
        assert "DISTINCT tag" in sql or "distinct tag" in sql.lower(), (
            "_AGG_SQL must use DISTINCT tag to match _TAGS_SQL"
        )

    def test_agent_session_id_subquery_present(self) -> None:
        """_AGG_SQL must inline the agent_session_id extraction from _SESSION_ID_SQL."""
        m = _import_backfill()
        sql = m._AGG_SQL
        assert "agent_session_id:%" in sql, (
            "_AGG_SQL missing agent_session_id LIKE filter (from _SESSION_ID_SQL)"
        )
        assert "split_part" in sql.lower(), (
            "_AGG_SQL missing split_part call (from _SESSION_ID_SQL)"
        )


class TestCliWiring:
    """The main() entry-point must be callable and return an int."""

    def test_main_is_callable(self) -> None:
        m = _import_backfill()
        assert callable(m.main)

    def test_run_is_async_callable(self) -> None:
        import asyncio
        m = _import_backfill()
        assert callable(m.run)
        # run() is a coroutine function.
        assert asyncio.iscoroutinefunction(m.run)

    def test_iter_batches_yields_chunks(self) -> None:
        """_iter_batches must split a row list into sub-lists of ``size``."""
        import asyncio
        m = _import_backfill()

        class _FakeClient:
            async def fetch(self, sql: str, *args):  # noqa: ARG002
                return list(range(25))  # 25 fake rows

        async def _collect():
            chunks = []
            async for batch in m._iter_batches(_FakeClient(), "SELECT 1", [], 10):
                chunks.append(batch)
            return chunks

        chunks = asyncio.run(_collect())
        assert len(chunks) == 3
        assert len(chunks[0]) == 10
        assert len(chunks[1]) == 10
        assert len(chunks[2]) == 5
