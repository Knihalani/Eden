"""A6 B7 — live_tail idle backoff + reused Postgres client."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestB7LiveTailBackoff:
    def test_poll_max_greater_than_base(self) -> None:
        from eden.observability.live_tail import service as lt

        assert lt.POLL_INTERVAL_S == 1.0
        assert lt.POLL_INTERVAL_MAX_S >= 5.0
        assert lt.POLL_INTERVAL_MAX_S > lt.POLL_INTERVAL_S

    def test_stream_reuses_client_helper(self) -> None:
        from eden.observability.live_tail.service import LiveTailService

        source = inspect.getsource(LiveTailService.stream)
        assert "_get_pg_client" in source
        assert "idle_interval" in source
        assert "_idle_wait" in source
        # Must not call get_postgres_client inside the poll loop body.
        # The helper is acquired once before the while True.
        assert source.index("_get_pg_client") < source.index("while True")

    def test_fetch_helpers_accept_client_kwarg(self) -> None:
        from eden.observability.live_tail import service as lt

        sig_latest = inspect.signature(lt._fetch_latest_timestamp)
        sig_after = inspect.signature(lt._fetch_events_after)
        assert "client" in sig_latest.parameters
        assert "client" in sig_after.parameters

    @pytest.mark.asyncio
    async def test_fetch_events_after_reuses_passed_client(self) -> None:
        from eden.observability.live_tail.service import _fetch_events_after

        client = MagicMock()
        client.fetch = AsyncMock(return_value=[])

        with patch(
            "eden.observability.live_tail.service._get_pg_client",
            new=AsyncMock(side_effect=AssertionError("must reuse client")),
        ):
            rows = await _fetch_events_after(
                "org-1",
                after_timestamp="2026-01-01",
                client=client,
            )

        assert rows == []
        client.fetch.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_idle_wait_sleeps_without_pubsub(self) -> None:
        from eden.observability.live_tail.service import _idle_wait

        sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        with patch(
            "eden.observability.live_tail.service.asyncio.sleep",
            new=fake_sleep,
        ):
            await _idle_wait(None, 4.0)

        assert sleeps == [4.0]


class TestPhase5SummaryProjection:
    """Poll path selects a summary projection by default; full detail
    (payload/metrics/attributes) is opt-in (``full=True``) or fetched
    per-row via ``_fetch_event_detail`` / ``LiveTailService.fetch_detail``."""

    @pytest.mark.asyncio
    async def test_default_query_excludes_jsonb_blob_columns(self) -> None:
        from eden.observability.live_tail.service import _fetch_events_after

        client = MagicMock()
        client.fetch = AsyncMock(return_value=[])

        await _fetch_events_after(
            "org-1", after_timestamp=None, client=client
        )

        query = client.fetch.await_args.args[0]
        for blob_col in ("payload", "metrics", "attributes"):
            assert blob_col not in query, (
                f"summary projection must not select {blob_col}"
            )
        # Summary columns the live-tail row list actually renders.
        for col in ("event_id", "name", "event_type", "outcome",
                    "duration_ms", "model", "tags", "timestamp",
                    "created_at"):
            assert col in query

    @pytest.mark.asyncio
    async def test_no_query_ever_selects_nonexistent_error_column(self) -> None:
        """Regression: the old query selected ``error``, which has never
        existed on ``telemetry_events`` (see migration 009) — every poll
        raised UndefinedColumn, silently swallowed as an empty batch."""
        from eden.observability.live_tail.service import (
            _FULL_COLUMNS,
            _SUMMARY_COLUMNS,
        )

        for columns in (_SUMMARY_COLUMNS, _FULL_COLUMNS):
            names = {c.strip() for c in columns.split(",")}
            assert "error" not in names

    @pytest.mark.asyncio
    async def test_full_true_includes_jsonb_blob_columns(self) -> None:
        from eden.observability.live_tail.service import _fetch_events_after

        client = MagicMock()
        client.fetch = AsyncMock(return_value=[])

        await _fetch_events_after(
            "org-1", after_timestamp=None, client=client, full=True
        )

        query = client.fetch.await_args.args[0]
        for blob_col in ("payload", "metrics", "attributes"):
            assert blob_col in query

    @pytest.mark.asyncio
    async def test_stream_passes_full_flag_through(self) -> None:
        from eden.observability.live_tail.service import LiveTailService

        svc = LiveTailService()
        seen_full: list[bool] = []

        async def fake_fetch_events_after(*_a: object, **kw: object) -> list:
            seen_full.append(bool(kw.get("full")))
            return []

        with (
            patch(
                "eden.observability.live_tail.service._get_pg_client",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "eden.observability.live_tail.service._fetch_latest_timestamp",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "eden.observability.live_tail.service._subscribe_obs_stream",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "eden.observability.live_tail.service._fetch_events_after",
                new=fake_fetch_events_after,
            ),
        ):
            gen = svc.stream("org-1", full=True)
            await gen.__anext__()  # initial heartbeat
            # The loop keeps polling + backing off indefinitely while
            # empty (real ``asyncio.sleep`` between polls) — bound the
            # wait rather than consuming a second item, which would
            # otherwise block for the full idle-backoff sleep.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(gen.__anext__(), timeout=0.2)
            await gen.aclose()

        assert seen_full and seen_full[0] is True

    @pytest.mark.asyncio
    async def test_fetch_detail_returns_none_for_missing_event(self) -> None:
        from eden.observability.live_tail.service import LiveTailService

        svc = LiveTailService()
        with patch(
            "eden.observability.live_tail.service._fetch_event_detail",
            new=AsyncMock(return_value=None),
        ):
            result = await svc.fetch_detail("org-1", "ev-missing")

        assert result is None

    @pytest.mark.asyncio
    async def test_fetch_detail_serialises_row(self) -> None:
        from eden.observability.live_tail.service import LiveTailService

        svc = LiveTailService()
        row = {
            "event_id": "ev-1",
            "tenant_id": "org-1",
            "payload": {"foo": "bar"},
        }
        with patch(
            "eden.observability.live_tail.service._fetch_event_detail",
            new=AsyncMock(return_value=row),
        ):
            result = await svc.fetch_detail("org-1", "ev-1")

        assert result is not None
        assert result["event_id"] == "ev-1"
        assert result["payload"] == {"foo": "bar"}
        # serialise_event drops tenant_id (caller already scoped by it).
        assert "tenant_id" not in result
