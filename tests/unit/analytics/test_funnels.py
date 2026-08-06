"""Regression test for FEAT-53.

``eden.analytics.funnels.funnel``'s Postgres fallback used to query
``org_audit_log`` — table-name-valid (unlike the ``audit_log`` typo
FEAT-54 fixed) but semantically wrong: audit-log rows are operator
actions, not funnel/session-step data. It now queries
``session_summaries`` (the N12 rollup — see
``src/eden/db_migrations/versions/142_session_summaries.py`` and
``eden.sessions.rollup.SessionRollupIndexer``), one row per
(org_id, session_id).

``session_summaries`` has no free-text action/event-name column, so
steps are matched against a fixed canonical vocabulary
(``_SESSION_STEP_PREDICATES`` in ``funnels.py``) instead of an
arbitrary caller-supplied string:

  * ``session_started`` -> every summarized session.
  * ``engaged``          -> ``turn_count > 1``.
  * ``stumbled``         -> ``had_stumble``.
  * ``completed``        -> ``outcome = 'success'``.
  * ``failed``           -> ``outcome = 'fail'``.

Unrecognized step names (e.g. legacy audit-log action strings) count
0, same degrade-gracefully behavior the old action-matching query had
for actions nobody logged.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

from eden.analytics.funnels import funnel


class FakePg:
    def __init__(self, row: dict[str, Any] | None) -> None:
        self._row = row
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        self.queries.append((query, args))
        return self._row


def _no_clickhouse():
    """See test_cohorts.py::_no_clickhouse for rationale."""
    import eden.data_platform.analytics_engine as ae

    def _raise() -> Any:
        raise RuntimeError("no clickhouse in test")

    return patch.object(ae, "get_engine", _raise, create=True)


async def test_funnel_queries_session_summaries_not_audit_log() -> None:
    fake = FakePg({"step_0": 100, "step_1": 40})
    with _no_clickhouse(), patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake),
    ):
        result = await funnel(
            "org-1", ["session_started", "completed"], window_days=30
        )

    assert len(fake.queries) == 1
    sql, args = fake.queries[0]
    assert "FROM session_summaries" in sql
    assert "org_audit_log" not in sql
    assert "FROM audit_log" not in sql
    assert args[0] == "org-1"
    assert args[1] == 30

    assert [s.name for s in result.steps] == ["session_started", "completed"]
    assert result.steps[0].count == 100
    assert result.steps[1].count == 40
    assert result.overall_conversion == 40 / 100


async def test_funnel_step_predicates_map_to_expected_columns() -> None:
    fake = FakePg({"step_0": 10, "step_1": 6, "step_2": 3})
    with _no_clickhouse(), patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake),
    ):
        await funnel(
            "org-1",
            ["session_started", "engaged", "stumbled"],
            window_days=7,
        )

    sql, _ = fake.queries[0]
    assert "count(*) FILTER (WHERE TRUE) AS step_0" in sql
    assert "count(*) FILTER (WHERE turn_count > 1) AS step_1" in sql
    assert "count(*) FILTER (WHERE had_stumble) AS step_2" in sql


async def test_funnel_unrecognized_step_names_count_zero() -> None:
    # An unknown-only funnel never touches the database at all — no
    # canonical predicate matches, so all counts are trivially 0.
    fake = FakePg(None)
    with _no_clickhouse(), patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake),
    ):
        result = await funnel(
            "org-1", ["signup", "activated"], window_days=30
        )

    assert fake.queries == []
    assert [s.count for s in result.steps] == [0, 0]
    assert result.overall_conversion == 0.0


async def test_funnel_mixed_known_and_unknown_steps() -> None:
    # Only the known step gets a select clause; the unknown one stays 0.
    fake = FakePg({"step_0": 50})
    with _no_clickhouse(), patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=fake),
    ):
        result = await funnel(
            "org-1", ["session_started", "made_up_step"], window_days=30
        )

    sql, _ = fake.queries[0]
    assert "step_1" not in sql
    assert [s.name for s in result.steps] == ["session_started", "made_up_step"]
    assert result.steps[0].count == 50
    assert result.steps[1].count == 0
