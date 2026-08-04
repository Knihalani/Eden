"""N12 session rollup + timeline — live-Postgres tests.

Runs against the real dev database (migration 142 applied), same
opt-in pattern as ``tests/integration/compression/test_zstd_columns.py``:
``Settings()`` is read directly (bypassing the autouse ``patch_settings``
redirect) and the whole module skips when Postgres is unreachable.

Every test works inside its own throwaway org id and deletes its rows
afterwards, so reruns are clean and nothing leaks into real data. The
asyncpg connection is injected straight into the indexer / read
functions (they accept ``client=``) — the SQL that runs here is
byte-for-byte the SQL production runs.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest

from eden.sessions.rollup import SessionRollupIndexer
from eden.sessions.timeline import (
    IssueNotFoundError,
    SessionNotFoundError,
    get_session_timeline,
    link_issue,
    list_sessions,
)

# Old enough that the read side's "live" recency overlay never fires.
BASE_TS = datetime.now(UTC) - timedelta(hours=2)


async def _try_connect() -> asyncpg.Connection | None:
    from eden.config import Settings

    s = Settings()
    try:
        return await asyncio.wait_for(
            asyncpg.connect(
                host=s.postgres_host,
                port=s.postgres_port,
                user=s.postgres_user,
                password=s.postgres_password,
                database=s.postgres_db,
            ),
            timeout=3.0,
        )
    except Exception:
        return None


@pytest.fixture
async def pg_conn():
    conn = await _try_connect()
    if conn is None:
        pytest.skip("Postgres test database is not reachable")
    has_table = await conn.fetchval(
        "SELECT to_regclass('session_summaries') IS NOT NULL"
    )
    if not has_table:
        pytest.skip("session_summaries missing — run `alembic upgrade head`")
    yield conn
    await conn.close()


@pytest.fixture
async def org(pg_conn: asyncpg.Connection):
    org_id = f"org-n12-test-{uuid.uuid4().hex[:12]}"
    yield org_id
    for sql in (
        "DELETE FROM session_summaries WHERE org_id = $1",
        "DELETE FROM agent_stumbles WHERE org_id = $1",
        "DELETE FROM agent_issues WHERE org_id = $1",
        "DELETE FROM telemetry_events WHERE tenant_id = $1",
    ):
        await pg_conn.execute(sql, org_id)


async def _insert_event(
    conn: asyncpg.Connection,
    *,
    org_id: str,
    trace_id: str,
    session_id: str | None,
    ts: datetime,
    cost_usd: float | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    name: str | None = None,
    duration_ms: float | None = None,
    outcome: str | None = None,
    error_type: str | None = None,
    agent_id: str | None = None,
    attributes: dict | None = None,
) -> None:
    payload: dict = {}
    if input_tokens is not None:
        payload["input_tokens"] = input_tokens
    if output_tokens is not None:
        payload["output_tokens"] = output_tokens
    metrics = {"cost_usd": cost_usd} if cost_usd is not None else {}
    await conn.execute(
        """
        INSERT INTO telemetry_events (
            event_id, tenant_id, project_id, trace_id, realm, event_type,
            timestamp, session_id, agent_id, name, duration_ms,
            payload, metrics, attributes, outcome, error_type
        ) VALUES (
            $1, $2, 'proj-n12', $3, 'production', 'span.end',
            $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        )
        """,
        f"ev-{uuid.uuid4().hex}",
        org_id,
        trace_id,
        ts,
        session_id,
        agent_id,
        name,
        duration_ms,
        json.dumps(payload),
        json.dumps(metrics),
        json.dumps(attributes or {}),
        outcome,
        error_type,
    )


async def _insert_stumble(
    conn: asyncpg.Connection,
    *,
    org_id: str,
    trace_id: str,
    session_id: str,
    kind: str = "loop",
    fingerprint: str | None = None,
) -> None:
    await conn.execute(
        """
        INSERT INTO agent_stumbles (
            org_id, trace_id, session_id, kind, fingerprint,
            title, detail, severity, detected_by
        ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 'p2', 'test')
        """,
        org_id,
        trace_id,
        session_id,
        kind,
        fingerprint or f"fp-{uuid.uuid4().hex[:16]}",
        f"test stumble {kind}",
    )


async def _insert_issue(
    conn: asyncpg.Connection, *, org_id: str, fingerprint: str | None = None
) -> str:
    return str(
        await conn.fetchval(
            """
            INSERT INTO agent_issues (org_id, fingerprint, kind, title, severity)
            VALUES ($1, $2, 'loop', 'test issue', 'p2')
            RETURNING id
            """,
            org_id,
            fingerprint or f"fp-{uuid.uuid4().hex[:16]}",
        )
    )


async def _seed_turn(
    conn: asyncpg.Connection,
    org_id: str,
    session_id: str,
    turn: int,
    *,
    cost_usd: float,
    agent_id: str = "agent-1",
) -> str:
    """One trace = one turn: two events, staggered by turn index."""
    trace_id = f"trace-{session_id}-{turn}"
    start = BASE_TS + timedelta(minutes=turn * 5)
    await _insert_event(
        conn,
        org_id=org_id,
        trace_id=trace_id,
        session_id=session_id,
        ts=start,
        name=f"turn {turn} request",
        agent_id=agent_id,
    )
    await _insert_event(
        conn,
        org_id=org_id,
        trace_id=trace_id,
        session_id=session_id,
        ts=start + timedelta(seconds=30),
        cost_usd=cost_usd,
        input_tokens=100 * turn,
        output_tokens=10 * turn,
        duration_ms=1000.0 + turn,
        outcome="success",
    )
    return trace_id


class TestRollupIdempotency:
    async def test_same_trace_finalized_twice_counts_one_turn(
        self, pg_conn, org
    ) -> None:
        session_id = f"sess-{uuid.uuid4().hex[:10]}"
        await _seed_turn(pg_conn, org, session_id, 1, cost_usd=0.02)
        indexer = SessionRollupIndexer(client=pg_conn)

        assert await indexer.index_trace(org, f"trace-{session_id}-1") is True
        # Redelivery of the same trace.finalized message.
        assert await indexer.index_trace(org, f"trace-{session_id}-1") is True

        row = await pg_conn.fetchrow(
            "SELECT * FROM session_summaries WHERE org_id=$1 AND session_id=$2",
            org,
            session_id,
        )
        assert row["turn_count"] == 1
        assert list(row["trace_ids"]) == [f"trace-{session_id}-1"]
        assert row["total_cost_usd"] == pytest.approx(0.02)
        assert row["total_input_tokens"] == 100
        assert row["total_output_tokens"] == 10

    async def test_sessionless_trace_is_skipped(self, pg_conn, org) -> None:
        await _insert_event(
            pg_conn,
            org_id=org,
            trace_id="trace-no-session",
            session_id=None,
            ts=BASE_TS,
        )
        indexer = SessionRollupIndexer(client=pg_conn)
        assert await indexer.index_trace(org, "trace-no-session") is False
        count = await pg_conn.fetchval(
            "SELECT count(*) FROM session_summaries WHERE org_id = $1", org
        )
        assert count == 0

    async def test_session_id_resolved_from_attributes(self, pg_conn, org) -> None:
        """Older SDK rows: session_id only inside attributes JSON."""
        session_id = f"sess-{uuid.uuid4().hex[:10]}"
        await _insert_event(
            pg_conn,
            org_id=org,
            trace_id="trace-attr-only",
            session_id=None,
            ts=BASE_TS,
            cost_usd=0.01,
            attributes={"session_id": session_id},
        )
        indexer = SessionRollupIndexer(client=pg_conn)
        assert await indexer.index_trace(org, "trace-attr-only") is True
        row = await pg_conn.fetchrow(
            "SELECT * FROM session_summaries WHERE org_id=$1 AND session_id=$2",
            org,
            session_id,
        )
        assert row is not None and row["turn_count"] == 1


class TestFiveTurnSession:
    async def test_ordering_cost_sum_and_stumble_badge(self, pg_conn, org) -> None:
        session_id = f"sess-{uuid.uuid4().hex[:10]}"
        costs = [0.01, 0.02, 0.03, 0.04, 0.05]
        trace_ids = []
        for turn, cost in enumerate(costs, start=1):
            trace_ids.append(
                await _seed_turn(pg_conn, org, session_id, turn, cost_usd=cost)
            )
        # Stumble on turn 3 only (spec §10: badge on card 3, no other).
        await _insert_stumble(
            pg_conn, org_id=org, trace_id=trace_ids[2], session_id=session_id
        )

        indexer = SessionRollupIndexer(client=pg_conn)
        # Traces finalize one by one, out of order — the recompute must
        # converge on the same row regardless of delivery order.
        for tid in [trace_ids[3], trace_ids[0], trace_ids[4], trace_ids[1], trace_ids[2]]:
            await indexer.index_trace(org, tid)

        row = await pg_conn.fetchrow(
            "SELECT * FROM session_summaries WHERE org_id=$1 AND session_id=$2",
            org,
            session_id,
        )
        assert row["turn_count"] == 5
        assert list(row["trace_ids"]) == trace_ids  # chronological order
        assert row["total_cost_usd"] == pytest.approx(sum(costs))
        assert row["total_input_tokens"] == 100 * (1 + 2 + 3 + 4 + 5)
        assert row["had_stumble"] is True
        assert row["stumble_count"] == 1
        assert list(row["stumble_turn_indices"]) == [3]
        assert row["outcome"] == "success"
        assert row["session_start"] == BASE_TS + timedelta(minutes=5)
        assert row["session_end"] == BASE_TS + timedelta(minutes=25, seconds=30)

        timeline = await get_session_timeline(org, session_id, client=pg_conn)
        assert timeline["turn_count"] == 5
        assert [t["index"] for t in timeline["turns"]] == [1, 2, 3, 4, 5]
        assert [t["trace_id"] for t in timeline["turns"]] == trace_ids
        assert [t["had_stumble"] for t in timeline["turns"]] == [
            False, False, True, False, False,
        ]
        assert timeline["turns"][2]["stumble_kinds"] == ["loop"]
        assert timeline["turns"][0]["summary"] == "turn 1 request"
        assert timeline["turns"][0]["cost_usd"] == pytest.approx(0.01)
        header_cost = timeline["summary"]["total_cost_usd"]
        assert header_cost == pytest.approx(
            sum(t["cost_usd"] for t in timeline["turns"])
        )

    async def test_failed_last_turn_marks_session_fail(self, pg_conn, org) -> None:
        session_id = f"sess-{uuid.uuid4().hex[:10]}"
        await _seed_turn(pg_conn, org, session_id, 1, cost_usd=0.01)
        await _insert_event(
            pg_conn,
            org_id=org,
            trace_id=f"trace-{session_id}-2",
            session_id=session_id,
            ts=BASE_TS + timedelta(minutes=10),
            outcome="error",
            error_type="ToolError",
        )
        indexer = SessionRollupIndexer(client=pg_conn)
        await indexer.index_trace(org, f"trace-{session_id}-2")
        outcome = await pg_conn.fetchval(
            "SELECT outcome FROM session_summaries "
            "WHERE org_id=$1 AND session_id=$2",
            org,
            session_id,
        )
        assert outcome == "fail"


class TestListFilters:
    async def _seed_two_sessions(self, pg_conn, org) -> tuple[str, str]:
        cheap = f"sess-cheap-{uuid.uuid4().hex[:8]}"
        pricey = f"sess-pricey-{uuid.uuid4().hex[:8]}"
        indexer = SessionRollupIndexer(client=pg_conn)
        t1 = await _seed_turn(
            pg_conn, org, cheap, 1, cost_usd=0.01, agent_id="agent-a"
        )
        t2 = await _seed_turn(
            pg_conn, org, pricey, 8, cost_usd=5.0, agent_id="agent-b"
        )
        await _insert_stumble(
            pg_conn, org_id=org, trace_id=t2, session_id=pricey
        )
        await indexer.index_trace(org, t1)
        await indexer.index_trace(org, t2)
        return cheap, pricey

    async def test_agent_stumble_cost_and_since_filters(self, pg_conn, org) -> None:
        cheap, pricey = await self._seed_two_sessions(pg_conn, org)

        both = await list_sessions(org, client=pg_conn)
        assert {s["session_id"] for s in both["sessions"]} == {cheap, pricey}
        assert both["total"] == 2
        # Recency-ordered: pricey (turn 8) is newer than cheap (turn 1).
        assert both["sessions"][0]["session_id"] == pricey

        by_agent = await list_sessions(org, agent_id="agent-a", client=pg_conn)
        assert [s["session_id"] for s in by_agent["sessions"]] == [cheap]

        stumbled = await list_sessions(org, had_stumble=True, client=pg_conn)
        assert [s["session_id"] for s in stumbled["sessions"]] == [pricey]

        clean = await list_sessions(org, had_stumble=False, client=pg_conn)
        assert [s["session_id"] for s in clean["sessions"]] == [cheap]

        expensive = await list_sessions(org, min_cost=1.0, client=pg_conn)
        assert [s["session_id"] for s in expensive["sessions"]] == [pricey]

        recent = await list_sessions(
            org, since=BASE_TS + timedelta(minutes=20), client=pg_conn
        )
        assert [s["session_id"] for s in recent["sessions"]] == [pricey]

        page = await list_sessions(org, limit=1, offset=0, client=pg_conn)
        assert len(page["sessions"]) == 1 and page["total"] == 2


class TestLinkIssue:
    async def test_link_and_org_scoping(self, pg_conn, org) -> None:
        session_id = f"sess-{uuid.uuid4().hex[:10]}"
        trace = await _seed_turn(pg_conn, org, session_id, 1, cost_usd=0.01)
        await SessionRollupIndexer(client=pg_conn).index_trace(org, trace)

        own_issue = await _insert_issue(pg_conn, org_id=org)
        result = await link_issue(org, session_id, own_issue, client=pg_conn)
        assert result["linked_issue_id"] == own_issue
        stored = await pg_conn.fetchval(
            "SELECT linked_issue_id::text FROM session_summaries "
            "WHERE org_id=$1 AND session_id=$2",
            org,
            session_id,
        )
        assert stored == own_issue

        # Another org's issue must read as not-found, not link.
        other_org = f"{org}-other"
        foreign_issue = await _insert_issue(pg_conn, org_id=other_org)
        try:
            with pytest.raises(IssueNotFoundError):
                await link_issue(org, session_id, foreign_issue, client=pg_conn)
        finally:
            await pg_conn.execute(
                "DELETE FROM agent_issues WHERE org_id = $1", other_org
            )

        with pytest.raises(IssueNotFoundError):
            await link_issue(org, session_id, "not-a-uuid", client=pg_conn)

        with pytest.raises(SessionNotFoundError):
            await link_issue(org, "no-such-session", own_issue, client=pg_conn)

    async def test_timeline_unknown_session_raises(self, pg_conn, org) -> None:
        with pytest.raises(SessionNotFoundError):
            await get_session_timeline(org, "missing", client=pg_conn)

    async def test_rollup_preserves_linked_issue(self, pg_conn, org) -> None:
        """A later trace.finalized recompute must not clear the link."""
        session_id = f"sess-{uuid.uuid4().hex[:10]}"
        trace = await _seed_turn(pg_conn, org, session_id, 1, cost_usd=0.01)
        indexer = SessionRollupIndexer(client=pg_conn)
        await indexer.index_trace(org, trace)
        issue = await _insert_issue(pg_conn, org_id=org)
        await link_issue(org, session_id, issue, client=pg_conn)

        await _seed_turn(pg_conn, org, session_id, 2, cost_usd=0.02)
        await indexer.index_trace(org, f"trace-{session_id}-2")

        row = await pg_conn.fetchrow(
            "SELECT linked_issue_id::text AS li, turn_count "
            "FROM session_summaries WHERE org_id=$1 AND session_id=$2",
            org,
            session_id,
        )
        assert row["turn_count"] == 2
        assert row["li"] == issue
