"""Tests for ``eden.data_platform.clickhouse_fallback_drain``.

``clickhouse_fallback`` was written on every ClickHouse insert failure and
read by nothing: no ``SELECT``, no ``resolved_at`` update, no delete. The
sink's docstring promised "later retry" for the whole life of the table.
These tests pin the behaviours that make that promise true, and the ones
that keep the retry from becoming its own outage:

* replayed rows are marked resolved and stop being selected;
* a failing row is retried with backoff, then **abandoned**, because a
  payload ClickHouse structurally cannot accept would otherwise sit at the
  head of an oldest-first queue forever, starving everything behind it;
* abandonment is *counted*, on the existing ``sink_ch``/``write_error``
  series rather than a new one;
* the replay does not go through the sink path that would write a fresh
  fallback row on failure (that would make the drain an amplifier);
* the batch is bounded and the leader lease is always released.

The mocked tests need no server. The ``realdb`` class exercises the actual
SQL — backoff arithmetic, the ``dead_at`` transition, the purge predicate —
against Postgres, because none of that is observable through a mock: a mock
returns whatever it was told to regardless of whether the SQL means it.
"""

from __future__ import annotations

import os
import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.data_platform import clickhouse_fallback_drain as drain

PG_DSN = os.environ.get("EDEN_TEST_PG_DSN", "")


# ── fakes ────────────────────────────────────────────────────────────────


class FakePg:
    """Minimal PostgresClient stand-in that dispatches on statement kind.

    Records every call so tests can assert on *what was asked of the
    database*, not on the module's source text.
    """

    def __init__(
        self,
        batch: list[dict[str, Any]] | None = None,
        settled: list[dict[str, Any]] | None = None,
    ) -> None:
        self.batch = batch or []
        self.settled = settled or []
        self.fetches: list[tuple[str, tuple[Any, ...]]] = []
        self.executes: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.fetches.append((query, args))
        if query.lstrip().upper().startswith("SELECT") or "SELECT" in query.split()[0:1]:
            return self.batch
        head = query.strip().split(None, 1)[0].upper()
        if head == "SELECT":
            return self.batch
        return self.settled

    async def execute(self, query: str, *args: Any) -> str:
        self.executes.append((query, args))
        return "UPDATE 0"

    # convenience views for assertions
    def selects(self) -> list[tuple[str, tuple[Any, ...]]]:
        return [f for f in self.fetches if f[0].strip().upper().startswith("SELECT")]

    def updates(self) -> list[tuple[str, tuple[Any, ...]]]:
        return [f for f in self.fetches if f[0].strip().upper().startswith("UPDATE")]

    def resolve_calls(self) -> list[tuple[str, tuple[Any, ...]]]:
        return [e for e in self.executes if "resolved_at = NOW()" in e[0]]

    def purge_calls(self) -> list[tuple[str, tuple[Any, ...]]]:
        return [e for e in self.executes if e[0].strip().upper().startswith("DELETE")]


def _row(table: str = "telemetry_events_ch", retry_count: int = 0) -> dict[str, Any]:
    return {
        "id": uuid.uuid4(),
        "target_table": table,
        "payload": {"event_id": "e1", "duration_ms": 5},
        "retry_count": retry_count,
    }


def _fake_sink(fail: bool = False) -> Any:
    sink = MagicMock()
    if fail:
        sink._insert_json = AsyncMock(side_effect=RuntimeError("HTTP 500: boom"))
    else:
        sink._insert_json = AsyncMock(return_value=None)
    # The public batch path writes a NEW fallback row on failure. If the
    # drain ever reaches it, draining amplifies the backlog instead of
    # clearing it — so it is wired to fail the test loudly.
    sink._fallback_to_postgres = AsyncMock(
        side_effect=AssertionError(
            "drain must not use the sink path that re-parks rows in Postgres"
        )
    )
    return sink


def _patch_sink(sink: Any) -> Any:
    return patch(
        "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
        AsyncMock(return_value=sink),
    )


# ── drain behaviour (no server) ──────────────────────────────────────────


async def test_successful_replay_resolves_the_rows() -> None:
    """Rows that reach ClickHouse are stamped resolved_at and leave the queue."""
    rows = [_row(), _row()]
    pg = FakePg(batch=rows)
    sink = _fake_sink()
    with _patch_sink(sink):
        result = await drain._run_drain(pg, limit=500)

    assert result["replayed"] == 2
    assert result["failed"] == 0
    assert result["gave_up"] == 0
    sink._insert_json.assert_awaited_once()
    table, payloads = sink._insert_json.await_args.args
    assert table == "telemetry_events_ch"
    assert payloads == [r["payload"] for r in rows]

    resolves = pg.resolve_calls()
    assert len(resolves) == 1
    assert set(resolves[0][1][0]) == {r["id"] for r in rows}


async def test_rows_are_grouped_into_one_insert_per_target_table() -> None:
    """Two destinations means two inserts, not one insert per row."""
    rows = [
        _row("telemetry_events_ch"),
        _row("telemetry_events_ch"),
        _row("benchmark_results"),
    ]
    sink = _fake_sink()
    with _patch_sink(sink):
        result = await drain._run_drain(FakePg(batch=rows), limit=500)

    assert result["tables"] == 2
    assert sink._insert_json.await_count == 2
    by_table = {c.args[0]: c.args[1] for c in sink._insert_json.await_args_list}
    assert len(by_table["telemetry_events_ch"]) == 2
    assert len(by_table["benchmark_results"]) == 1


async def test_failed_replay_does_not_resolve_and_records_the_attempt() -> None:
    """A failed replay leaves the row unresolved so a later tick retries it."""
    rows = [_row()]
    pg = FakePg(batch=rows, settled=[{"dead_at": None}])
    with _patch_sink(_fake_sink(fail=True)):
        result = await drain._run_drain(pg, limit=500)

    assert result["replayed"] == 0
    assert result["failed"] == 1
    assert result["gave_up"] == 0
    assert pg.resolve_calls() == [], "a failed replay must not mark rows resolved"

    updates = pg.updates()
    assert len(updates) == 1
    # The error text is carried back to the row so an operator can see why.
    assert "boom" in updates[0][1][1]


async def test_give_up_is_counted_on_the_existing_drop_series() -> None:
    """Abandoned rows increment sink_ch/write_error, not a parallel metric."""
    from eden.observability import drop_metrics

    drop_metrics.reset_for_tests()
    before = drop_metrics.get_drop_metrics().get(("sink_ch", "write_error"), 0.0)

    rows = [_row(), _row(), _row()]
    # Two rows crossed the attempt ceiling, one did not.
    pg = FakePg(
        batch=rows,
        settled=[{"dead_at": "2026-07-30"}, {"dead_at": "2026-07-30"}, {"dead_at": None}],
    )
    with _patch_sink(_fake_sink(fail=True)):
        result = await drain._run_drain(pg, limit=500)

    assert result["gave_up"] == 2
    after = drop_metrics.get_drop_metrics().get(("sink_ch", "write_error"), 0.0)
    assert after - before == 2.0, (
        "abandoning a fallback row is ClickHouse losing events and must be "
        "counted on the series the sink already uses"
    )
    drop_metrics.reset_for_tests()


async def test_no_give_ups_leaves_the_drop_counter_untouched() -> None:
    """The counter moves only on abandonment, never on an ordinary retry."""
    from eden.observability import drop_metrics

    drop_metrics.reset_for_tests()
    before = drop_metrics.get_drop_metrics().get(("sink_ch", "write_error"), 0.0)
    pg = FakePg(batch=[_row()], settled=[{"dead_at": None}])
    with _patch_sink(_fake_sink(fail=True)):
        await drain._run_drain(pg, limit=500)
    after = drop_metrics.get_drop_metrics().get(("sink_ch", "write_error"), 0.0)
    assert after == before
    drop_metrics.reset_for_tests()


async def test_batch_is_bounded_and_ordered_oldest_first() -> None:
    """The select carries the caller's LIMIT and orders by failed_at."""
    pg = FakePg(batch=[])
    with _patch_sink(_fake_sink()):
        await drain._run_drain(pg, limit=37)

    sql, args = pg.selects()[0]
    assert args[0] == 37, "the LIMIT must be the bound the caller asked for"
    assert "ORDER BY failed_at" in sql
    # Terminal rows must be excluded or a dead row is re-read forever.
    assert "dead_at IS NULL" in sql


async def test_empty_backlog_touches_clickhouse_not_at_all() -> None:
    """Nothing to drain means no ClickHouse round trip and no updates."""
    pg = FakePg(batch=[])
    sink = _fake_sink()
    with _patch_sink(sink):
        result = await drain._run_drain(pg, limit=500)
    assert result == {"claimed": 0, "replayed": 0, "failed": 0, "gave_up": 0}
    sink._insert_json.assert_not_awaited()
    assert pg.executes == []


async def test_string_payloads_are_decoded_before_replay() -> None:
    """asyncpg hands JSONB back as text unless a codec is registered."""
    row = _row()
    row["payload"] = '{"event_id":"e9","duration_ms":3}'
    sink = _fake_sink()
    with _patch_sink(sink):
        await drain._run_drain(FakePg(batch=[row]), limit=500)
    payloads = sink._insert_json.await_args.args[1]
    assert payloads == [{"event_id": "e9", "duration_ms": 3}]


# ── leader gating ────────────────────────────────────────────────────────


def _patch_leader(acquired: bool, backend: str = "redis") -> Any:
    return patch(
        "eden.workers.leader._acquire_with_fallback",
        AsyncMock(return_value=(acquired, backend)),
    )


def _patch_lock(lock: Any) -> Any:
    return patch("eden.storage.redis.Lock", MagicMock(return_value=lock))


async def test_a_follower_does_no_work_at_all() -> None:
    """Losing the election means not a single query against the backlog."""
    pg = FakePg(batch=[_row()])
    lock = MagicMock()
    lock.release = AsyncMock()
    with (
        patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)),
        _patch_lock(lock),
        _patch_leader(False),
        _patch_sink(_fake_sink()),
    ):
        result = await drain.run_once()

    assert result == {"skipped": True, "reason": "not_leader"}
    assert pg.fetches == [] and pg.executes == []


async def test_the_leader_drains_and_releases_the_redis_lock() -> None:
    pg = FakePg(batch=[_row()])
    lock = MagicMock()
    lock.release = AsyncMock()
    with (
        patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)),
        _patch_lock(lock),
        _patch_leader(True, "redis"),
        _patch_sink(_fake_sink()),
    ):
        result = await drain.run_once()

    assert result["replayed"] == 1
    assert result["backend"] == "redis"
    lock.release.assert_awaited_once()


async def test_a_postgres_backed_lease_is_released_through_postgres() -> None:
    """Releasing the wrong backend would stomp a peer's lease."""
    pg = FakePg(batch=[])
    lock = MagicMock()
    lock.release = AsyncMock()
    release = AsyncMock(return_value=True)
    with (
        patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)),
        _patch_lock(lock),
        _patch_leader(True, "postgres"),
        patch("eden.storage.pg_lease.release", release),
        _patch_sink(_fake_sink()),
    ):
        await drain.run_once()

    release.assert_awaited_once()
    lock.release.assert_not_awaited()


async def test_the_lease_is_released_even_when_the_drain_raises() -> None:
    """A leaked lease blocks every later tick until the TTL expires."""
    pg = FakePg(batch=[])
    lock = MagicMock()
    lock.release = AsyncMock()
    with (
        patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)),
        _patch_lock(lock),
        _patch_leader(True, "redis"),
        patch.object(
            drain, "_run_drain", AsyncMock(side_effect=RuntimeError("kaboom"))
        ),
    ):
        with pytest.raises(RuntimeError):
            await drain.run_once()

    lock.release.assert_awaited_once()


async def test_no_postgres_means_no_election_attempt() -> None:
    with patch(
        "eden.storage.postgres.get_postgres_client", AsyncMock(return_value=None)
    ):
        result = await drain.run_once()
    assert result == {"skipped": True, "reason": "postgres_unavailable"}


async def test_settled_rows_are_purged_so_the_table_stays_bounded() -> None:
    """Draining alone still grows the table; resolved rows must age out."""
    pg = FakePg(batch=[])
    lock = MagicMock()
    lock.release = AsyncMock()
    with (
        patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)),
        _patch_lock(lock),
        _patch_leader(True, "redis"),
        _patch_sink(_fake_sink()),
    ):
        await drain.run_once()

    purges = pg.purge_calls()
    assert len(purges) == 1
    sql = purges[0][0]
    assert "resolved_at IS NOT NULL" in sql and "dead_at IS NOT NULL" in sql


# ── scheduling ───────────────────────────────────────────────────────────


async def test_cron_tick_runs_the_drain_on_its_ten_minute_slot() -> None:
    """The drain is wired into the same scheduler as the other workers."""
    from datetime import UTC, datetime

    from eden.workers import cron_tick

    run_once = AsyncMock(return_value={"replayed": 3})
    with (
        patch.object(cron_tick, "_once_per_window", AsyncMock(return_value=True)),
        patch(
            "eden.data_platform.clickhouse_fallback_drain.run_once", run_once
        ),
        patch.object(cron_tick, "_run_signal_backfill", AsyncMock(return_value={})),
        patch.object(cron_tick, "_run_signal_cluster_quiet", AsyncMock(return_value={})),
        patch.object(cron_tick, "_run_shadow_outcome_join", AsyncMock(return_value={})),
        patch.object(cron_tick, "_run_mcp_rollup", AsyncMock(return_value={})),
        patch.object(cron_tick, "_run_classifier_retrain", AsyncMock(return_value={})),
    ):
        out = await cron_tick.run_maintenance_due(
            now=datetime(2026, 7, 30, 12, 1, tzinfo=UTC), dry_run=False
        )

    run_once.assert_awaited_once()
    assert out["clickhouse_fallback_drain"] == {"replayed": 3}


async def test_a_drain_failure_does_not_abort_the_rest_of_the_tick() -> None:
    """One broken step must not take the whole maintenance tick down."""
    from datetime import UTC, datetime

    from eden.workers import cron_tick

    with (
        patch.object(cron_tick, "_once_per_window", AsyncMock(return_value=True)),
        patch.object(cron_tick, "_release_window", AsyncMock()),
        patch(
            "eden.data_platform.clickhouse_fallback_drain.run_once",
            AsyncMock(side_effect=RuntimeError("drain boom")),
        ),
        patch.object(cron_tick, "_run_signal_backfill", AsyncMock(return_value={"ok": 1})),
        patch.object(cron_tick, "_run_signal_cluster_quiet", AsyncMock(return_value={})),
        patch.object(cron_tick, "_run_shadow_outcome_join", AsyncMock(return_value={})),
        patch.object(cron_tick, "_run_mcp_rollup", AsyncMock(return_value={})),
        patch.object(cron_tick, "_run_classifier_retrain", AsyncMock(return_value={})),
    ):
        out = await cron_tick.run_maintenance_due(
            now=datetime(2026, 7, 30, 12, 1, tzinfo=UTC), dry_run=False
        )

    assert "drain boom" in str(out["clickhouse_fallback_drain"])
    assert out["signal_backfill"] == {"ok": 1}


# ── obsolete pre-fix row cleanup ────────────────────────────────────────


class _CleanupFakePg:
    """Records fetch/execute for the cleanup helper specifically.

    Distinct from ``FakePg`` above (which dispatches SELECT vs. other
    statements by keyword sniffing tuned for the drain's own queries):
    the cleanup helper issues exactly one SELECT and, when applying,
    exactly one UPDATE, so a simpler recorder is clearer here.
    """

    def __init__(self, candidates: list[dict[str, Any]]) -> None:
        self.candidates = candidates
        self.fetch_calls: list[tuple[str, tuple[Any, ...]]] = []
        self.execute_calls: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        self.fetch_calls.append((query, args))
        return self.candidates

    async def execute(self, query: str, *args: Any) -> str:
        self.execute_calls.append((query, args))
        return "UPDATE 0"


def _obsolete_row(rid: Any = None) -> dict[str, Any]:
    return {
        "id": rid or uuid.uuid4(),
        "target_table": "telemetry_events_ch",
        "failed_at": "2026-07-10T00:00:00+00:00",
    }


class TestMarkObsoletePreFixRowsDead:
    async def test_dry_run_reports_but_does_not_write(self) -> None:
        pg = _CleanupFakePg([_obsolete_row(), _obsolete_row()])
        result = await drain.mark_obsolete_pre_fix_rows_dead(pg, dry_run=True)

        assert result["candidates"] == 2
        assert result["marked_dead"] == 0
        assert result["dry_run"] is True
        assert pg.execute_calls == [], "dry_run must never write"

    async def test_apply_marks_dead_and_carries_the_ids(self) -> None:
        rid1, rid2 = uuid.uuid4(), uuid.uuid4()
        pg = _CleanupFakePg([_obsolete_row(rid1), _obsolete_row(rid2)])
        result = await drain.mark_obsolete_pre_fix_rows_dead(pg, dry_run=False)

        assert result["candidates"] == 2
        assert result["marked_dead"] == 2
        assert result["dry_run"] is False
        assert len(pg.execute_calls) == 1
        query, args = pg.execute_calls[0]
        assert "SET dead_at = NOW()" in query
        assert set(args[0]) == {rid1, rid2}

    async def test_no_candidates_is_a_clean_noop(self) -> None:
        pg = _CleanupFakePg([])
        result = await drain.mark_obsolete_pre_fix_rows_dead(pg, dry_run=False)
        assert result == {"candidates": 0, "marked_dead": 0, "dry_run": False}
        assert pg.execute_calls == []

    async def test_query_excludes_resolved_dead_and_already_diagnosed_rows(self) -> None:
        """Never touches a row that has resolved, is already dead, or
        already carries a real error_message from the post-fix path."""
        pg = _CleanupFakePg([])
        await drain.mark_obsolete_pre_fix_rows_dead(pg, dry_run=True)

        query, args = pg.fetch_calls[0]
        assert "resolved_at IS NULL" in query
        assert "dead_at IS NULL" in query
        assert "error_message IS NULL" in query
        assert "failed_at < $1" in query

    async def test_never_touches_telemetry_events(self) -> None:
        """The Postgres source-of-truth table must not appear anywhere
        in the statements this helper issues."""
        pg = _CleanupFakePg([_obsolete_row()])
        await drain.mark_obsolete_pre_fix_rows_dead(pg, dry_run=False)

        for query, _args in pg.fetch_calls + pg.execute_calls:
            assert "telemetry_events" not in query

    async def test_custom_cutoff_is_forwarded(self) -> None:
        from datetime import UTC, datetime

        pg = _CleanupFakePg([])
        custom_cutoff = datetime(2026, 6, 1, tzinfo=UTC)
        await drain.mark_obsolete_pre_fix_rows_dead(pg, cutoff=custom_cutoff, dry_run=True)

        _query, args = pg.fetch_calls[0]
        assert args[0] == custom_cutoff


# ── real Postgres: the SQL itself ────────────────────────────────────────


@pytest.mark.realdb
@pytest.mark.skipif(not PG_DSN, reason="set EDEN_TEST_PG_DSN to run")
class TestAgainstPostgres:
    """Exercise the statements, not a mock's canned answers.

    A mock cannot tell you that the backoff interval arithmetic is right,
    that ``dead_at`` flips at exactly ``_MAX_ATTEMPTS``, or that the purge
    predicate spares live rows. Each of those is a real query here.
    """

    @pytest.fixture()
    async def pg(self) -> Any:
        import asyncpg

        conn = await asyncpg.connect(PG_DSN)

        class Adapter:
            async def fetch(self, q: str, *a: Any) -> list[dict[str, Any]]:
                return [dict(r) for r in await conn.fetch(q, *a)]

            async def execute(self, q: str, *a: Any) -> str:
                return await conn.execute(q, *a)

        await conn.execute("TRUNCATE clickhouse_fallback")
        try:
            yield Adapter()
        finally:
            await conn.execute("TRUNCATE clickhouse_fallback")
            await conn.close()

    async def _insert(
        self,
        pg: Any,
        *,
        table: str = "telemetry_events_ch",
        retry_count: int = 0,
        age_seconds: int = 3600,
        last_retry_seconds_ago: int | None = None,
    ) -> Any:
        row = await pg.fetch(
            """
            INSERT INTO clickhouse_fallback
                (target_table, payload, failed_at, retry_count, last_retry_at)
            VALUES ($1, $2::jsonb,
                    NOW() - make_interval(secs => $3),
                    $4,
                    CASE WHEN $5::int IS NULL THEN NULL
                         ELSE NOW() - make_interval(secs => $5::int) END)
            RETURNING id
            """,
            table,
            '{"event_id":"x"}',
            age_seconds,
            retry_count,
            last_retry_seconds_ago,
        )
        return row[0]["id"]

    async def test_a_replayed_row_is_not_selected_again(self, pg: Any) -> None:
        await self._insert(pg)
        with _patch_sink(_fake_sink()):
            first = await drain._run_drain(pg, limit=10)
            second = await drain._run_drain(pg, limit=10)
        assert first["replayed"] == 1
        assert second["claimed"] == 0, "a resolved row must leave the queue"

    async def test_a_row_is_abandoned_after_max_attempts(self, pg: Any) -> None:
        """The ceiling is real: the row goes terminal and stops being read."""
        rid = await self._insert(pg, retry_count=drain._MAX_ATTEMPTS - 1)
        with _patch_sink(_fake_sink(fail=True)):
            result = await drain._run_drain(pg, limit=10)

        assert result["gave_up"] == 1
        state = await pg.fetch(
            "SELECT retry_count, dead_at, last_retry_at, error_message "
            "FROM clickhouse_fallback WHERE id = $1",
            rid,
        )
        assert state[0]["retry_count"] == drain._MAX_ATTEMPTS
        assert state[0]["dead_at"] is not None
        assert state[0]["last_retry_at"] is not None
        assert "HTTP 500" in state[0]["error_message"]

        with _patch_sink(_fake_sink(fail=True)):
            again = await drain._run_drain(pg, limit=10)
        assert again["claimed"] == 0, (
            "a dead row must not be re-read, or it starves the oldest-first "
            "queue behind it forever"
        )

    async def test_a_row_below_the_ceiling_stays_retryable(self, pg: Any) -> None:
        rid = await self._insert(pg, retry_count=0)
        with _patch_sink(_fake_sink(fail=True)):
            result = await drain._run_drain(pg, limit=10)
        assert result["gave_up"] == 0
        state = await pg.fetch(
            "SELECT retry_count, dead_at FROM clickhouse_fallback WHERE id = $1", rid
        )
        assert state[0]["retry_count"] == 1
        assert state[0]["dead_at"] is None

    async def test_backoff_hides_a_row_that_was_just_tried(self, pg: Any) -> None:
        """retry_count=3 means ~8 minutes; a 1-minute-old attempt is too soon."""
        await self._insert(pg, retry_count=3, last_retry_seconds_ago=60)
        with _patch_sink(_fake_sink()):
            result = await drain._run_drain(pg, limit=10)
        assert result["claimed"] == 0

    async def test_backoff_releases_a_row_once_the_interval_has_passed(
        self, pg: Any
    ) -> None:
        await self._insert(pg, retry_count=3, last_retry_seconds_ago=15 * 60)
        with _patch_sink(_fake_sink()):
            result = await drain._run_drain(pg, limit=10)
        assert result["claimed"] == 1

    async def test_the_backoff_is_capped(self, pg: Any) -> None:
        """Without a cap, 2^30 minutes is longer than the heat death."""
        await self._insert(
            pg,
            retry_count=30,
            last_retry_seconds_ago=(drain._BACKOFF_CAP_MINUTES + 5) * 60,
        )
        with _patch_sink(_fake_sink()):
            result = await drain._run_drain(pg, limit=10)
        assert result["claimed"] == 1

    async def test_oldest_rows_are_drained_first(self, pg: Any) -> None:
        newest = await self._insert(pg, age_seconds=10)
        oldest = await self._insert(pg, age_seconds=99_999)
        sink = _fake_sink()
        with _patch_sink(sink):
            await drain._run_drain(pg, limit=1)
        resolved = await pg.fetch(
            "SELECT id FROM clickhouse_fallback WHERE resolved_at IS NOT NULL"
        )
        assert [r["id"] for r in resolved] == [oldest]
        assert newest not in [r["id"] for r in resolved]

    async def test_the_limit_bounds_the_batch(self, pg: Any) -> None:
        for _ in range(7):
            await self._insert(pg)
        with _patch_sink(_fake_sink()):
            result = await drain._run_drain(pg, limit=3)
        assert result["claimed"] == 3

    async def test_purge_removes_settled_rows_and_spares_live_ones(
        self, pg: Any
    ) -> None:
        live = await self._insert(pg)
        old_resolved = await self._insert(pg)
        await pg.execute(
            "UPDATE clickhouse_fallback SET resolved_at = NOW() - make_interval("
            "days => $2) WHERE id = $1",
            old_resolved,
            drain._PURGE_RESOLVED_AFTER_DAYS + 1,
        )
        recent_resolved = await self._insert(pg)
        await pg.execute(
            "UPDATE clickhouse_fallback SET resolved_at = NOW() WHERE id = $1",
            recent_resolved,
        )
        old_dead = await self._insert(pg)
        await pg.execute(
            "UPDATE clickhouse_fallback SET dead_at = NOW() - make_interval("
            "days => $2) WHERE id = $1",
            old_dead,
            drain._PURGE_DEAD_AFTER_DAYS + 1,
        )

        await drain._purge_settled(pg)
        left = {
            r["id"]
            for r in await pg.fetch("SELECT id FROM clickhouse_fallback")
        }
        assert live in left
        assert recent_resolved in left
        assert old_resolved not in left
        assert old_dead not in left

    async def test_the_drain_query_uses_the_partial_index(self, pg: Any) -> None:
        """Migration 125's index, or the drain sorts the whole backlog."""
        for _ in range(50):
            await self._insert(pg)
        await pg.execute("ANALYZE clickhouse_fallback")
        plan = await pg.fetch(
            """
            EXPLAIN
            SELECT id, target_table, payload, retry_count
              FROM clickhouse_fallback
             WHERE resolved_at IS NULL AND dead_at IS NULL
               AND (last_retry_at IS NULL
                    OR last_retry_at < NOW() - make_interval(
                        mins => LEAST($1 * POWER(2, retry_count), $2)::int))
             ORDER BY failed_at
             LIMIT 10
            """,
            drain._BACKOFF_BASE_MINUTES,
            drain._BACKOFF_CAP_MINUTES,
        )
        text = "\n".join(str(r["QUERY PLAN"]) for r in plan)
        assert "idx_clickhouse_fallback_drain" in text, text
        assert "Sort" not in text, f"the index must supply the ordering:\n{text}"
