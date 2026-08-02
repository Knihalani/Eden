"""Tests for :mod:`eden.services.budget_service`.

F44 regression test: the ``record_usage`` UPSERT was using an
``ON CONFLICT ... WHERE`` clause that requires a partial unique
index. The migration ``052_budgets`` created a full unique index
``(org_id, "window", window_start)`` (no partial predicate), so
Postgres would raise
``there is no unique or exclusion constraint matching the ON
CONFLICT specification`` and ``record_usage`` would silently
log the failure at DEBUG — every gateway-ingest hot-path call
became a no-op.

The fix removes the ``WHERE`` from ON CONFLICT (the unique key
already includes ``window_start``, so a new-month row never
conflicts with the prior month's row anyway).

This test locks in the SQL contract — a future refactor can't
silently re-introduce the invalid ``WHERE window_end > NOW()``
clause.
"""

from __future__ import annotations

import re
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _extract_on_conflict_clause(sql: str) -> str:
    """Return the ``ON CONFLICT ... DO UPDATE SET ...`` block."""
    m = re.search(
        r"ON CONFLICT[^;]+DO UPDATE SET[^;]+",
        sql,
        re.DOTALL | re.IGNORECASE,
    )
    if m is None:
        raise AssertionError(f"no ON CONFLICT clause in: {sql!r}")
    return m.group(0)


class TestF44BudgetConsumptionOnConflict:
    """The ``record_usage`` UPSERT must use an ON CONFLICT clause
    that matches a real (full or partial) unique index.

    The migration creates a FULL unique index
    ``(org_id, "window", window_start)`` — no partial predicate.
    Therefore the ON CONFLICT clause must NOT have a ``WHERE``
    predicate (that would require a partial index that doesn't
    exist).
    """

    @pytest.mark.asyncio
    async def test_record_usage_upsert_has_no_invalid_where_clause(
        self,
    ) -> None:
        """The ON CONFLICT in ``record_usage`` must not include a
        ``WHERE`` predicate (would require a partial index that
        doesn't exist).

        Pre-fix code: ``ON CONFLICT (org_id, window, window_start)
        WHERE window_end > NOW()`` — Postgres raises
        ``there is no unique or exclusion constraint matching
        the ON CONFLICT specification`` at runtime, and
        ``record_usage`` swallows the error at DEBUG, so the
        gateway ingest hot path silently fails to record
        usage.

        Post-fix: the ``WHERE`` is removed. ``window_start`` is
        in the unique key, so a new-month row never conflicts
        with the prior month's row anyway — the WHERE was
        always a no-op semantically.
        """
        from eden.services import budget_service

        fake_client = MagicMock()
        fake_client.execute = AsyncMock(return_value="INSERT 0 1")

        with patch(
            "eden.services.budget_service._get_client",
            AsyncMock(return_value=fake_client),
        ):
            ok = await budget_service.record_usage(
                "org-test", 0.01, window="monthly",
            )
        assert ok is True

        call = fake_client.execute.await_args
        sql = call.args[0]
        on_conflict = _extract_on_conflict_clause(sql)

        # The ON CONFLICT clause must not include a WHERE
        # predicate — the underlying unique index is a FULL
        # index, so a WHERE would mismatch.
        # (We allow whitespace between ON CONFLICT and the
        # conflict_target, but not a WHERE after the target.)
        assert " ON CONFLICT " in sql.upper()
        # The conflict_target must reference the three unique-key
        # columns. ``window`` is a Postgres reserved word and MUST be
        # double-quoted — unquoted it is a syntax error on PG16/17/18.
        assert '(org_id, "window", window_start)' in on_conflict.lower()
        # The forbidden pattern: ``... window_start) WHERE ...``
        assert not re.search(
            r"window_start\)\s+WHERE",
            on_conflict,
            re.IGNORECASE,
        ), (
            f"ON CONFLICT has a WHERE predicate but the unique "
            f"index is FULL (no partial predicate) — Postgres "
            f"will raise 'there is no unique or exclusion "
            f"constraint matching the ON CONFLICT "
            f"specification' at runtime. SQL: {on_conflict!r}"
        )
        # The DO UPDATE SET clause must be present.
        assert "DO UPDATE SET" in on_conflict.upper()

    @pytest.mark.asyncio
    async def test_record_usage_increments_cost_and_request_count(
        self,
    ) -> None:
        """The UPSERT increments cost and request count via
        ``EXCLUDED`` — verifies the post-fix contract still
        works (the fix is to ON CONFLICT, not DO UPDATE)."""
        from eden.services import budget_service

        fake_client = MagicMock()
        fake_client.execute = AsyncMock(return_value="INSERT 0 1")

        with patch(
            "eden.services.budget_service._get_client",
            AsyncMock(return_value=fake_client),
        ):
            ok = await budget_service.record_usage(
                "org-1", 0.05, window="monthly",
            )
        assert ok is True
        sql = fake_client.execute.await_args.args[0]
        # The UPSERT must add the new cost to the existing one
        # and bump the request counter by 1.
        assert "cost_usd = budget_consumption.cost_usd + EXCLUDED.cost_usd" in sql
        assert "requests_count = budget_consumption.requests_count + 1" in sql
