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
        # The conflict_target must reference the full unique-key
        # column list, including the FEAT-47 scope_type/scope_id
        # columns added by migration 152 (``idx_budget_consumption_
        # active_scope``). ``window`` is a Postgres reserved word and
        # MUST be double-quoted — unquoted it is a syntax error on
        # PG16/17/18. ``scope_id`` is folded through ``COALESCE(...,
        # '')`` in the index (and therefore the conflict target) so
        # two org-scoped (``scope_id IS NULL``) rows for the same
        # org+window still collide as intended.
        assert (
            '(org_id, "window", window_start, scope_type, '
            "coalesce(scope_id, ''))"
        ) in on_conflict.lower()
        # The forbidden pattern: ``... COALESCE(scope_id, '')) WHERE ...``
        assert not re.search(
            r"coalesce\(scope_id,\s*''\)\)\s+WHERE",
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


class _FakeBudgetsTable:
    """In-memory stand-in for ``budgets`` honoring the FEAT-47
    ``(org_id, window, scope_type, scope_id)`` unique key (migration
    152) — good enough to prove real isolation/coexistence semantics
    without a live Postgres.
    """

    def __init__(self) -> None:
        self.rows: dict[tuple, dict] = {}

    async def fetchrow(self, sql: str, *args):
        org_id, scope_type, scope_id = args
        matches = [
            row
            for (o, s_type, s_id), row in self.rows.items()
            if o == org_id and s_type == scope_type and s_id == scope_id
        ]
        return matches[-1] if matches else None

    async def execute(self, sql: str, *args):
        (
            budget_id,
            org_id,
            window,
            cost_soft,
            cost_hard,
            enforcement,
            action_on_exceed,
            threshold_alert_pct,
            thresholds_json,
            scope_type,
            scope_id,
        ) = args
        self.rows[(org_id, scope_type, scope_id)] = {
            "id": budget_id,
            "org_id": org_id,
            "window": window,
            "cost_soft_limit_usd": cost_soft,
            "cost_hard_limit_usd": cost_hard,
            "enforcement_enabled": enforcement,
            "action_on_exceed": action_on_exceed,
            "threshold_alert_pct": threshold_alert_pct,
            "alert_thresholds": thresholds_json,
        }
        return "INSERT 0 1"


class _FakeConsumptionTable:
    """In-memory stand-in for ``budget_consumption`` honoring the
    FEAT-47 ``(org_id, window, window_start, scope_type, scope_id)``
    unique key (migration 152).
    """

    def __init__(self) -> None:
        self.rows: dict[tuple, dict] = {}

    async def fetchrow(self, sql: str, *args):
        org_id, window, start, scope_type, scope_id = args
        return self.rows.get((org_id, window, start, scope_type, scope_id))

    async def execute(self, sql: str, *args):
        (_id, org_id, window, start, end, cost_usd, scope_type, scope_id) = args
        key = (org_id, window, start, scope_type, scope_id)
        row = self.rows.get(key)
        if row is None:
            self.rows[key] = {
                "window_start": start,
                "window_end": end,
                "cost_usd": cost_usd,
                "requests_count": 1,
            }
        else:
            row["cost_usd"] += cost_usd
            row["requests_count"] += 1
        return "INSERT 0 1"


class TestFEAT47ScopedBudgets:
    """FEAT-47: team/agent-scoped budgets via ``scope_type``/``scope_id``.

    Covers: scoped budget creation/lookup is isolated from the
    org-level budget for the same org; default (no scope args)
    behavior is unchanged; a team-scoped and an org-scoped budget for
    the same org+window coexist without a unique-constraint
    violation.
    """

    @pytest.mark.asyncio
    async def test_default_scope_args_query_org_scope_none_id(self) -> None:
        """Calling ``get_budget``/``get_consumption`` with no scope
        kwargs must query ``scope_type='org', scope_id=None`` — the
        exact filter a pre-FEAT-47 org-only row satisfies — so every
        existing caller's behavior is unchanged.
        """
        from eden.services import budget_service

        fake_client = MagicMock()
        fake_client.fetchrow = AsyncMock(return_value=None)

        with patch(
            "eden.services.budget_service._get_client",
            AsyncMock(return_value=fake_client),
        ):
            await budget_service.get_budget("org-default")

        args = fake_client.fetchrow.await_args.args
        # (sql, org_id, scope_type, scope_id)
        assert args[1] == "org-default"
        assert args[2] == "org"
        assert args[3] is None

        fake_client2 = MagicMock()
        fake_client2.fetchrow = AsyncMock(return_value=None)
        with patch(
            "eden.services.budget_service._get_client",
            AsyncMock(return_value=fake_client2),
        ):
            await budget_service.get_consumption("org-default", window="monthly")

        args2 = fake_client2.fetchrow.await_args.args
        # (sql, org_id, window, window_start, scope_type, scope_id)
        assert args2[1] == "org-default"
        assert args2[4] == "org"
        assert args2[5] is None

    @pytest.mark.asyncio
    async def test_scoped_budget_isolated_from_org_budget(self) -> None:
        """A team-scoped budget upsert must not be visible to a
        default (org-scoped) ``get_budget`` lookup, and vice versa.
        """
        from eden.services import budget_service

        table = _FakeBudgetsTable()
        fake_client = MagicMock()
        fake_client.fetchrow = AsyncMock(side_effect=table.fetchrow)
        fake_client.execute = AsyncMock(side_effect=table.execute)

        with patch(
            "eden.services.budget_service._get_client",
            AsyncMock(return_value=fake_client),
        ):
            await budget_service.upsert_budget(
                "org-iso",
                cost_soft_limit_usd=8.0,
                cost_hard_limit_usd=10.0,
                enforcement_enabled=True,
            )
            await budget_service.upsert_budget(
                "org-iso",
                cost_soft_limit_usd=80.0,
                cost_hard_limit_usd=100.0,
                enforcement_enabled=True,
                scope_type="team",
                scope_id="team-42",
            )

            org_budget = await budget_service.get_budget("org-iso")
            team_budget = await budget_service.get_budget(
                "org-iso", scope_type="team", scope_id="team-42"
            )
            other_team_budget = await budget_service.get_budget(
                "org-iso", scope_type="team", scope_id="team-does-not-exist"
            )

        assert org_budget["cost_hard_limit_usd"] == 10.0
        assert team_budget["cost_hard_limit_usd"] == 100.0
        # A lookup for a scope that was never upserted must not fall
        # through to the org-level (or any other scope's) row.
        assert other_team_budget["source"] == "defaults"

    @pytest.mark.asyncio
    async def test_team_and_org_budget_coexist_without_unique_violation(
        self,
    ) -> None:
        """Upserting an org-level budget and a team-scoped budget for
        the same org+window must both persist — i.e. the widened
        unique index (migration 152) does not collide the two rows.
        """
        from eden.services import budget_service

        table = _FakeBudgetsTable()
        fake_client = MagicMock()
        fake_client.fetchrow = AsyncMock(side_effect=table.fetchrow)
        fake_client.execute = AsyncMock(side_effect=table.execute)

        with patch(
            "eden.services.budget_service._get_client",
            AsyncMock(return_value=fake_client),
        ):
            await budget_service.upsert_budget(
                "org-coexist",
                cost_soft_limit_usd=8.0,
                cost_hard_limit_usd=10.0,
                enforcement_enabled=True,
                window="monthly",
            )
            await budget_service.upsert_budget(
                "org-coexist",
                cost_soft_limit_usd=80.0,
                cost_hard_limit_usd=100.0,
                enforcement_enabled=True,
                window="monthly",
                scope_type="team",
                scope_id="team-1",
            )

        # Both rows must exist independently — no overwrite.
        assert len(table.rows) == 2
        assert ("org-coexist", "org", None) in table.rows
        assert ("org-coexist", "team", "team-1") in table.rows

    @pytest.mark.asyncio
    async def test_record_usage_scope_isolated_consumption(self) -> None:
        """``record_usage`` for a team scope must not merge cost into
        the org-level consumption row for the same org+window, and
        vice versa — the widened unique index on
        ``budget_consumption`` (migration 152) keeps them distinct
        rows.
        """
        from eden.services import budget_service

        table = _FakeConsumptionTable()
        fake_client = MagicMock()
        fake_client.execute = AsyncMock(side_effect=table.execute)

        with patch(
            "eden.services.budget_service._get_client",
            AsyncMock(return_value=fake_client),
        ):
            ok_org = await budget_service.record_usage(
                "org-usage", 1.0, window="monthly"
            )
            ok_team = await budget_service.record_usage(
                "org-usage",
                5.0,
                window="monthly",
                scope_type="team",
                scope_id="team-9",
            )
            # A second org-scoped call must accumulate onto the
            # org row, not the team row.
            ok_org2 = await budget_service.record_usage(
                "org-usage", 2.0, window="monthly"
            )

        assert ok_org is True
        assert ok_team is True
        assert ok_org2 is True
        assert len(table.rows) == 2

        org_rows = [
            row
            for key, row in table.rows.items()
            if key[3] == "org" and key[4] is None
        ]
        team_rows = [
            row
            for key, row in table.rows.items()
            if key[3] == "team" and key[4] == "team-9"
        ]
        assert len(org_rows) == 1
        assert len(team_rows) == 1
        assert org_rows[0]["cost_usd"] == pytest.approx(3.0)
        assert org_rows[0]["requests_count"] == 2
        assert team_rows[0]["cost_usd"] == pytest.approx(5.0)
        assert team_rows[0]["requests_count"] == 1

    @pytest.mark.asyncio
    async def test_record_usage_default_args_use_org_scope(self) -> None:
        """A caller that does not pass ``scope_type``/``scope_id``
        must still write ``scope_type='org', scope_id=NULL`` — the
        pre-FEAT-47 shape.
        """
        from eden.services import budget_service

        fake_client = MagicMock()
        fake_client.execute = AsyncMock(return_value="INSERT 0 1")

        with patch(
            "eden.services.budget_service._get_client",
            AsyncMock(return_value=fake_client),
        ):
            ok = await budget_service.record_usage(
                "org-default-usage", 0.01, window="monthly"
            )
        assert ok is True
        args = fake_client.execute.await_args.args
        # (sql, id, org_id, window, start, end, cost_usd, scope_type, scope_id)
        assert args[-2] == "org"
        assert args[-1] is None
