"""Regression test: StreamEvents.publish_loop must advance last_event_id.

Prior bug: the loop computed ``ev.get("event_id", last_event_id)`` but
discarded the result, so ``last_event_id`` never advanced. Every 1s
tick re-queried the exact same cursor, causing duplicate delivery (or
dropped events beyond the first ``limit=10`` window). This test drives
the ``publish_loop`` closure directly against a fake store keyed by the
cursor value it receives, and asserts the cursor passed on the second
call has advanced past the first.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class _FakeStore:
    """Returns a distinct window of events keyed by the cursor passed in.

    Simulates a topic with more events than fit in one page: starting
    from "" it yields events e1..e10 (cursor now "e10"); starting from
    "e10" it yields e11..e12; any other cursor yields nothing further.
    """

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def get_events_after(self, topic: str, cursor: str, limit: int = 10):
        self.calls.append(cursor)
        if cursor == "":
            return [{"event_id": f"e{i}"} for i in range(1, 11)]
        if cursor == "e10":
            return [{"event_id": "e11"}, {"event_id": "e12"}]
        return []


@pytest.mark.asyncio
async def test_publish_loop_advances_cursor_across_iterations() -> None:
    """The cursor used by get_events_after must advance, not repeat."""
    from eden.realtime import grpc_server as mod

    store = _FakeStore()

    # ``get_trace_event_store`` is imported locally inside
    # ``_build_servicer`` (fresh each call), so patch it at its source
    # module rather than on ``grpc_server`` itself.
    # NOTE: deliberately does NOT mock asyncio.sleep. publish_loop's
    # `await asyncio.sleep(1.0)` is what yields control back to the
    # event loop between polls; stubbing it with an instant AsyncMock
    # would turn the loop into a non-yielding busy-spin (nothing else
    # in the loop body genuinely suspends) and hang the test forever.
    # The real ~1s sleep between polls is worth the wall-clock cost.
    with patch(
        "eden.realtime.trace_store.get_trace_event_store",
        new=AsyncMock(return_value=store),
    ):
        servicer_cls = mod._build_servicer()
        servicer = servicer_cls()

        request = MagicMock()
        request.topic = "eden-trace"
        request.last_event_id = ""

        gen = servicer.StreamEvents(request, context=MagicMock())

        received: list[Any] = []
        # Drain exactly as many events as the fake store will ever
        # produce (10 from the first poll window, 2 from the second),
        # then stop the generator.
        for _ in range(12):
            ev = await gen.__anext__()
            received.append(ev)

        await gen.aclose()

    assert len(received) == 12
    assert [ev.event_id for ev in received] == [f"e{i}" for i in range(1, 13)]

    # The critical assertion: the second poll call must have used the
    # advanced cursor ("e10"), not the original empty/unchanged one.
    assert store.calls[0] == ""
    assert "e10" in store.calls, (
        f"cursor never advanced past initial value; calls were {store.calls!r}"
    )
    assert store.calls.count("") == 1, (
        "cursor repeated the same starting value on a later poll "
        f"(duplicate-delivery bug); calls were {store.calls!r}"
    )
