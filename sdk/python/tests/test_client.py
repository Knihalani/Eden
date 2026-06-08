"""Tests for the batched HTTP client (EdenClient)."""

from __future__ import annotations

import json
import time

import httpx
import pytest

from eden_sdk.client import EdenClient, TraceEvent, get_default_client
from eden_sdk.config import EdenConfig


@pytest.mark.asyncio
async def test_client_enqueues_and_uses_dry_run():
    client = EdenClient(
        EdenConfig(org_id="o", api_key="k", dry_run=True)
    )
    client.start()
    try:
        for i in range(3):
            client.enqueue(
                TraceEvent(
                    payload={"i": i, "model": "gpt-test"},
                    source_format="openai",
                )
            )
        # Give the worker a moment to process the (dry-run) log line.
        time.sleep(0.1)
        assert client.sent == 3
    finally:
        client.shutdown()


def test_singleton_lifecycle():
    c1 = get_default_client()
    c2 = get_default_client()
    assert c1 is c2
    # Don't shut down here — atexit handles it. The conftest reset
    # between tests ensures isolation.


def test_dry_run_does_not_require_http():
    """The smoke test we run in CI shouldn't depend on a real gateway."""
    client = EdenClient(
        EdenConfig(org_id="o", api_key="k", dry_run=True)
    )
    client.enqueue(TraceEvent(payload={"x": 1}, source_format="openai"))
    assert client.dropped == 0
    assert client.sent == 1  # dry-run counts as sent
    client.shutdown()


def test_enqueue_does_not_block_when_queue_full():
    """Producer hot path stays non-blocking even under back-pressure.

    With ``max_queue=1`` and no sender running, every enqueue after the
    first triggers the eviction path. The producer must still complete
    1000 enqueues well under one second.
    """
    client = EdenClient(
        EdenConfig(
            org_id="o", api_key="k", dry_run=False, max_queue=1,
        )
    )
    # Don't start the sender so the queue stays full.
    t0 = time.perf_counter()
    for i in range(1000):
        client.enqueue(TraceEvent(payload={"i": i}, source_format="openai"))
    elapsed = time.perf_counter() - t0
    # 1000 enqueues must be sub-second on any reasonable machine.
    assert elapsed < 1.0
    # The most recent event is in the queue; at least one eviction
    # happened to make room.
    assert client._queue.qsize() == 1


@pytest.mark.asyncio
async def test_4xx_responses_count_as_failed(respx_mock):
    """A misconfigured org_id (401) or bad payload (422) must be visible.

    Operators rely on ``client.failed`` to detect ingestion misconfigs.
    Previously only 5xx was counted, so a bad API key looked identical
    to a healthy SDK — events silently disappeared.
    """
    respx_mock.post(
        "http://test.invalid/orgs/o/ingest/openai"
    ).mock(return_value=httpx.Response(401, text="bad key"))
    client = EdenClient(
        EdenConfig(org_id="o", api_key="bad", base_url="http://test.invalid",
                   dry_run=False, flush_interval_ms=50)
    )
    client.start()
    try:
        client.enqueue(TraceEvent(payload={"x": 1}, source_format="openai"))
        client.flush(timeout=2.0)
        assert client.sent == 0
        assert client.failed == 1
    finally:
        client.shutdown()


@pytest.mark.asyncio
async def test_2xx_responses_count_as_sent(respx_mock):
    """2xx is the happy path — events must be tallied as sent."""
    respx_mock.post(
        "http://test.invalid/orgs/o/ingest/openai"
    ).mock(return_value=httpx.Response(202, json={"ok": True}))
    client = EdenClient(
        EdenConfig(org_id="o", api_key="k", base_url="http://test.invalid",
                   dry_run=False, flush_interval_ms=50)
    )
    client.start()
    try:
        client.enqueue(TraceEvent(payload={"x": 1}, source_format="openai"))
        client.flush(timeout=2.0)
        assert client.sent == 1
        assert client.failed == 0
    finally:
        client.shutdown()
