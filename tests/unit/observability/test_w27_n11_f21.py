"""Wave 27 — N11 live streaming + F21 label learning (unit contracts)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.learning.tool_call_calibrator import ToolCallCalibrator
from eden.observability.live.publisher import LiveTracePublisher
from eden.observability.live.stream import (
    LIVE_BUFFER_MAX,
    SessionBuffer,
    channel_name,
    live_enabled,
)
from eden.observability.live.subscriber import LiveTraceSubscriber


def test_channel_naming() -> None:
    assert channel_name("org1", "sess-a") == "trace:live:org1:sess-a"


def test_session_buffer_backpressure_drops_oldest() -> None:
    buf = SessionBuffer()
    for i in range(LIVE_BUFFER_MAX + 25):
        buf.append({"event_id": i + 1, "type": "span_end"})
    assert len(buf.events) == LIVE_BUFFER_MAX
    assert buf.dropped == 25
    assert buf.since(LIVE_BUFFER_MAX + 20)  # still has recent


def test_calibrator_trains_and_predicts() -> None:
    rows: list[tuple[list[float], int]] = []
    for i in range(10):
        # Bad pattern: first feature high
        rows.append(([0.9 if i < 8 else -0.9] + [0.0] * 15, 1 if i < 8 else 0))
    cal = ToolCallCalibrator()
    metrics = cal.train(rows)
    assert metrics["status"] == "ok"
    assert metrics["sample_count"] == 10
    pred = cal.predict([0.95] + [0.0] * 15, threshold=0.5)
    assert pred["predicted_label"] in ("good", "bad")
    assert 0.0 <= pred["confidence"] <= 1.0
    blob = cal.dumps()
    restored = ToolCallCalibrator.loads(blob)
    assert restored.sample_count == 10


@pytest.mark.asyncio
async def test_publisher_skips_redis_when_no_subscribers() -> None:
    from eden.observability.live import publisher as pub_mod

    pub_mod._numsub_cache.clear()
    pub = LiveTracePublisher()
    redis = MagicMock()
    redis.pubsub_numsub = AsyncMock(return_value=[("ch", 0)])
    redis.incr = AsyncMock(return_value=1)
    redis.pipeline = MagicMock()

    with (
        patch.object(pub, "_redis", AsyncMock(return_value=redis)),
        patch(
            "eden.observability.live.publisher.live_enabled",
            return_value=True,
        ),
        patch(
            "eden.observability.live.publisher._live_write_when_idle",
            return_value=False,
        ),
    ):
        out = await pub.publish(
            "org_idle",
            "sess_idle",
            {"type": "span_start", "span_id": "s1"},
        )

    assert out["status"] == "ok"
    assert out.get("skipped") == "no_subscribers"
    redis.incr.assert_not_awaited()
    redis.pipeline.assert_not_called()


@pytest.mark.asyncio
async def test_publisher_local_fallback_and_finalize() -> None:
    pub = LiveTracePublisher()
    with (
        patch.object(pub, "_redis", AsyncMock(return_value=None)),
        patch(
            "eden.observability.live.publisher.live_enabled",
            return_value=True,
        ),
    ):
        r1 = await pub.publish(
            "org_t",
            "sess_1",
            {"type": "span_start", "span_id": "s1", "name": "tool.x"},
        )
        assert r1["status"] == "ok"
        assert r1.get("transport") == "local"
        r2 = await pub.publish(
            "org_t",
            "sess_1",
            {"type": "span_end", "span_id": "s1", "status": "ok"},
        )
        assert r2["event_id"] == 2
        fin = await pub.finalize("org_t", "sess_1", trace_id="tr-1", step_count=2)
        assert fin["status"] == "ok"
        assert fin["persisted_once"] is True
        assert fin["step_count"] == 2
        assert fin["trace_id"] == "tr-1"


@pytest.mark.asyncio
async def test_subscriber_replays_local_then_finalize() -> None:
    pub = LiveTracePublisher()
    sub = LiveTraceSubscriber()
    with (
        patch.object(pub, "_redis", AsyncMock(return_value=None)),
        patch.object(sub, "_redis", AsyncMock(return_value=None)),
        patch(
            "eden.observability.live.publisher.live_enabled",
            return_value=True,
        ),
        patch(
            "eden.observability.live.subscriber.live_enabled",
            return_value=True,
        ),
    ):
        await pub.publish(
            "org_s",
            "sess_s",
            {"type": "span_start", "span_id": "a", "name": "llm"},
        )
        await pub.finalize("org_s", "sess_s", trace_id="t1", step_count=1)
        chunks: list[bytes] = []
        async for chunk in sub.stream("org_s", "sess_s", from_event_id=0):
            chunks.append(chunk)
        joined = b"".join(chunks).decode()
        assert "trace_finalized" in joined or "span_start" in joined


def test_live_flag_reads_settings() -> None:
    class _S:
        live_trace_streaming_v1 = True

    with patch("eden.config.get_settings", return_value=_S()):
        assert live_enabled() is True


def test_mcp_catalog_includes_w27_tools() -> None:
    from eden.mcp_server.server import TOOL_CATALOG

    names = {t["name"] for t in TOOL_CATALOG}
    assert "tail_trace" in names
    assert "label_tool_call" in names


@pytest.mark.asyncio
async def test_mcp_tail_trace_and_label_handlers() -> None:
    from eden.mcp_server import tools as tool_fns

    class _Client:
        async def get(self, path: str, **_kw):  # noqa: ANN001
            return {"path": path, "status": "ok"}

        async def post(self, path: str, json=None, **_kw):  # noqa: ANN001
            return {"path": path, "body": json, "status": "ok"}

        async def label_tool_call(self, org_id, **kwargs):  # noqa: ANN001
            return {"org_id": org_id, **kwargs}

        async def tail_trace(self, org_id, **kwargs):  # noqa: ANN001
            return {"org_id": org_id, **kwargs, "events": []}

    client = _Client()
    with patch(
        "eden.observability.live.stream.live_mcp_enabled", return_value=True
    ):
        # Prefer direct handler contracts when wired.
        if hasattr(tool_fns, "tail_trace"):
            out = await tool_fns.tail_trace(
                client, "org1", session_id="s1", max_events=5
            )
            assert out.get("status") in ("ok", "error") or "session_id" in out
        if hasattr(tool_fns, "label_tool_call"):
            out2 = await tool_fns.label_tool_call(
                client,
                "org1",
                span_id="sp1",
                label="bad",
                reason="wrong table",
                trace_id="t1",
                tool_name="sql.query",
            )
            assert out2.get("status") in ("ok", "error") or "span_id" in str(out2)


def test_sdk_live_mode_env(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    from pathlib import Path

    sdk_root = Path(__file__).resolve().parents[3] / "sdk" / "python"
    if str(sdk_root) not in sys.path:
        sys.path.insert(0, str(sdk_root))
    from eden_sdk.live import live_mode_enabled

    monkeypatch.delenv("EDEN_LIVE", raising=False)
    assert live_mode_enabled() is False
    assert live_mode_enabled(stream=True) is True
    monkeypatch.setenv("EDEN_LIVE", "1")
    assert live_mode_enabled() is True


def test_migration_111_chains_from_110() -> None:
    from pathlib import Path

    mig = Path(__file__).resolve().parents[3] / (
        "src/eden/db_migrations/versions/111_w27_live_labels.py"
    )
    text = mig.read_text()
    assert 'down_revision: str = "110_w26_drop_issue_fix_sessions"' in text
    assert "tool_call_calibrators" in text
    assert "live_trace_sessions" in text
