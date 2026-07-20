"""A6 B25 — mobile_sse shared poller (not N×3s PG loops)."""

from __future__ import annotations

import inspect
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_mobile_state():
    from eden.realtime import mobile_sse as mod

    mod.reset_mobile_sse_state()
    yield
    mod.reset_mobile_sse_state()


class TestB25SharedPoller:
    def test_no_per_connection_3s_sleep(self) -> None:
        import eden.realtime.mobile_sse as mod

        source = inspect.getsource(mod)
        assert "asyncio.sleep(3)" not in source
        assert "_shared_poll_job_updates" in source
        assert "_ensure_shared_poller" in source
        assert "_SHARED_POLL_TIMEOUT_S" in source
        assert mod._SHARED_POLL_TIMEOUT_S >= 10.0

    def test_ensure_shared_poller_starts_one_task(self) -> None:
        from eden.realtime import mobile_sse as mod

        user = {"user_id": "u1"}
        with patch.object(
            mod.asyncio,
            "create_task",
            side_effect=lambda coro, name=None: MagicMock(
                done=MagicMock(return_value=False), cancel=MagicMock()
            ),
        ) as create_task:
            # create_task receives a coroutine — close it to avoid warnings
            def _create(coro, name=None):
                coro.close()
                task = MagicMock()
                task.done = MagicMock(return_value=False)
                task.cancel = MagicMock()
                return task

            create_task.side_effect = _create
            mod._ensure_shared_poller("job-a", user)
            mod._ensure_shared_poller("job-a", user)  # second connect

        assert create_task.call_count == 1
        assert "job-a" in mod._shared_pollers

    @pytest.mark.asyncio
    async def test_broadcast_fans_out_to_all_streams(self) -> None:
        from eden.realtime.mobile_sse import (
            MobileSSEStream,
            _mobile_streams,
            broadcast_to_mobile,
        )

        s1 = MobileSSEStream("job-1", {"user_id": "u"}, fields=["status"])
        s2 = MobileSSEStream("job-1", {"user_id": "u"}, fields=["status"])
        _mobile_streams["job-1"] = {s1, s2}

        await broadcast_to_mobile(
            "job-1",
            {
                "event_type": "status",
                "event_id": "e1",
                "payload": {"status": "running", "timestamp": "t"},
            },
        )

        assert s1._queue.qsize() == 1
        assert s2._queue.qsize() == 1

    def test_route_uses_ensure_shared_not_create_poll_per_conn(self) -> None:
        from eden.realtime import mobile_sse as mod

        source = inspect.getsource(mod.mobile_sse_stream)
        assert "_ensure_shared_poller" in source
        assert "_poll_job_updates" not in source
