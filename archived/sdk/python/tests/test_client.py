"""Tests for the batched HTTP client (EdenClient)."""

from __future__ import annotations

import threading
import time

import httpx
import pytest
from _http_body import decode_ingest_body

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


def test_get_default_client_resets_singleton_on_start_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A ``start()`` failure must not poison the singleton.

    Regression: ``_default = EdenClient()`` used to be assigned BEFORE
    ``start()`` was called. If ``start()`` raised, the exception
    propagated but ``_default`` still referenced the broken instance --
    every later ``get_default_client()`` call returned the same dead
    client with no retry (100% event loss for the rest of the
    process). The fix must reset the module-global back to ``None`` on
    failure so the next call gets a fresh attempt.
    """
    from eden_sdk import client as cli_mod

    cli_mod.reset_default_client()
    real_start = EdenClient.start
    calls = {"n": 0}

    def flaky_start(self: EdenClient) -> None:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated: sender thread failed to start")
        real_start(self)

    monkeypatch.setattr(EdenClient, "start", flaky_start)

    with pytest.raises(RuntimeError):
        get_default_client()
    # The broken client must not have been published as the singleton.
    assert cli_mod._default is None

    # The next call must construct a brand-new client and succeed.
    client = get_default_client()
    assert calls["n"] == 2
    assert client is not None
    assert cli_mod._default is client
    assert client._loop_started.is_set()
    assert not client._loop_failed


def test_get_default_client_constructs_once_under_concurrent_callers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Concurrent first-callers must share one construction, and every
    caller must get back a fully-started client -- never a
    half-initialized one.

    Regression for holding the process-wide lock for the entire
    construct+start() duration (including start()'s up-to-1s blocking
    wait): callers should serialize on the slow work without every
    caller paying the full lock hold, and none should observe a client
    whose start() hasn't resolved yet.
    """
    from eden_sdk import client as cli_mod

    cli_mod.reset_default_client()
    construct_count = {"n": 0}
    real_init = EdenClient.__init__

    def counting_init(self: EdenClient, *a, **kw) -> None:
        construct_count["n"] += 1
        time.sleep(0.05)  # widen the race window
        real_init(self, *a, **kw)

    monkeypatch.setattr(EdenClient, "__init__", counting_init)

    results: list[EdenClient] = []
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            results.append(get_default_client())
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert construct_count["n"] == 1
    assert len({id(c) for c in results}) == 1
    for c in results:
        assert c._loop_started.is_set()
        assert not c._loop_failed


def test_reset_default_client_does_not_block_behind_slow_construction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``reset_default_client()`` must not queue up behind an in-flight
    first-time construction.

    This is the test that actually discriminates the lock-granularity
    fix: ``test_get_default_client_constructs_once_under_concurrent_callers``
    (above) passes unchanged whether the slow construct+``start()`` work
    is serialized on the same process-wide lock ``reset_default_client()``
    uses, or on a separate ``_init_lock`` -- it only ever calls
    ``get_default_client()``, so it can't tell the two designs apart.

    Here we hold a *known-slow* ``start()`` open on one thread and time
    how long a concurrent ``reset_default_client()`` call takes. If
    ``get_default_client()`` held the *same* lock that
    ``reset_default_client()`` needs for the whole slow duration (the
    pre-fix design), this call would block for ~the full sleep. With the
    fix (a dedicated ``_init_lock`` for the slow work, and only a
    short-lived ``_lock`` for the ``_default`` pointer), it returns
    almost immediately.
    """
    from eden_sdk import client as cli_mod

    cli_mod.reset_default_client()
    real_start = EdenClient.start
    slow_seconds = 0.4

    def slow_start(self: EdenClient) -> None:
        time.sleep(slow_seconds)
        real_start(self)

    monkeypatch.setattr(EdenClient, "start", slow_start)

    holder: list[EdenClient] = []
    construction = threading.Thread(target=lambda: holder.append(get_default_client()))
    construction.start()
    # Give the construction thread time to acquire `_init_lock` and enter
    # the slowed `start()` call before we race `reset_default_client()`
    # against it.
    time.sleep(0.1)

    t0 = time.perf_counter()
    cli_mod.reset_default_client()
    dt = time.perf_counter() - t0

    construction.join(timeout=slow_seconds + 2.0)
    assert not construction.is_alive()

    # A generous fraction of `slow_seconds` -- on the pre-fix design this
    # call would take ~slow_seconds (minus the 0.1s head start); on the
    # fix it should return in well under a millisecond of real work.
    assert dt < slow_seconds / 2

    if holder:
        holder[0].shutdown(timeout=2.0)
    cli_mod.reset_default_client()


def test_atexit_shutdown_is_lock_guarded_against_concurrent_get_default_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``_atexit_shutdown`` must hold the same lock as
    ``get_default_client`` / ``reset_default_client``.

    Regression: ``_atexit_shutdown`` used to read/clear the
    module-global ``_default`` with no lock at all. A thread calling
    ``get_default_client()`` concurrently with atexit teardown could
    get a reference to a client whose worker thread was already gone,
    and anything it then enqueued would sit in ``self._queue`` forever
    with nothing left to drain it. With the lock, a racing caller must
    block behind the in-progress shutdown and then receive a brand-new,
    fully-started client -- never the one that's mid-teardown.
    """
    from eden_sdk import client as cli_mod

    cli_mod.reset_default_client()
    original = get_default_client()
    assert original._loop_started.is_set()

    real_flush = EdenClient.flush

    def slow_flush(self: EdenClient, timeout: float = 2.0) -> None:
        time.sleep(0.2)
        real_flush(self, timeout=timeout)

    monkeypatch.setattr(EdenClient, "flush", slow_flush)

    results: list[EdenClient] = []

    def racer() -> None:
        # Give _atexit_shutdown a head start so it's already holding
        # the lock (inside slow_flush) when this thread calls in.
        time.sleep(0.02)
        results.append(get_default_client())

    t = threading.Thread(target=racer)
    t.start()
    cli_mod._atexit_shutdown()
    t.join()

    assert len(results) == 1
    new_client = results[0]
    # The racer must have been blocked until teardown finished, and
    # then gotten a fresh client -- never the one being shut down.
    assert new_client is not original
    assert new_client._loop_started.is_set()
    assert not new_client._loop_failed
    assert cli_mod._default is new_client
    new_client.shutdown()


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
        # ``client.sent`` is cumulative across cycles (it's
        # the lifetime counter). The latch regression is
        # about the second ``start()`` actually waiting for
        # the new loop — that the second ``enqueue()`` was
        # accepted and the second ``flush()`` returned is
        # the test of record.
        assert client.sent >= 1
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


@pytest.mark.asyncio
async def test_send_chunks_redacts_pii_in_delta_text() -> None:
    """The streaming /ingest/chunks path must apply the PII safety
    net to every chunk's ``delta_text`` — otherwise model-echoed
    PII (an email the user put in the prompt that the model
    repeated in its reply) would leak to the gateway unmasked.
    """
    config = EdenConfig(org_id="o", api_key="k", redact_on_client=True)
    client = EdenClient(config)

    class _FakeResp:
        status_code = 200
        text = ""

    captured: dict = {}

    class _FakeHttp:
        async def post(self, url, content=None, headers=None):
            captured["body"] = decode_ingest_body(content, headers)
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
            captured["body"] = decode_ingest_body(content, headers)
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


def test_start_shutdown_start_cycle_resets_latch() -> None:
    """``start()`` after ``shutdown()`` must wait for the new
    loop to come up. The previous implementation never reset
    the ``_loop_started`` latch, so the second ``start()``
    returned immediately and the first ``enqueue()`` raced
    against an in-flight ``httpx.AsyncClient`` that was
    about to be replaced.

    Regression: the second-start fast path was a real bug —
    it only surfaced under the test runner when teardown
    reused an EdenClient across cases.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(202, json={"ok": True}, request=request)

    transport, _state = _make_mock_transport(handler)
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
    # First cycle: start, enqueue, shutdown.
    client.start()
    client.enqueue(TraceEvent(payload={"i": 0}, source_format="openai"))
    client.flush(timeout=2.0)
    client.shutdown()
    # Second cycle: start must block until the new loop is up.
    client.start()
    try:
        # Latch must have been observed as set by the new
        # thread (i.e. the new loop is actually running and
        # the AsyncClient is ready). If the previous bug
        # regresses, the second ``start()`` would return
        # *before* the new ``_async_loop`` reached its
        # ``self._loop_started.set()`` line.
        assert client._loop_started.is_set()
        client.enqueue(TraceEvent(payload={"i": 1}, source_format="openai"))
        client.flush(timeout=2.0)
        # ``client.sent`` is cumulative across cycles (it's
        # the lifetime counter). The latch regression is
        # about the second ``start()`` actually waiting for
        # the new loop — that the second ``enqueue()`` was
        # accepted and the second ``flush()`` returned is
        # the test of record.
        assert client.sent >= 1
    finally:
        client.shutdown()


# ── Bug A: sender thread death on AsyncClient init failure ──────────────


def test_start_raises_runtime_error_when_async_client_init_fails(
    monkeypatch,
) -> None:
    """Regression: ``start()`` used to silently time out on the
    ``_loop_started`` latch and return as if the sender was up,
    while the worker thread had already died because
    ``httpx.AsyncClient(...)`` construction raised. Every subsequent
    ``enqueue()`` would land in a queue that nothing drained --
    events silently disappeared into the void.

    The fix catches the exception in ``_run_loop``, logs it, and
    flips a failure latch that ``start()`` checks so the caller
    gets a clear ``RuntimeError`` instead of a silent lie.
    """
    import asyncio

    def _exploding_async_client(*_args, **_kwargs):
        raise RuntimeError("simulated httpx.AsyncClient init failure")

    monkeypatch.setattr(httpx, "AsyncClient", _exploding_async_client)

    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=50,
        ),
        transport=httpx.MockTransport(lambda req: httpx.Response(200)),
    )
    try:
        raised = None
        try:
            client.start()
        except RuntimeError as exc:
            raised = exc
        assert raised is not None, (
            "start() must surface a RuntimeError when the worker thread "
            "dies before _loop_started is set -- otherwise the caller "
            "thinks the sender is up and enqueue() silently drops events."
        )
        assert "sender thread failed to start" in str(raised)
        # The failure latch must be flipped so callers (and tests)
        # can introspect post-mortem.
        assert client._loop_failed is True
        # Thread must have exited, not be running forever in the
        # background.
        if client._thread is not None:
            client._thread.join(timeout=2.0)
            assert not client._thread.is_alive(), (
                "the worker thread must not be alive after start() failed"
            )
    finally:
        # Cancel any lingering tasks the worker may have spawned
        # (defensive -- the run_loop exception path is supposed to
        # shut everything down, but the test monkey-patches the
        # constructor so the loop never actually starts).
        try:
            asyncio.get_event_loop()
        except RuntimeError:
            pass
        client.shutdown()


# ── Bug B: Retry-After HTTP-date parsing ────────────────────────────────


def test_parse_retry_after_accepts_delta_seconds() -> None:
    """Plain integer / float seconds form must still work."""
    client = EdenClient(
        EdenConfig(org_id="o", api_key="k", dry_run=True)
    )
    try:
        assert client._parse_retry_after("5", fallback=1.0) == 5.0
        assert client._parse_retry_after("0.25", fallback=1.0) == 0.25
        # Cap at 30s so a misconfigured gateway can't stall us.
        assert client._parse_retry_after("9999", fallback=1.0) == 30.0
    finally:
        client.shutdown()


def test_parse_retry_after_accepts_http_date_future() -> None:
    """HTTP-date form (RFC 7231) must parse to a positive delay."""
    from datetime import datetime, timedelta, timezone

    client = EdenClient(
        EdenConfig(org_id="o", api_key="k", dry_run=True)
    )
    try:
        future = datetime.now(timezone.utc) + timedelta(seconds=10)
        # RFC 7231 / RFC 1123 format used by all real gateways.
        date_str = future.strftime("%a, %d %b %Y %H:%M:%S GMT")
        delay = client._parse_retry_after(date_str, fallback=99.0)
        # Should be ~10s; allow generous slack for clock + parse skew.
        assert 8.0 <= delay <= 12.0
    finally:
        client.shutdown()


def test_parse_retry_after_accepts_http_date_past() -> None:
    """A past HTTP-date means \"retry now\" -- clamp to 0, don't
    accidentally back off further."""
    from datetime import datetime, timedelta, timezone

    client = EdenClient(
        EdenConfig(org_id="o", api_key="k", dry_run=True)
    )
    try:
        past = datetime.now(timezone.utc) - timedelta(minutes=5)
        date_str = past.strftime("%a, %d %b %Y %H:%M:%S GMT")
        assert client._parse_retry_after(date_str, fallback=99.0) == 0.0
    finally:
        client.shutdown()


def test_parse_retry_after_falls_back_on_garbage() -> None:
    """Unparseable input must fall back to exponential backoff --
    a malformed Retry-After must never wedge the retry loop."""
    client = EdenClient(
        EdenConfig(org_id="o", api_key="k", dry_run=True)
    )
    try:
        assert client._parse_retry_after("not a date", fallback=2.5) == 2.5
        assert client._parse_retry_after("", fallback=2.5) == 2.5
        assert client._parse_retry_after("garbage", fallback=99.0) == 99.0
    finally:
        client.shutdown()


def test_send_batch_retries_after_http_date_retry_after() -> None:
    """Regression: the original code did ``float(retry_after)``
    which raised ``ValueError`` on HTTP-date strings like
    ``\"Wed, 21 Oct 2015 07:28:00 GMT\"`` -- the except branch
    silently fell back to exponential backoff, ignoring the
    server's explicit hint. Now the gateway's HTTP-date
    Retry-After is honoured, which means retry happens on
    the server's schedule, not ours.
    """
    import asyncio
    from datetime import datetime, timedelta, timezone

    import httpx

    from eden_sdk.client import TraceEvent

    # Build a Retry-After that's 1 second in the future.
    future = datetime.now(timezone.utc) + timedelta(seconds=1)
    date_str = future.strftime("%a, %d %b %Y %H:%M:%S GMT")

    call_count = 0
    def handler(req):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(503, text="slow", headers={"retry-after": date_str})
        return httpx.Response(200, json={"ok": True})

    client = _make_client_with_mock(handler)
    batch = [TraceEvent(payload={"x": 1}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert call_count == 2, "HTTP-date Retry-After should drive the retry"
    assert client.sent == 1
    assert client.failed == 0


# ── Bug C: chunk buffer upper bound ─────────────────────────────────────


def test_chunk_buffer_enforces_upper_bound() -> None:
    """Regression: ``self._chunk_buffer`` had no max size. A
    runaway streaming response (millions of small chunks)
    could OOM the process before the worker thread flushed.
    The cap + oldest-drop semantics mirror the regular
    event queue: producers never block, oldest entries are
    evicted on overflow, and the buffer stays bounded.
    """
    # dry_run=False so _enqueue_chunk actually pushes to the buffer.
    # We never call start(), so nothing tries to drain it.
    client = EdenClient(
        EdenConfig(org_id="o", api_key="k", dry_run=False)
    )
    try:
        # Force a tiny cap so we can hit overflow in a unit test.
        client._chunk_buffer_max = 8
        for i in range(50):
            client._enqueue_chunk({"event_id": f"e{i}", "chunk_index": i})
        # Cap holds: never above max.
        assert len(client._chunk_buffer) == 8
        # Oldest entries were evicted: the surviving set is the
        # tail of the input stream.
        assert client._chunk_buffer[0]["chunk_index"] == 42
        assert client._chunk_buffer[-1]["chunk_index"] == 49
        # Eviction was accounted for on the dropped counter.
        assert client.dropped == 42
    finally:
        client.shutdown()


def test_chunk_buffer_defensive_trim_in_send_chunks() -> None:
    """Instrumentations may bypass ``_enqueue_chunk`` and append
    directly to ``self._chunk_buffer``. ``_send_chunks`` must
    defensively trim the buffer to the cap on flush, so a
    runaway stream never OOMs the process between worker ticks.
    """
    import asyncio

    class _FakeResp:
        status_code = 200
        text = ""

    captured: dict = {}

    class _FakeHttp:
        async def post(self, url, content=None, headers=None):
            captured["body"] = decode_ingest_body(content, headers)
            return _FakeResp()

    config = EdenConfig(org_id="o", api_key="k")
    client = EdenClient(config)
    try:
        client._chunk_buffer_max = 4
        # Simulate a producer that piled up 10 chunks between
        # worker ticks (e.g. a fast streaming response).
        for i in range(10):
            client._chunk_buffer.append(
                {
                    "event_id": "e",
                    "trace_id": "t",
                    "chunk_index": i,
                    "delta_text": f"chunk-{i}",
                    "ttft_ms": 1.0,
                    "itl_ms": None,
                    "tpot_ms": None,
                    "received_at_client_ms": 0,
                }
            )
        client._http = _FakeHttp()
        asyncio.run(client._send_chunks())
        # The shipped batch is at most ``_chunk_buffer_max`` entries.
        assert len(captured["body"]["chunks"]) == 4
        # It is the *tail* of the input (oldest dropped).
        assert captured["body"]["chunks"][0]["chunk_index"] == 6
        assert captured["body"]["chunks"][-1]["chunk_index"] == 9
        # Eviction was counted.
        assert client.dropped == 6
    finally:
        client.shutdown()
