"""A6 realtime optimisations — K29/K30 job WebSocket helpers."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestK30CodeFragmentTruncate:
    def test_short_code_unchanged(self) -> None:
        from eden.api.routes.websocket import _truncate_code_fragment

        assert _truncate_code_fragment("hello") == "hello"

    def test_truncates_over_32kib(self) -> None:
        from eden.api.routes.websocket import (
            _CODE_FRAGMENT_MAX_BYTES,
            _truncate_code_fragment,
        )

        huge = "x" * (_CODE_FRAGMENT_MAX_BYTES + 5000)
        out = _truncate_code_fragment(huge)
        assert len(out.encode("utf-8")) <= _CODE_FRAGMENT_MAX_BYTES
        assert out.startswith("x")

    def test_empty_and_non_str(self) -> None:
        from eden.api.routes.websocket import _truncate_code_fragment

        assert _truncate_code_fragment("") == ""
        assert _truncate_code_fragment(None) == ""  # type: ignore[arg-type]


class TestK29IdleWake:
    @pytest.mark.asyncio
    async def test_wake_timeout_at_least_10s_without_redis(self) -> None:
        """Without Redis, wait sleeps the full timeout (≥10s contract)."""
        from eden.api.routes.websocket import _wait_for_job_wake

        sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        with patch(
            "eden.api.routes.websocket.get_redis_client",
            new=AsyncMock(return_value=None),
        ):
            with patch(
                "eden.api.routes.websocket.asyncio.sleep",
                new=fake_sleep,
            ):
                woken = await _wait_for_job_wake("job-1", timeout=10.0)

        assert woken is False
        assert sleeps == [10.0]

    @pytest.mark.asyncio
    async def test_timeout_floor_is_10s(self) -> None:
        """Callers cannot request a sub-10s idle poll."""
        from eden.api.routes.websocket import _wait_for_job_wake

        sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        with patch(
            "eden.api.routes.websocket.get_redis_client",
            new=AsyncMock(return_value=None),
        ):
            with patch(
                "eden.api.routes.websocket.asyncio.sleep",
                new=fake_sleep,
            ):
                await _wait_for_job_wake("job-1", timeout=2.0)

        assert sleeps == [10.0]

    @pytest.mark.asyncio
    async def test_no_2s_sleep_in_trace_loop_source(self) -> None:
        """Regression: the 2s PG poll loop must not return."""
        import inspect

        from eden.api.routes import websocket as ws_mod

        source = inspect.getsource(ws_mod.job_trace_websocket)
        assert "asyncio.sleep(2)" not in source
        assert "_wait_for_job_wake" in source
        assert "get_checkpoint_blobs" not in source
        assert "_fetch_blobs_after" in source
        assert "_truncate_code_fragment" in source


class TestK29PublishJobEvent:
    @pytest.mark.asyncio
    async def test_publish_uses_job_channel(self) -> None:
        from eden.api.routes.websocket import (
            job_event_channel,
            publish_job_event,
        )

        fake_redis = MagicMock()
        fake_redis.publish = AsyncMock(return_value=1)

        with patch(
            "eden.api.routes.websocket.get_redis_client",
            new=AsyncMock(return_value=fake_redis),
        ):
            await publish_job_event("job-xyz", {"status": "running"})

        fake_redis.publish.assert_awaited_once()
        channel, body = fake_redis.publish.await_args.args
        assert channel == job_event_channel("job-xyz")
        assert "running" in body

    @pytest.mark.asyncio
    async def test_publish_noop_without_redis(self) -> None:
        from eden.api.routes.websocket import publish_job_event

        with patch(
            "eden.api.routes.websocket.get_redis_client",
            new=AsyncMock(return_value=None),
        ):
            await publish_job_event("job-xyz")  # must not raise
