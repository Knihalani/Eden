"""F-F (Wave 1) — SelfHealer rollback must target the live canary tables.

Before this fix, ``_execute_rollback`` and ``_capture_before_state``
read/wrote the legacy ``prompt_canaries`` table — which nothing writes
any more. Live canaries live in ``prompt_canary_experiments`` (+
``prompt_version_assignments``, migration 012), so the flagship
"Eden rolls back a bad canary" heal could never find a canary to roll
back.

These tests pin the corrected SQL: capture the statements actually sent
to Postgres and assert they touch the live tables, keyed by the
UUID ``experiment_id``, mirroring :meth:`PromotionLoop._rollback`.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.autonomous import investigation as inv

ORG = "org_ff"


class _RecordingPg:
    """Records every query; fetchrow returns the configured row."""

    def __init__(self, fetchrow_row: dict[str, Any] | None = None) -> None:
        self.execute_calls: list[tuple[str, list[Any]]] = []
        self.fetchrow_calls: list[tuple[str, list[Any]]] = []
        self._fetchrow_row = fetchrow_row

    async def execute(self, sql: str, *args: Any) -> str:
        self.execute_calls.append((sql, list(args)))
        return "OK"

    async def fetchrow(self, sql: str, *args: Any):
        self.fetchrow_calls.append((sql, list(args)))
        return dict(self._fetchrow_row) if self._fetchrow_row else None


def _patch_pg(pg: _RecordingPg):
    return patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=pg),
    )


# ── _execute_rollback ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_execute_rollback_targets_prompt_canary_experiments() -> None:
    """The rollback must end the live experiment + its traffic
    assignment — never the legacy prompt_canaries table."""
    pg = _RecordingPg(fetchrow_row={"status": "active"})
    with _patch_pg(pg):
        after = await inv._execute_rollback(
            ORG,
            {
                "before_state": {
                    "canary": {
                        "experiment_id": "11111111-2222-3333-4444-555555555555",
                        "agent": "planner",
                    }
                }
            },
            {"org_id": ORG, "executed": False},
        )

    assert after["executed"] is True
    sqls = " ".join(sql for sql, _ in pg.execute_calls)
    # Live tables only.
    assert "prompt_version_assignments" in sqls
    assert "prompt_canary_experiments" in sqls
    assert "prompt_canaries" not in sqls
    # Status transition matches PromotionLoop._rollback's shape.
    assert "status = 'rolled_back'" in sqls
    assert "ended_at = NOW()" in sqls
    # Both writes are keyed by the UUID experiment_id (not a legacy int id).
    for _sql, args in pg.execute_calls:
        assert args and "11111111-2222-3333-4444-555555555555" in args
    # Placeholder/arity alignment: every $N in the SQL must have a
    # matching positional arg (this caught the original bug where the
    # assignment UPDATE used $2 with a single arg, which Postgres would
    # reject at runtime — swallowed into rollback_error).
    for sql, args in pg.execute_calls:
        max_ph = max(int(n) for n in __import__("re").findall(r"\$(\d+)", sql))
        assert max_ph <= len(args), f"placeholder > args in: {sql}"
    # The re-check query reads the live table too.
    check_sql, check_args = pg.fetchrow_calls[0]
    assert "FROM prompt_canary_experiments" in check_sql
    assert check_args[0] == ORG


@pytest.mark.asyncio
async def test_execute_rollback_refuses_terminal_state() -> None:
    """A canary already in a terminal state is not rolled back."""
    pg = _RecordingPg(fetchrow_row={"status": "rolled_back"})
    with _patch_pg(pg):
        after = await inv._execute_rollback(
            ORG,
            {
                "before_state": {
                    "canary": {
                        "experiment_id": "11111111-2222-3333-4444-555555555555",
                        "agent": "planner",
                    }
                }
            },
            {"org_id": ORG, "executed": False},
        )

    assert after["executed"] is False
    assert after["failure_reason"] == "canary_terminal_state"
    assert pg.execute_calls == []  # nothing was written


@pytest.mark.asyncio
async def test_execute_rollback_no_canary_is_clean_noop() -> None:
    pg = _RecordingPg()
    with _patch_pg(pg):
        after = await inv._execute_rollback(
            ORG, {"before_state": {}}, {"org_id": ORG, "executed": False}
        )
    assert after["executed"] is False
    assert after["failure_reason"] == "no_active_canary"


# ── _capture_before_state ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_capture_before_state_reads_live_experiment_row() -> None:
    pg = _RecordingPg(
        fetchrow_row={
            "experiment_id": "11111111-2222-3333-4444-555555555555",
            "agent": "planner",
            "control_version": 2,
            "candidate_version": 3,
            "traffic_pct": 5,
            "status": "active",
            "started_at": None,
        }
    )
    with _patch_pg(pg):
        out = await inv._capture_before_state(ORG, "rollback")

    assert out["captured"] is True
    canary = out["canary"]
    assert canary["experiment_id"] == "11111111-2222-3333-4444-555555555555"
    sql, args = pg.fetchrow_calls[0]
    assert "FROM prompt_canary_experiments" in sql
    assert "prompt_canaries" not in sql
    assert args[0] == ORG


@pytest.mark.asyncio
async def test_capture_before_state_no_active_canary() -> None:
    pg = _RecordingPg(fetchrow_row=None)
    with _patch_pg(pg):
        out = await inv._capture_before_state(ORG, "rollback")
    assert out["captured"] is False
    assert out["canary"] is None
    assert "no active canary" in (out.get("note") or "")
