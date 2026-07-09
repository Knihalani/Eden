"""Tests for the batched HTTP client (EdenClient)."""

from __future__ import annotations

import json
import time

import httpx

import eden
from eden_sdk.client import EdenClient, TraceEvent, get_default_client
from eden_sdk.config import EdenConfig


def test_client_enqueues_and_uses_dry_run():
    """Dry-run mode increments the counter synchronously; no
    worker is needed to see the count. The async-loop worker
    isn't started in dry-run mode, so no time.sleep is needed.
    """
    client = EdenClient(
        EdenConfig(org_id="o", api_key="k", dry_run=True)
    )
    # Note: not calling client.start() — the async loop only
    # spins up when dry_run is False. Dry-run events hit the
    # counter on enqueue.
    for i in range(3):
        client.enqueue(
            TraceEvent(
                payload={"i": i, "model": "gpt-test"},
                source_format="openai",
            )
        )
    assert client.sent == 3


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


def _make_mock_transport(handler):
    """Build an httpx MockTransport that delegates to a request handler.

    The handler signature is ``(httpx.Request) -> httpx.Response``.
    The transport captures the most recent request so tests can
    assert on headers and URL.
    """
    state = {"last_request": None}

    def handle(request: httpx.Request) -> httpx.Response:
        state["last_request"] = request
        return handler(request)

    return httpx.MockTransport(handle), state


def test_4xx_responses_count_as_failed():
    """A misconfigured org_id (401) or bad payload (422) must be visible.

    Operators rely on ``client.failed`` to detect ingestion misconfigs.
    Previously only 5xx was counted, so a bad API key looked identical
    to a healthy SDK — events silently disappeared.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="bad key", request=request)

    transport, state = _make_mock_transport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="bad",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    client.start()
    try:
        client.enqueue(TraceEvent(payload={"x": 1}, source_format="openai"))
        client.flush(timeout=2.0)
        assert client.sent == 0
        assert client.failed == 1
        # The auth headers were attached.
        assert state["last_request"] is not None
        assert state["last_request"].headers["X-Org-Id"] == "o"
    finally:
        client.shutdown()


def test_2xx_responses_count_as_sent():
    """2xx is the happy path — events must be tallied as sent."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"ok": True}, request=request)

    transport, state = _make_mock_transport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    client.start()
    try:
        client.enqueue(TraceEvent(payload={"x": 1}, source_format="openai"))
        client.flush(timeout=2.0)
        assert client.sent == 1
        assert client.failed == 0
        # URL hits the expected ingestion route.
        assert state["last_request"] is not None
        assert (
            state["last_request"].url.path
            == "/orgs/o/ingest/openai"
        )
    finally:
        client.shutdown()


def test_flush_returns_quickly_after_drain():
    """flush() must return as soon as the in-flight batch lands,
    not wait for the full timeout. Regression test for the
    generation-counter flush that replaced the time.sleep() loop.
    """
    import time as _t

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"ok": True}, request=request)

    transport, _ = _make_mock_transport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    client.start()
    try:
        client.enqueue(TraceEvent(payload={"i": 1}, source_format="openai"))
        t0 = _t.perf_counter()
        client.flush(timeout=5.0)
        elapsed = _t.perf_counter() - t0
        # Mock transport returns immediately, so flush should
        # complete well under the 5s budget. Generous bound for CI.
        assert elapsed < 2.0, f"flush took {elapsed:.2f}s (expected < 2.0)"
        assert client.sent == 1
    finally:
        client.shutdown()


def test_concurrent_producers_all_events_accounted_for():
    """Multiple producer threads must not lose or double-count events.

    Regression: enqueue's ``_dropped_total += 1`` and the worker's
    ``_sent_total += count`` were originally the only safety net.
    With 4 producers at modest rate, all events must land in the
    transport (or the failed counter) with no leaks.
    """
    import eden
    from eden_sdk import client as cli_mod
    from eden_sdk import config as cfg_mod

    cfg_mod.reset_config()
    cli_mod.reset_default_client()

    received: list = []

    def handler(request):
        received.append(request)
        return httpx.Response(202, json={"ok": True})

    eden.configure(
        org_id="stress",
        api_key="k",
        base_url="http://test.invalid",
        dry_run=False,
        batch_size=2048,
        flush_interval_ms=5,
        max_queue=50_000,
        project_id="stress",
        transport=httpx.MockTransport(handler),
    )
    client = eden.get_default_client()
    try:
        N_THREADS = 4
        N_PER_THREAD = 2_000

        def worker():
            for i in range(N_PER_THREAD):
                client.enqueue(
                    TraceEvent(
                        payload={"i": i, "model": "gpt-4o-mini"},
                        source_format="openai",
                    )
                )

        threads = [__import__("threading").Thread(target=worker) for _ in range(N_THREADS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        client.flush(timeout=5.0)
        total = N_THREADS * N_PER_THREAD
        # Every event is either sent, dropped (back-pressure), or
        # failed (transport error). The mock transport never fails,
        # so we expect sent == total.
        assert client.sent == total, (
            f"expected {total} sent, got {client.sent} "
            f"(failed={client.failed}, dropped={client.dropped})"
        )
    finally:
        client.shutdown()


def test_configure_transport_is_honored_by_singleton():
    """``configure(transport=...)`` is wired through to the singleton's
    EdenClient so test code can mock the gateway without rebuilding
    the client.
    """
    from eden_sdk import client as cli_mod
    from eden_sdk import config as cfg_mod

    cfg_mod.reset_config()
    cli_mod.reset_default_client()

    captured: list = []

    def handler(request):
        captured.append(request)
        return httpx.Response(202, json={"ok": True})

    transport = httpx.MockTransport(handler)
    eden.configure(
        org_id="o",
        api_key="k",
        base_url="http://test.invalid",
        dry_run=False,
        batch_size=64,
        flush_interval_ms=5,
        max_queue=1_000,
        transport=transport,
    )
    client = eden.get_default_client()
    try:
        # The transport was set BEFORE the client started, so
        # the async loop picked it up.
        assert client._transport is transport
        client.enqueue(TraceEvent(payload={"x": 1}, source_format="openai"))
        client.flush(timeout=2.0)
        assert len(captured) == 1
        assert captured[0].url.path == "/orgs/o/ingest/openai"
    finally:
        client.shutdown()


# ── New: retry with exponential backoff ──────────────────────────────


def _make_client_with_mock(handler) -> EdenClient:
    """Build a client whose _http is wired up to a MockTransport."""
    import httpx

    from eden_sdk.client import EdenClient
    from eden_sdk.config import EdenConfig
    cfg = EdenConfig(
        org_id="o", api_key="k",
        base_url="https://api.example.com",
        timeout_s=2.0, flush_interval_ms=10000, batch_size=10,
    )
    transport = httpx.MockTransport(handler)
    client = EdenClient(cfg, transport=transport)
    # Wire up the async client manually so _send_batch can run without
    # the full worker thread.
    client._http = httpx.AsyncClient(timeout=2.0, transport=transport)
    return client


def test_send_batch_retries_5xx_then_succeeds() -> None:
    """A 503, 503, 200 sequence should leave all events counted as sent."""
    import asyncio

    import httpx

    from eden_sdk.client import TraceEvent

    responses = [
        httpx.Response(503, text="overloaded"),
        httpx.Response(503, text="overloaded"),
        httpx.Response(200, json={"ok": True}),
    ]
    def handler(req):
        return responses.pop(0)
    client = _make_client_with_mock(handler)
    batch = [TraceEvent(payload={"x": i}, source_format="openai") for i in range(3)]
    asyncio.run(client._send_batch(batch))
    assert client.sent == 3
    assert client.failed == 0


def test_send_batch_does_not_retry_4xx() -> None:
    """A 401 (auth failure) should NOT be retried."""
    import asyncio

    import httpx

    from eden_sdk.client import TraceEvent

    call_count = 0
    def handler(req):
        nonlocal call_count
        call_count += 1
        return httpx.Response(401, text="unauthorized")
    client = _make_client_with_mock(handler)
    batch = [TraceEvent(payload={"x": 1}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert call_count == 1, "4xx should be a single attempt"
    assert client.failed == 1
    assert client.sent == 0


def test_send_batch_honors_retry_after_header() -> None:
    """Server-supplied Retry-After is used instead of exponential backoff."""
    import asyncio

    import httpx

    from eden_sdk.client import TraceEvent

    call_count = 0
    def handler(req):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(429, text="slow down", headers={"retry-after": "0.01"})
        return httpx.Response(200, json={"ok": True})
    client = _make_client_with_mock(handler)
    batch = [TraceEvent(payload={"x": 1}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert call_count == 2, "should retry exactly once after 429"
    assert client.sent == 1
    assert client.failed == 0



# ── Chunk redaction ────────────────────────────────────────────────


import pytest


@pytest.mark.asyncio
async def test_send_chunks_redacts_pii_in_delta_text() -> None:
    """The streaming /ingest/chunks path must apply the PII safety
    net to every chunk's ``delta_text`` — otherwise model-echoed
    PII (an email the user put in the prompt that the model
    repeated in its reply) would leak to the gateway unmasked.
    """
    config = EdenConfig(org_id="o", api_key="k")
    client = EdenClient(config)

    class _FakeResp:
        status_code = 200
        text = ""

    captured: dict = {}

    class _FakeHttp:
        async def post(self, url, content=None, headers=None):
            captured["body"] = json.loads(content)
            return _FakeResp()

    client._http = _FakeHttp()
    client._chunk_buffer.extend([
        {
            "event_id": "e1",
            "trace_id": "t1",
            "chunk_index": 0,
            "delta_text": "ping alice@example.com",
            "ttft_ms": 10,
            "itl_ms": None,
            "tpot_ms": 10,
            "received_at_client_ms": 1.0,
        },
        {
            "event_id": "e1",
            "trace_id": "t1",
            "chunk_index": 1,
            "delta_text": "ok",
            "ttft_ms": 10,
            "itl_ms": 5,
            "tpot_ms": 7.5,
            "received_at_client_ms": 1.1,
        },
    ])
    await client._send_chunks()
    body = captured["body"]
    assert body["chunks"][0]["delta_text"] == "ping [REDACTED]"
    assert body["chunks"][1]["delta_text"] == "ok"


@pytest.mark.asyncio
async def test_send_chunks_no_redaction_when_disabled() -> None:
    """When ``redact_on_client=False`` the chunk path must pass
    ``delta_text`` through unchanged."""
    config = EdenConfig(org_id="o", api_key="k", redact_on_client=False)
    client = EdenClient(config)

    class _FakeResp:
        status_code = 200
        text = ""

    captured: dict = {}

    class _FakeHttp:
        async def post(self, url, content=None, headers=None):
            captured["body"] = json.loads(content)
            return _FakeResp()

    client._http = _FakeHttp()
    client._chunk_buffer.append(
        {
            "event_id": "e1",
            "trace_id": "t1",
            "chunk_index": 0,
            "delta_text": "ping alice@example.com",
            "ttft_ms": 10,
            "itl_ms": None,
            "tpot_ms": 10,
            "received_at_client_ms": 1.0,
        }
    )
    await client._send_chunks()
    assert captured["body"]["chunks"][0]["delta_text"] == "ping alice@example.com"


def test_send_batch_retries_408_request_timeout() -> None:
    """Regression: 408 (Request Timeout) was previously NOT in the
    retryable list, so a transient 408 from the gateway would
    short-circuit to ``failed`` without backoff. Now it should
    retry like 429 and 5xx."""
    import asyncio

    import httpx

    from eden_sdk.client import TraceEvent

    responses = [
        httpx.Response(408, text="client timeout"),
        httpx.Response(200, json={"ok": True}),
    ]
    def handler(req):
        return responses.pop(0)
    client = _make_client_with_mock(handler)
    batch = [TraceEvent(payload={"x": 1}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert client.sent == 1, "408 should be retried then succeed"
    assert client.failed == 0


def test_send_batch_does_not_retry_other_4xx() -> None:
    """Sanity: a non-retryable 4xx (e.g. 400) still fails fast and
    only counts as failed."""
    import asyncio

    import httpx

    from eden_sdk.client import TraceEvent

    call_count = 0
    def handler(req):
        nonlocal call_count
        call_count += 1
        return httpx.Response(400, text="bad request")
    client = _make_client_with_mock(handler)
    batch = [TraceEvent(payload={"x": 1}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert call_count == 1, "400 should not be retried"
    assert client.failed == 1
    assert client.sent == 0


def test_send_batch_attaches_user_agent_header() -> None:
    """The SDK should attach a User-Agent header on every
    ingestion POST so the gateway can attribute traffic to
    specific SDK versions in production. The Python SDK was
    shipping without a User-Agent (silently drifting across
    releases) until 0.2.8 — pin the contract here."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"ok": True}, request=request)

    transport, state = _make_mock_transport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    client.start()
    try:
        client.enqueue(TraceEvent(payload={"x": 1}, source_format="openai"))
        client.flush(timeout=2.0)
        ua = state["last_request"].headers.get("User-Agent")
        assert ua is not None
        # Format: ``eden-sdk/<version> (python)`` — the version
        # token lets the gateway roll up ingest counts by SDK
        # release.
        assert ua.startswith("eden-sdk/")
        assert "(python)" in ua
    finally:
        client.shutdown()


def test_send_chunks_attaches_user_agent_header() -> None:
    """Per-chunk ingest must also carry User-Agent (same
    observability story as the batch path)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"ok": True}, request=request)

    transport, state = _make_mock_transport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=transport,
    )
    client.start()
    try:
        client._chunk_buffer.append(
            {
                "event_id": "stream_x",
                "trace_id": "trace_x",
                "chunk_index": 0,
                "delta_text": "hi",
                "ttft_ms": 1.0,
                "itl_ms": None,
                "tpot_ms": None,
                "received_at_client_ms": 0,
            }
        )
        client.flush_chunks(timeout=2.0)
        ua = state["last_request"].headers.get("User-Agent")
        assert ua is not None
        assert ua.startswith("eden-sdk/")
    finally:
        client.shutdown()
