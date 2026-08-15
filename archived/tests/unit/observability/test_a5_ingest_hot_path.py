"""A5 ingest hot-path unit tests — CH flush, NUMSUB skip, dual-emit."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.observability.telemetry_collector import (
    TelemetryCollector,
    TelemetryEvent,
)


def _event(eid: str = "evt-1") -> TelemetryEvent:
    return TelemetryEvent(
        event_id=eid,
        tenant_id="org-1",
        project_id="proj-1",
        trace_id="trace-1",
        realm="environment",
        event_type="llm.completion",
        timestamp=datetime.now(UTC).isoformat(),
        agent_id="agent-1",
        payload={"model": "gpt-4o"},
        metrics={"input_tokens": 1.0, "output_tokens": 1.0},
        request_body={"messages": [{"role": "user", "content": "hi"}]},
    )


# ─── K23: CH flush only on size≥100 or timer — never every event ───


class TestChFlushPolicy:
    @pytest.mark.asyncio
    async def test_ingest_does_not_flush_every_event(self) -> None:
        collector = TelemetryCollector()
        collector._clickhouse = MagicMock()
        flush = AsyncMock()
        collector._flush_clickhouse_buffer = flush  # type: ignore[method-assign]

        with patch.object(collector, "_route", new=AsyncMock()):
            await collector.ingest(_event("e1"))
            await collector.ingest(_event("e2"))

        flush.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_size_flush_at_batch_size(self) -> None:
        collector = TelemetryCollector()
        sink = MagicMock()
        sink.insert = AsyncMock()
        collector._clickhouse = sink

        for i in range(collector.CH_TELEMETRY_BATCH_SIZE):
            await collector._route_clickhouse(_event(f"e{i}"))

        sink.insert.assert_awaited_once()
        args = sink.insert.await_args
        assert args.args[0] == "telemetry_events_ch"
        assert len(args.args[1]) == collector.CH_TELEMETRY_BATCH_SIZE

    @pytest.mark.asyncio
    async def test_below_size_stays_buffered(self) -> None:
        collector = TelemetryCollector()
        sink = MagicMock()
        sink.insert = AsyncMock()
        collector._clickhouse = sink

        await collector._route_clickhouse(_event("e1"))
        await collector._route_clickhouse(_event("e2"))

        sink.insert.assert_not_awaited()
        assert len(collector._ch_telemetry_buffer) == 2


# ─── K24: NUMSUB==0 skips all Redis writes; pipeline with subscribers ───


class TestPublishNumsub:
    @pytest.fixture(autouse=True)
    def _clear_numsub_cache(self) -> None:
        from eden.api.routes import observability_stream as stream

        stream._numsub_cache.clear()
        stream._sse_maint_at.clear()

    @pytest.mark.asyncio
    async def test_numsub_zero_skips_all_writes(self) -> None:
        from eden.api.routes import observability_stream as stream
        from eden.observability.ingest_hot_path_metrics import (
            get_ingest_hot_path_metrics,
            reset_for_tests,
        )

        reset_for_tests()
        redis = MagicMock()
        redis.pubsub_numsub = AsyncMock(return_value=[("ch", 0)])
        redis.incr = AsyncMock(return_value=3)
        pipe = MagicMock()
        pipe.publish = MagicMock(return_value=pipe)
        pipe.zadd = MagicMock(return_value=pipe)
        pipe.expire = MagicMock(return_value=pipe)
        pipe.zremrangebyrank = MagicMock(return_value=pipe)
        pipe.execute = AsyncMock(return_value=[])
        redis.pipeline = MagicMock(return_value=pipe)

        with patch(
            "eden.api.routes.observability_stream.get_redis_client",
            new=AsyncMock(return_value=redis),
        ):
            await stream.publish_trace_event("org-1", {"trace_id": "t1"})

        redis.incr.assert_not_awaited()
        pipe.publish.assert_not_called()
        pipe.zadd.assert_not_called()
        assert get_ingest_hot_path_metrics()["eden_sse_publish_skipped"] == 1.0

    @pytest.mark.asyncio
    async def test_numsub_positive_pipelines(self) -> None:
        from eden.api.routes import observability_stream as stream

        redis = MagicMock()
        redis.pubsub_numsub = AsyncMock(return_value=[("ch", 2)])
        redis.incr = AsyncMock(return_value=7)
        pipe = MagicMock()
        pipe.publish = MagicMock(return_value=pipe)
        pipe.zadd = MagicMock(return_value=pipe)
        pipe.expire = MagicMock(return_value=pipe)
        pipe.zremrangebyrank = MagicMock(return_value=pipe)
        pipe.execute = AsyncMock(return_value=[1, 1, True, True, 0])
        redis.pipeline = MagicMock(return_value=pipe)

        with patch(
            "eden.api.routes.observability_stream.get_redis_client",
            new=AsyncMock(return_value=redis),
        ):
            await stream.publish_trace_event("org-1", {"trace_id": "t1"})

        redis.pipeline.assert_called_once_with(transaction=False)
        pipe.execute.assert_awaited_once()
        pipe.publish.assert_called_once()
        pipe.zadd.assert_called_once()
        zadd_member = next(iter(pipe.zadd.call_args.args[1].keys()))
        assert zadd_member.startswith("7|")

    @pytest.mark.asyncio
    async def test_numsub_cache_avoids_repeat_redis(self) -> None:
        from eden.api.routes import observability_stream as stream
        from eden.observability.ingest_hot_path_metrics import (
            get_ingest_hot_path_metrics,
            reset_for_tests,
        )

        reset_for_tests()
        redis = MagicMock()
        redis.pubsub_numsub = AsyncMock(return_value=[("ch", 0)])
        redis.incr = AsyncMock(side_effect=[1, 2])
        pipe = MagicMock()
        pipe.publish = MagicMock(return_value=pipe)
        pipe.zadd = MagicMock(return_value=pipe)
        pipe.expire = MagicMock(return_value=pipe)
        pipe.zremrangebyrank = MagicMock(return_value=pipe)
        pipe.execute = AsyncMock(return_value=[1, True, True, 0])
        redis.pipeline = MagicMock(return_value=pipe)

        with patch(
            "eden.api.routes.observability_stream.get_redis_client",
            new=AsyncMock(return_value=redis),
        ):
            await stream.publish_trace_event("org-cache", {"trace_id": "t1"})
            await stream.publish_trace_event("org-cache", {"trace_id": "t2"})

        assert redis.pubsub_numsub.await_count == 1
        redis.incr.assert_not_awaited()
        assert pipe.zadd.call_count == 0
        assert get_ingest_hot_path_metrics()["eden_sse_publish_skipped"] == 2.0

    @pytest.mark.asyncio
    async def test_write_when_idle_buffers_replay(self) -> None:
        from eden.api.routes import observability_stream as stream
        from eden.observability.ingest_hot_path_metrics import (
            get_ingest_hot_path_metrics,
            reset_for_tests,
        )

        reset_for_tests()
        redis = MagicMock()
        redis.pubsub_numsub = AsyncMock(return_value=[("ch", 0)])
        redis.incr = AsyncMock(return_value=3)
        pipe = MagicMock()
        pipe.publish = MagicMock(return_value=pipe)
        pipe.zadd = MagicMock(return_value=pipe)
        pipe.expire = MagicMock(return_value=pipe)
        pipe.zremrangebyrank = MagicMock(return_value=pipe)
        pipe.execute = AsyncMock(return_value=[1, True, True, 0])
        redis.pipeline = MagicMock(return_value=pipe)

        with (
            patch(
                "eden.api.routes.observability_stream.get_redis_client",
                new=AsyncMock(return_value=redis),
            ),
            patch(
                "eden.api.routes.observability_stream._sse_settings",
                return_value=(True, 30.0, 2.0),
            ),
        ):
            await stream.publish_trace_event("org-1", {"trace_id": "t1"})

        redis.incr.assert_awaited_once()
        pipe.publish.assert_not_called()
        pipe.zadd.assert_called_once()
        assert get_ingest_hot_path_metrics()["eden_sse_publish_skipped"] == 1.0


# ─── S1/S2/S17: dual-emit batch, content off, settings cached ───


class TestOtelDualEmit:
    @pytest.mark.asyncio
    async def test_content_gated_off_by_default(self) -> None:
        from eden.observability.otel_exporter import OTelDualExporter

        exporter = OTelDualExporter()
        settings = MagicMock()
        settings.otel_dual_emit_enabled = True
        settings.otel_dual_emit_include_content = False
        settings.otel_exporter_otlp_endpoint = "http://otel:4318"
        settings.otel_exporter_otlp_timeout_seconds = 5
        exporter._settings = settings

        span = exporter._event_to_otlp_span(_event(), include_content=False)
        assert span["events"] == []

    @pytest.mark.asyncio
    async def test_content_included_when_enabled(self) -> None:
        from eden.observability.otel_exporter import OTelDualExporter

        exporter = OTelDualExporter()
        span = exporter._event_to_otlp_span(_event(), include_content=True)
        assert any(e["name"].endswith(".message") for e in span["events"])

    @pytest.mark.asyncio
    async def test_settings_cached_on_exporter(self) -> None:
        from eden.observability.otel_exporter import OTelDualExporter

        exporter = OTelDualExporter()
        fake = MagicMock()
        fake.otel_dual_emit_enabled = True
        fake.otel_exporter_otlp_endpoint = ""
        exporter._settings = fake
        with patch(
            "eden.observability.otel_exporter.get_settings",
            side_effect=AssertionError("should not re-fetch"),
        ):
            assert exporter._cached_settings() is fake
            await exporter.export_event(_event())

    @pytest.mark.asyncio
    async def test_export_buffers_until_flush(self) -> None:
        from eden.observability.otel_exporter import OTelDualExporter

        exporter = OTelDualExporter()
        settings = MagicMock()
        settings.otel_dual_emit_enabled = True
        settings.otel_dual_emit_include_content = False
        settings.otel_exporter_otlp_endpoint = "http://otel:4318"
        settings.otel_exporter_otlp_timeout_seconds = 5
        exporter._settings = settings
        exporter.FLUSH_SIZE = 100

        session = MagicMock()
        session.closed = False
        resp = MagicMock()
        resp.status = 200
        resp.__aenter__ = AsyncMock(return_value=resp)
        resp.__aexit__ = AsyncMock(return_value=None)
        session.post = MagicMock(return_value=resp)
        exporter._session = session

        await exporter.export_event(_event("a"))
        await exporter.export_event(_event("b"))
        assert len(exporter._buffer) == 2
        session.post.assert_not_called()

        n = await exporter.flush()
        assert n == 2
        session.post.assert_called_once()
        assert exporter._buffer == []


# ─── FEAT-169: gen_ai.conversation.id must never be fabricated from trace_id ───


class TestConversationIdNotFabricated:
    def test_conversation_id_omitted_when_absent(self) -> None:
        from eden.observability.otel_exporter import OTelDualExporter

        exporter = OTelDualExporter()
        span = exporter._event_to_otlp_span(_event(), include_content=False)
        keys = {attr["key"] for attr in span["attributes"]}
        assert "gen_ai.conversation.id" not in keys

    def test_conversation_id_included_when_present(self) -> None:
        from eden.observability.otel_exporter import OTelDualExporter

        exporter = OTelDualExporter()
        event = _event()
        event.attributes["gen_ai.conversation.id"] = "conv-123"
        span = exporter._event_to_otlp_span(event, include_content=False)
        attrs = {attr["key"]: attr["value"] for attr in span["attributes"]}
        assert attrs["gen_ai.conversation.id"] == {"stringValue": "conv-123"}


# ─── S9/S10: single to_dict; enrich without full payload dump ───


class TestEnrichAndSingleToDict:
    def test_enrich_hash_ignores_payload_body(self) -> None:
        collector = TelemetryCollector()
        a = _event("same")
        b = _event("same")
        # ``_event`` stamps ``datetime.now`` per call so equalise before hashing.
        b.timestamp = a.timestamp
        b.payload = {"huge": "x" * 10_000}
        collector._enrich(a)
        collector._enrich(b)
        assert a.attributes["_content_hash"] == b.attributes["_content_hash"]

    @pytest.mark.asyncio
    async def test_route_redis_single_to_dict(self) -> None:
        collector = TelemetryCollector()
        pipe = MagicMock()
        pipe.xadd = MagicMock(return_value=pipe)
        pipe.expire = MagicMock(return_value=pipe)
        pipe.execute = AsyncMock(return_value=[b"1-0", True])
        redis = MagicMock()
        redis.pipeline = MagicMock(return_value=pipe)
        collector._redis = redis

        event = _event()
        calls = {"n": 0}
        original = event.to_dict

        def counted() -> dict:
            calls["n"] += 1
            return original()

        event.to_dict = counted  # type: ignore[method-assign]

        with (
            patch(
                "eden.api.routes.observability_stream.publish_trace_event",
                new=AsyncMock(),
            ),
            patch(
                "eden.config.get_settings",
                return_value=MagicMock(
                    redis_telemetry_stream_enabled=True,
                    judges_async_tailer_enabled=False,
                ),
            ),
        ):
            await collector._route_redis(event)

        assert calls["n"] == 1


# ─── K28: CH→PG fallback executemany ───


class TestChFallbackExecutemany:
    @pytest.mark.asyncio
    async def test_fallback_uses_executemany(self) -> None:
        from eden.data_platform.clickhouse_sink import ClickHouseSink

        sink = ClickHouseSink.__new__(ClickHouseSink)
        client = MagicMock()
        client.executemany = AsyncMock()
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ):
            await sink._fallback_to_postgres(
                "telemetry_events_ch",
                [{"a": 1}, {"a": 2}],
            )
        client.executemany.assert_awaited_once()
        args = client.executemany.await_args.args
        assert len(args[1]) == 2
