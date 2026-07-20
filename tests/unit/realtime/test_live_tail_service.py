"""A6 B7 — live_tail idle backoff + reused Postgres client."""

from __future__ import annotations

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
