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
