"""_spawn_bg must not inherit the RLS-pinned request connection.

If billing/checkpoint/agent-registration tasks share the pin, asyncpg
raises ``another operation is in progress``, the middleware transaction
aborts, COMMIT fails, and ingest still returns accepted:1 — traces vanish.
"""

from __future__ import annotations

import asyncio

import pytest

from eden.observability.telemetry_collector import TelemetryCollector
from eden.storage.postgres import (
    bind_request_pg_conn,
    get_bound_request_pg_conn,
    reset_request_pg_conn,
)


@pytest.mark.asyncio
async def test_spawn_bg_strips_request_pg_pin() -> None:
    sentinel = object()
    token = bind_request_pg_conn(sentinel)
    seen: dict[str, object | None] = {}

    async def bg() -> None:
        seen["bound"] = get_bound_request_pg_conn()

    try:
        assert get_bound_request_pg_conn() is sentinel
        TelemetryCollector()._spawn_bg(bg())
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert "bound" in seen
        assert seen["bound"] is None
    finally:
        reset_request_pg_conn(token)
