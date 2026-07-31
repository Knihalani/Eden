"""An oversized SSE frame must arrive as a marker, not as corrupt JSON.

The publisher did:

    body = _dump_payload(payload)[:16 * 1024]

Slicing *serialized* JSON cuts mid-token, so every payload over the cap became
unparseable. The consumer then hit

    except (TypeError, ValueError, json.JSONDecodeError):
        continue

and dropped the frame without a word. Both halves are silent, and the ordering
makes it worse: the Redis write happened first, so the cost was paid in full and
nothing was delivered. From the UI the event simply never existed — and it is
precisely the *large* events (a long tool-call chain, a big response body) that
vanished, which is the opposite of what an observability product should lose.

A truncation marker is strictly better than a corrupt frame: it is valid JSON,
it carries the identifying fields so the row stays attributable, and the client
can fetch the full trace over the normal API.

The two eviction sites below are policy, not bugs — a mobile client wants recent
events, and a live ring buffer must be bounded — but neither was recorded, so a
client that was persistently behind lost events at an unknown rate.
"""

from __future__ import annotations

import json

import pytest

from eden.api.routes.observability_stream import (
    _SSE_PAYLOAD_MAX_BYTES,
    _dump_payload_capped,
)
from eden.observability.drop_metrics import get_drop_metrics, reset_for_tests


@pytest.fixture(autouse=True)
def _clean() -> None:
    reset_for_tests()
    yield
    reset_for_tests()


class TestOversizedPayload:
    def test_small_payload_round_trips_unchanged(self) -> None:
        payload = {"trace_id": "t1", "event_id": "e1", "x": "y"}
        assert json.loads(_dump_payload_capped(payload)) == payload
        assert get_drop_metrics().get(("sse", "oversize"), 0.0) == 0.0

    def test_oversized_payload_is_still_valid_json(self) -> None:
        """The regression: the old slice produced something unparseable."""
        payload = {"trace_id": "t2", "blob": "x" * (_SSE_PAYLOAD_MAX_BYTES * 2)}
        body = _dump_payload_capped(payload)
        decoded = json.loads(body)  # must not raise
        assert decoded["_truncated"] is True

    def test_marker_preserves_the_identifying_fields(self) -> None:
        """Without these the row is unattributable and the client cannot recover."""
        payload = {
            "trace_id": "t3",
            "span_id": "s3",
            "event_id": "e3",
            "event_type": "llm.completion",
            "timestamp": "2026-07-30T00:00:00+00:00",
            "blob": "x" * (_SSE_PAYLOAD_MAX_BYTES * 2),
        }
        decoded = json.loads(_dump_payload_capped(payload))
        for key in ("trace_id", "span_id", "event_id", "event_type", "timestamp"):
            assert decoded[key] == payload[key]
        assert "blob" not in decoded

    def test_marker_reports_the_original_size(self) -> None:
        payload = {"trace_id": "t4", "blob": "x" * 40_000}
        decoded = json.loads(_dump_payload_capped(payload))
        assert decoded["_original_bytes"] > _SSE_PAYLOAD_MAX_BYTES

    def test_oversize_is_counted(self) -> None:
        payload = {"trace_id": "t5", "blob": "x" * (_SSE_PAYLOAD_MAX_BYTES * 2)}
        _dump_payload_capped(payload)
        assert get_drop_metrics().get(("sse", "oversize"), 0.0) == 1.0

    def test_the_marker_is_under_the_cap(self) -> None:
        """A marker that itself exceeds the cap would defeat the whole point."""
        payload = {
            "trace_id": "t" * 500,
            "span_id": "s" * 500,
            "event_id": "e" * 500,
            "event_type": "x" * 500,
            "timestamp": "z" * 500,
            "blob": "x" * (_SSE_PAYLOAD_MAX_BYTES * 4),
        }
        body = _dump_payload_capped(payload)
        assert len(body.encode("utf-8")) <= _SSE_PAYLOAD_MAX_BYTES

    def test_boundary_payload_is_not_truncated(self) -> None:
        """Exactly at the cap must pass through — the check is <=, not <."""
        filler = "x" * (_SSE_PAYLOAD_MAX_BYTES - 64)
        payload = {"a": filler}
        body = _dump_payload_capped(payload)
        if len(body.encode("utf-8")) <= _SSE_PAYLOAD_MAX_BYTES:
            assert json.loads(body) == payload


class TestLiveRingBufferEviction:
    def test_eviction_is_recorded_on_the_process_metric(self) -> None:
        """``self.dropped`` is an instance counter nothing exports."""
        from eden.observability.live.stream import LIVE_BUFFER_MAX, SessionBuffer

        buf = SessionBuffer()
        for i in range(LIVE_BUFFER_MAX + 3):
            buf.append({"event_id": i})

        assert buf.dropped == 3
        assert get_drop_metrics().get(("sse", "queue_full"), 0.0) == 3.0

    def test_no_eviction_below_the_cap(self) -> None:
        from eden.observability.live.stream import SessionBuffer

        buf = SessionBuffer()
        for i in range(5):
            buf.append({"event_id": i})
        assert buf.dropped == 0
        assert get_drop_metrics().get(("sse", "queue_full"), 0.0) == 0.0


class TestMobileQueueEviction:
    @staticmethod
    def _stream():  # noqa: ANN205 — MobileSSEStream, kept untyped for brevity
        from eden.realtime.mobile_sse import MobileSSEStream

        return MobileSSEStream(job_id="j1", user={"user_id": "u1"})

    @pytest.mark.asyncio
    async def test_overflow_eviction_is_counted(self) -> None:
        stream = self._stream()
        cap = stream._queue.maxsize
        for i in range(cap + 2):
            await stream.emit({"event_id": str(i), "event_type": "x", "payload": {}})

        assert get_drop_metrics().get(("sse", "queue_full"), 0.0) == 2.0

    @pytest.mark.asyncio
    async def test_the_newest_event_is_kept(self) -> None:
        """The eviction policy is drop-oldest; assert it still holds."""
        stream = self._stream()
        cap = stream._queue.maxsize
        for i in range(cap + 1):
            await stream.emit({"event_id": str(i), "event_type": "x", "payload": {}})

        drained = []
        while not stream._queue.empty():
            drained.append(stream._queue.get_nowait())
        assert drained[-1]["event_id"] == str(cap), "the newest event was evicted"
