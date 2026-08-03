"""A10 K45 — ingest hot-path Prometheus series registration."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset_metrics():
    from eden.observability.ingest_hot_path_metrics import reset_for_tests

    reset_for_tests()
    yield
    reset_for_tests()


def test_record_and_snapshot_counters() -> None:
    from eden.observability.ingest_hot_path_metrics import (
        get_ingest_hot_path_metrics,
        record_ch_flush_batch_size,
        record_ingest_redis_commands,
        record_sse_publish_skipped,
    )

    record_ingest_redis_commands(3)
    record_ch_flush_batch_size(100)
    record_ch_flush_batch_size(50)
    record_sse_publish_skipped(2)

    snap = get_ingest_hot_path_metrics()
    assert snap["eden_ingest_redis_commands"] == 3.0
    assert snap["eden_ch_flush_batch_size_sum"] == 150.0
    assert snap["eden_ch_flush_batch_size_count"] == 2.0
    assert snap["eden_sse_publish_skipped"] == 2.0


def test_record_sampled_out_ws_skip_and_bytes() -> None:
    from eden.observability.ingest_hot_path_metrics import (
        get_ingest_hot_path_metrics,
        record_ingest_bytes,
        record_ingest_sampled_out,
        record_ws_fanout_skipped,
    )

    record_ingest_sampled_out(5)
    record_ws_fanout_skipped(2)
    record_ingest_bytes(1024)
    record_ingest_bytes(256)

    snap = get_ingest_hot_path_metrics()
    assert snap["eden_ingest_sampled_out"] == 5.0
    assert snap["eden_ws_fanout_skipped"] == 2.0
    assert snap["eden_ingest_bytes"] == 1280.0


def test_record_ws_fanout_publish_skipped() -> None:
    """Phase 3 — cross-pod WS fanout PUBLISH gate counter."""
    from eden.observability.ingest_hot_path_metrics import (
        get_ingest_hot_path_metrics,
        record_ws_fanout_publish_skipped,
    )

    record_ws_fanout_publish_skipped()
    record_ws_fanout_publish_skipped(2)

    snap = get_ingest_hot_path_metrics()
    assert snap["eden_ws_fanout_publish_skipped"] == 3.0


def test_new_counters_ignore_non_positive_input() -> None:
    from eden.observability.ingest_hot_path_metrics import (
        get_ingest_hot_path_metrics,
        record_ingest_bytes,
        record_ingest_sampled_out,
        record_ws_fanout_publish_skipped,
        record_ws_fanout_skipped,
    )

    record_ingest_sampled_out(0)
    record_ingest_sampled_out(-1)
    record_ws_fanout_skipped(0)
    record_ws_fanout_publish_skipped(0)
    record_ws_fanout_publish_skipped(-1)
    record_ingest_bytes(0)
    record_ingest_bytes(-10)

    snap = get_ingest_hot_path_metrics()
    assert snap["eden_ingest_sampled_out"] == 0.0
    assert snap["eden_ws_fanout_skipped"] == 0.0
    assert snap["eden_ws_fanout_publish_skipped"] == 0.0
    assert snap["eden_ingest_bytes"] == 0.0


@pytest.mark.asyncio
async def test_metrics_endpoint_renders_a5_series_names() -> None:
    """Series names must appear on /metrics (stable with A5)."""
    from eden.observability.ingest_hot_path_metrics import (
        record_ch_flush_batch_size,
        record_ingest_redis_commands,
        record_sse_publish_skipped,
    )
    from eden.observability.metrics_endpoint import metrics

    record_ingest_redis_commands(1)
    record_ch_flush_batch_size(42)
    record_sse_publish_skipped(1)

    resp = await metrics()
    text = resp.body.decode("utf-8")

    for name in (
        "eden_ingest_redis_commands",
        "eden_ch_flush_batch_size",
        "eden_sse_publish_skipped",
    ):
        assert name in text, f"missing series {name} in /metrics body"

    assert "eden_ingest_redis_commands 1" in text
    assert "eden_sse_publish_skipped 1" in text
    assert "eden_ch_flush_batch_size_sum 42" in text


@pytest.mark.asyncio
async def test_metrics_endpoint_renders_new_ingest_series() -> None:
    from eden.observability.ingest_hot_path_metrics import (
        record_ingest_bytes,
        record_ingest_sampled_out,
        record_ws_fanout_publish_skipped,
        record_ws_fanout_skipped,
    )
    from eden.observability.metrics_endpoint import metrics

    record_ingest_sampled_out(7)
    record_ws_fanout_skipped(3)
    record_ws_fanout_publish_skipped(4)
    record_ingest_bytes(2048)

    resp = await metrics()
    text = resp.body.decode("utf-8")

    for name in (
        "eden_ingest_sampled_out",
        "eden_ws_fanout_skipped",
        "eden_ws_fanout_publish_skipped",
        "eden_ingest_bytes",
    ):
        assert name in text, f"missing series {name} in /metrics body"

    assert "eden_ingest_sampled_out 7" in text
    assert "eden_ws_fanout_skipped 3" in text
    assert "eden_ws_fanout_publish_skipped 4" in text
    assert "eden_ingest_bytes 2048" in text
