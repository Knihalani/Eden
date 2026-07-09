"""Regression tests for the ``record_stream_chunks`` Postgres-availability
distinction.

Background
-----------
``TelemetryCollector.record_stream_chunks`` previously caught
every exception (including asyncpg's connection errors) and
silently returned ``accepted=0, rejected=len(rows)``. From the
SDK's perspective that's indistinguishable from "all chunks were
malformed" — so the SDK stops retrying, and the chunks vanish on
every DB blip.

The fix distinguishes:

* **DB-unavailable errors** (asyncpg connection / interface
  errors, ``ConnectionError``, ``OSError``) — re-raise as
  :class:`eden.observability.errors.IngestionUnavailable` so the
  route returns 503 + ``Retry-After`` and the SDK retries.

* **Constraint / type errors** (rare, e.g. schema drift) — keep
  the existing "rejected=N" shape so the SDK doesn't try to retry
  permanently bad data.

The route's catch-all was tightened to use ``safe_detail`` for any
non-``IngestionUnavailable`` exception so internal-error text
(``asyncpg.UniqueViolationError: duplicate key value violates
unique constraint "telemetry_stream_chunks_pkey"`` etc.) never
reaches the client.

See FIXES_LOG F55.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.observability.errors import IngestionUnavailable
from eden.observability.telemetry_collector import TelemetryCollector


def _chunks(n: int = 1) -> list[dict]:
    """Build a minimal valid chunk list of size ``n``."""
    out = []
    for i in range(n):
        out.append({
            "event_id": f"00000000-0000-0000-0000-{i:012d}",
            "trace_id": f"00000000-0000-0000-0000-{i:012d}",
            "chunk_index": i,
            "delta_text": "hi",
        })
    return out


@pytest.mark.asyncio
async def test_db_connection_error_raises_ingestion_unavailable() -> None:
    """A Postgres connection error propagates as ``IngestionUnavailable``."""
    import asyncpg

    tc = TelemetryCollector()
    fake_client = MagicMock()

    async def _raise_executemany(*args, **kwargs):
        raise asyncpg.exceptions.PostgresConnectionError("connection refused")

    fake_client.executemany = _raise_executemany
    fake_client.acquire = MagicMock()

    with patch.object(tc, "_get_postgres", return_value=fake_client):
        with pytest.raises(IngestionUnavailable):
            await tc.record_stream_chunks(
                "00000000-0000-0000-0000-000000000001",
                _chunks(3),
            )


@pytest.mark.asyncio
async def test_interface_error_raises_ingestion_unavailable() -> None:
    """asyncpg ``InterfaceError`` (connection broken mid-call) propagates."""
    import asyncpg

    tc = TelemetryCollector()
    fake_client = MagicMock()

    async def _raise(*args, **kwargs):
        raise asyncpg.exceptions.InterfaceError("connection is closed")

    fake_client.executemany = _raise

    with patch.object(tc, "_get_postgres", return_value=fake_client):
        with pytest.raises(IngestionUnavailable):
            await tc.record_stream_chunks(
                "00000000-0000-0000-0000-000000000001",
                _chunks(1),
            )


@pytest.mark.asyncio
async def test_cannot_connect_now_raises_ingestion_unavailable() -> None:
    """asyncpg ``CannotConnectNowError`` (server starting up) propagates."""
    import asyncpg

    tc = TelemetryCollector()
    fake_client = MagicMock()

    async def _raise(*args, **kwargs):
        raise asyncpg.exceptions.CannotConnectNowError("starting up")

    fake_client.executemany = _raise

    with patch.object(tc, "_get_postgres", return_value=fake_client):
        with pytest.raises(IngestionUnavailable):
            await tc.record_stream_chunks(
                "00000000-0000-0000-0000-000000000001",
                _chunks(1),
            )


@pytest.mark.asyncio
async def test_oserror_raises_ingestion_unavailable() -> None:
    """``OSError`` (DNS / socket) propagates."""
    tc = TelemetryCollector()
    fake_client = MagicMock()

    async def _raise(*args, **kwargs):
        raise OSError("Name or service not known")

    fake_client.executemany = _raise

    with patch.object(tc, "_get_postgres", return_value=fake_client):
        with pytest.raises(IngestionUnavailable):
            await tc.record_stream_chunks(
                "00000000-0000-0000-0000-000000000001",
                _chunks(1),
            )


@pytest.mark.asyncio
async def test_non_connection_error_is_swallowed_as_rejected() -> None:
    """A ``UniqueViolationError`` (e.g. schema drift) is NOT re-raised —
    the rows are counted as rejected so the SDK doesn't retry.
    """
    import asyncpg

    tc = TelemetryCollector()
    fake_client = MagicMock()

    async def _raise(*args, **kwargs):
        raise asyncpg.exceptions.UniqueViolationError(
            "duplicate key value violates unique constraint"
        )

    fake_client.executemany = _raise

    with patch.object(tc, "_get_postgres", return_value=fake_client):
        # Must NOT raise — the SDK relies on the rejected-shape response.
        result = await tc.record_stream_chunks(
            "00000000-0000-0000-0000-000000000001",
            _chunks(3),
        )

    assert result["accepted"] == 0
    assert result["rejected"] == 3
    assert result["total"] == 3


@pytest.mark.asyncio
async def test_successful_insert_returns_accepted_count() -> None:
    """The happy path still returns ``accepted=len(rows)``."""
    tc = TelemetryCollector()
    fake_client = MagicMock()
    fake_client.executemany = AsyncMock(return_value=None)

    with patch.object(tc, "_get_postgres", return_value=fake_client):
        result = await tc.record_stream_chunks(
            "00000000-0000-0000-0000-000000000001",
            _chunks(5),
        )

    assert result["accepted"] == 5
    assert result["rejected"] == 0
    assert result["deduplicated"] == 0
    assert result["total"] == 5
