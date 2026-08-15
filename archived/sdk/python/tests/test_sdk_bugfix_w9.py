"""Worker 9 regression pins — Python SDK bug fixes."""

from __future__ import annotations

import asyncio
import logging
import sys
import types
from pathlib import Path

import httpx
import pytest
from _http_body import decode_ingest_body

import eden
from eden_sdk.client import EdenClient, TraceEvent
from eden_sdk.client import __version__ as client_version
from eden_sdk.config import EdenConfig, configure, reset_config
from eden_sdk.logging_forwarder import EdenLoggingHandler, uninstall_logging
from eden_sdk.offline_queue import OfflineQueue


def test_client_user_agent_version_matches_package() -> None:
    """User-Agent must track the package ``__version__`` (not a stale pin)."""
    import eden_sdk

    assert client_version == eden_sdk.__version__
    # Pin against pyproject rather than a literal: the version lives in
    # three places (pyproject, __init__, client) and the risk worth
    # guarding is drift between them, not the specific number. A literal
    # here just means every release bump breaks a test for no signal.
    import re
    from pathlib import Path

    pyproject = (
        Path(__file__).resolve().parents[1] / "pyproject.toml"
    ).read_text(encoding="utf-8")
    declared = re.search(r'^version\s*=\s*"([^"]+)"', pyproject, re.MULTILINE)
    assert declared, "version not found in sdk/python/pyproject.toml"
    assert client_version == declared.group(1)

    from eden_sdk.client import _USER_AGENT

    assert _USER_AGENT == f"eden-sdk/{client_version} (python)"


def test_stumbles_user_agent_matches_client() -> None:
    from eden_sdk.client import _USER_AGENT as client_ua
    from eden_sdk.stumbles import _USER_AGENT as stumble_ua

    assert stumble_ua == client_ua


def test_flush_chunks_wakes_sender_with_long_flush_interval() -> None:
    """``flush_chunks`` must signal ``_wake`` or it stalls past the timeout
    when ``flush_interval_ms`` is larger than the flush timeout.
    """
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(decode_ingest_body(request.content, request.headers))
        return httpx.Response(202, json={"ok": True}, request=request)

    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            flush_interval_ms=60_000,
            dry_run=False,
        ),
        transport=transport,
    )
    client.start()
    try:
        client._chunk_buffer.append(
            {
                "event_id": "s1",
                "trace_id": "t1",
                "chunk_index": 0,
                "delta_text": None,
                "ttft_ms": 1.0,
                "itl_ms": None,
                "tpot_ms": None,
                "received_at_client_ms": 0,
            }
        )
        client.flush_chunks(timeout=2.0)
        assert len(seen) == 1
        assert seen[0]["chunks"][0]["event_id"] == "s1"
    finally:
        client.shutdown()


def test_permanent_4xx_does_not_spill_offline(tmp_path: Path) -> None:
    """Auth/validation 4xx must not poison the durable offline queue."""
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(401, text="unauthorized")

    offline = OfflineQueue(tmp_path / "offline.sqlite3")
    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            offline_queue_path=str(tmp_path / "unused.sqlite3"),
        ),
        transport=transport,
    )
    # Force the already-constructed offline queue.
    client._offline = offline
    client._http = httpx.AsyncClient(timeout=2.0, transport=transport)
    batch = [TraceEvent(payload={"event_id": "bad"}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert call_count == 1
    assert client.failed == 1
    assert offline.size() == 0
    offline.close()


def test_transient_5xx_spills_offline(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    offline = OfflineQueue(tmp_path / "offline.sqlite3")
    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
        ),
        transport=transport,
    )
    client._offline = offline
    client._http = httpx.AsyncClient(timeout=2.0, transport=transport)
    batch = [TraceEvent(payload={"event_id": "tmp"}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert offline.size() >= 1
    offline.close()


def test_flush_offline_acks_after_flush(tmp_path: Path) -> None:
    """Ack only after flush so a crash mid-replay cannot drop durable rows."""
    posts: list[object] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(decode_ingest_body(request.content, request.headers))
        return httpx.Response(202, json={"ok": True}, request=request)

    qpath = tmp_path / "q.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "replay-1"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
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
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10)
        assert n == 1
        assert len(posts) >= 1
        assert offline.size() == 0
    finally:
        client.shutdown()
        offline.close()


def test_flush_offline_skips_ack_on_timeout(tmp_path: Path) -> None:
    """Do not ack SQLite ids when flush times out before send completes."""
    import time

    def handler(request: httpx.Request) -> httpx.Response:
        time.sleep(2.0)
        return httpx.Response(202, json={"ok": True}, request=request)

    qpath = tmp_path / "q-timeout.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "replay-slow"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
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
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10, timeout=0.15)
        assert n == 0
        assert offline.size() == 1
    finally:
        client.shutdown()
        offline.close()


def test_flush_offline_bypasses_sampling(tmp_path: Path) -> None:
    """Durable offline replay must not be dropped by ClientSampler."""
    posts: list[object] = []

    def handler(request: httpx.Request) -> httpx.Response:
        posts.append(decode_ingest_body(request.content, request.headers))
        return httpx.Response(202, json={"ok": True}, request=request)

    qpath = tmp_path / "q-sample.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "replay-sampled"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
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
    client._offline = offline
    # Aggressive sampler would drop non-error events without force/skip.
    from eden_sdk.sampling import ClientSampler

    client._sampler = ClientSampler(
        profile="aggressive", keep_errors=True, enabled=True, rng_seed=0
    )
    client.start()
    try:
        n = client.flush_offline(limit=10)
        assert n == 1
        assert len(posts) >= 1
        assert offline.size() == 0
        assert client.sampled_out == 0
    finally:
        client.shutdown()
        offline.close()


def test_enqueue_marks_evicted_offline_replay_row_unresolved() -> None:
    """``enqueue()``'s bounded-queue backpressure must not silently
    vanish a durable-offline-replay ``TraceEvent`` (``offline_row_id``
    set) on eviction.

    Before the fix, the oldest queued event was simply dropped on
    overflow with no special-casing for events carrying a non-``None``
    ``offline_row_id`` (i.e. events ``flush_offline()`` is replaying
    from the durable SQLite queue). An evicted replay event never
    reached ``_send_format``, so its row id was never added to
    ``_unresolved_offline_rows`` -- ``flush_offline()``'s ack gate then
    read "absent from the unresolved set" as proof of resolution and
    wrongly acked (permanently deleted) a row that was never actually
    attempted.

    This test drives ``enqueue()`` directly (no background thread
    running, so eviction ordering is fully deterministic under this
    thread's control) and asserts the evicted replay rows land in
    ``_unresolved_offline_rows`` while evicted ordinary live-traffic
    events (``offline_row_id is None``) keep vanishing with no trace,
    exactly as before.
    """
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            max_queue=3,
        ),
    )
    # No client.start() -- nothing drains ``_queue`` here, so the
    # eviction sequence below is deterministic, not a race against a
    # background worker.
    client.enqueue(TraceEvent(payload={"event_id": "live-1"}, source_format="openai"))
    client.enqueue(TraceEvent(payload={"event_id": "live-2"}, source_format="openai"))
    for rid in (1, 2, 3, 4, 5):
        client.enqueue(
            TraceEvent(
                payload={"event_id": f"replay-{rid}"},
                source_format="openai",
                offline_row_id=rid,
            ),
            skip_sampling=True,
        )
    # maxsize=3: only the last 3 puts survive -- replay-3, replay-4,
    # replay-5. Everything else (live-1, live-2, replay-1, replay-2)
    # was evicted along the way.
    assert client._queue.qsize() == 3
    remaining_ids = {ev.payload["event_id"] for ev in list(client._queue.queue)}
    assert remaining_ids == {"replay-3", "replay-4", "replay-5"}
    # Only the evicted *replay* rows (1, 2) must be marked unresolved --
    # the evicted live-traffic events carried no offline_row_id and
    # must leave no trace, matching prior behavior.
    assert client._unresolved_offline_rows == {1, 2}
    # Every back-pressure eviction counts toward ``dropped`` (4 here:
    # live-1, live-2, replay-1, replay-2). Counting only the rarer
    # "still full after evicting" path made ``dropped_total()`` silently
    # omit ordinary evictions — fixed in c51429f9.
    assert client.dropped == 4


def test_flush_offline_partial_eviction_does_not_ack_dropped_rows(
    tmp_path: Path,
) -> None:
    """Reviewer's exact repro: a small in-memory ``max_queue`` overflowing
    during ``flush_offline()``'s replay-enqueue loop must not cause the
    back-pressure-dropped rows to be wrongly acked.

    20 durable offline rows, ``max_queue=3`` -- at most 3 of them can
    ever survive in the in-memory queue to reach the mock transport;
    the rest are evicted by ``enqueue()``'s overflow handling before a
    send is ever attempted for them. Before the fix, ``flush_offline()``
    reported ``acked=20`` and deleted all 20 rows from SQLite even
    though only the handful that fit in the queue were ever POSTed.
    The fix must report an acked count that matches exactly the rows
    that were actually delivered, and leave every other row durable
    for a future retry.
    """
    posts: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = decode_ingest_body(request.content, request.headers)
        posts.extend(body)
        return httpx.Response(202, json={"ok": True}, request=request)

    qpath = tmp_path / "q-overflow.sqlite3"
    offline = OfflineQueue(qpath)
    n_rows = 20
    for i in range(n_rows):
        offline.enqueue("openai", {"event_id": f"row-{i}"})
    assert offline.size() == n_rows

    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            # Large enough that the periodic tick can't fire mid-test;
            # the background thread is only meant to wake once,
            # after flush_offline()'s replay-enqueue loop has already
            # run its course and settled the queue's final contents.
            flush_interval_ms=5_000,
            max_queue=3,
        ),
        transport=transport,
    )
    client._offline = offline
    client.start()
    # Best-effort determinism: make CPython less likely to preempt this
    # thread's tight enqueue loop mid-way (which would let the
    # background sender drain partially and change which/how many rows
    # survive to be sent -- immaterial to correctness, but this keeps
    # the "at most max_queue rows are ever delivered" assertion tight).
    old_interval = sys.getswitchinterval()
    sys.setswitchinterval(1.0)
    try:
        n = client.flush_offline(limit=n_rows, timeout=5.0)
        remaining = [
            payload["event_id"] for _, _, payload in offline.drain(limit=100)
        ]
    finally:
        sys.setswitchinterval(old_interval)
        client.shutdown()
        offline.close()

    delivered_ids = {p["event_id"] for p in posts}
    all_ids = {f"row-{i}" for i in range(n_rows)}

    # The bug's exact symptom: acked count blindly matching the full
    # durable backlog regardless of how many rows actually reached the
    # transport.
    assert n != n_rows
    # Back-pressure drops rows silently by design (enqueue()'s
    # docstring) -- at most max_queue of the 20 durable rows can ever
    # survive in the queue to be sent.
    assert 1 <= len(delivered_ids) <= 3
    # The crux of the fix: the acked count must match exactly what was
    # actually delivered, not merely "less than 20".
    assert n == len(delivered_ids)
    # Every row that never reached the transport must remain durable in
    # SQLite for a future flush_offline() retry -- none of them may be
    # silently and permanently lost.
    assert set(remaining) == all_ids - delivered_ids
    assert len(remaining) == n_rows - n


def test_flush_offline_does_not_ack_on_send_failure(tmp_path: Path) -> None:
    """Ack must reflect actual delivery success, not merely that the
    in-flight HTTP attempt *completed*.

    ``_processed_generation`` is bumped unconditionally in
    ``_async_loop``'s ``finally`` block regardless of whether
    ``_send_batch`` actually succeeded -- a failed send re-spills the
    payloads to the offline queue as brand-new rows. Gating the ack
    purely on "queue drained and generation caught up" (the old
    behavior) would report a positive acked count for events that were
    merely re-spilled under new row ids, not delivered.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    qpath = tmp_path / "q-fail.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "replay-fail"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
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
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10, timeout=3.0)
        assert n == 0
        # The original row must survive -- it was never actually
        # delivered, so it must not be acked away. (A re-spilled copy
        # under a new row id may also be present; the important
        # invariant is that nothing was silently lost.)
        assert offline.size() >= 1
    finally:
        client.shutdown()
        offline.close()


def test_flush_offline_acks_permanent_failure_after_one_attempt(
    tmp_path: Path,
) -> None:
    """A permanent, non-retryable rejection (e.g. 422) must be acked
    away after a single attempt, never retried forever.

    Regression: ``_last_failed_generation`` used to be set for ANY
    ``False`` outcome from ``_send_format`` -- both retryable-exhausted
    failures AND permanent non-retryable ones -- even though only
    retryable failures are ever re-spilled to the offline queue
    (permanent 4xx are deliberately dropped, never re-spilled, since
    they can never succeed; see ``test_permanent_4xx_does_not_spill_offline``).
    That meant a permanently-undeliverable offline row's
    ``_last_failed_generation`` mark blocked ``flush_offline``'s ack
    gate forever: the row sat in SQLite and was resent to the same
    doomed endpoint on every subsequent ``flush_offline()`` call,
    indefinitely. The correct behavior (matching pre-regression) is to
    ack it away after the one attempt, exactly like a successful
    delivery, since nothing further will ever be retried for it.
    """
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(422, text="unprocessable")

    qpath = tmp_path / "q-permanent.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "replay-422"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
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
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10, timeout=3.0)
        assert n == 1
        assert offline.size() == 0
        assert call_count == 1

        # Calling flush_offline() again must be a pure no-op -- the row
        # is gone, so there is nothing left to resend. Before the fix,
        # a permanent failure's mark on ``_last_failed_generation``
        # would have kept the row stuck forever and it would have been
        # re-POSTed to the same doomed endpoint on every call.
        for _ in range(2):
            n_again = client.flush_offline(limit=10, timeout=3.0)
            assert n_again == 0
        assert offline.size() == 0
        assert call_count == 1
    finally:
        client.shutdown()
        offline.close()


def test_flush_offline_still_blocks_ack_for_exhausted_retryable_failure(
    tmp_path: Path,
) -> None:
    """A genuinely retryable failure (5xx, exhausted after retries) must
    still correctly block the ack via ``_unresolved_generation`` -- the
    fix for the permanent-failure case above must not loosen this.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="server error")

    qpath = tmp_path / "q-retryable.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "replay-500"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
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
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10, timeout=3.0)
        assert n == 0
        # Original row (and/or its re-spilled successor) must still be
        # present -- it was never delivered and remains retryable.
        assert offline.size() >= 1
    finally:
        client.shutdown()
        offline.close()


def test_flush_offline_mixed_batch_acks_permanent_failure_leaves_retryable(
    tmp_path: Path,
) -> None:
    """Mixed-format-group regression (exploit #1): a permanently-rejected
    ``openai`` row and an exhausted-retryable ``anthropic`` row drained
    and sent in the *same* ``flush_offline()`` call must be acked
    independently.

    Before this fix, the ack decision was aggregated across the whole
    call via a single scalar (``_last_failed_generation``): if *any*
    format group in the batch was left unresolved, the ack was withheld
    for *every* row the call tried to drain -- including rows in other,
    unrelated format groups that were already fully resolved. That
    meant the permanently-undeliverable ``openai`` row was never acked
    and got resent to its doomed endpoint on every single
    ``flush_offline()`` call forever, purely because it happened to
    share a batch with an unrelated failing ``anthropic`` row -- the
    exact poison-pill regression the single-format-group fix was
    supposed to eliminate, still fully reachable in the mixed-batch
    case.
    """
    openai_calls = 0
    anthropic_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal openai_calls, anthropic_calls
        path = request.url.path
        if path.endswith("/ingest/openai"):
            openai_calls += 1
            return httpx.Response(422, text="unprocessable")
        if path.endswith("/ingest/anthropic"):
            anthropic_calls += 1
            return httpx.Response(500, text="server error")
        raise AssertionError(f"unexpected ingest path: {path}")

    qpath = tmp_path / "q-mixed-permanent.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "mixed-422"})
    offline.enqueue("anthropic", {"event_id": "mixed-500"})
    assert offline.size() == 2

    transport = httpx.MockTransport(handler)
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
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10, timeout=3.0)
        # Exactly the permanently-rejected openai row is acked in this
        # same call -- the exhausted-retryable anthropic row is not.
        assert n == 1
        assert openai_calls == 1
        # anthropic 500s are retryable, so a single _send_format attempt
        # for it makes 3 HTTP calls (the configured max_attempts) before
        # exhausting and re-spilling.
        assert anthropic_calls == 3

        remaining_formats = [fmt for _, fmt, _ in offline.drain(limit=100)]
        assert "openai" not in remaining_formats
        assert remaining_formats.count("anthropic") >= 1

        # The permanently-rejected row must never be resent again on
        # subsequent calls, even though the anthropic row keeps being
        # retried in the same batch.
        for _ in range(2):
            client.flush_offline(limit=10, timeout=3.0)
        assert openai_calls == 1
    finally:
        client.shutdown()
        offline.close()


def test_flush_offline_mixed_batch_acks_delivered_row_leaves_retryable(
    tmp_path: Path,
) -> None:
    """Mixed-format-group regression (exploit #2): a genuinely delivered
    (200) ``openai`` row and an exhausted-retryable ``anthropic`` row
    drained and sent in the *same* ``flush_offline()`` call must be
    acked independently.

    Before this fix, the delivered openai row was NOT acked either (the
    call-wide scalar ack gate saw the unrelated anthropic failure and
    withheld the ack for the whole call), so it got resent -- a
    duplicate delivery -- on every subsequent ``flush_offline()`` call
    for as long as the unrelated anthropic row kept failing.
    """
    openai_calls = 0
    anthropic_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal openai_calls, anthropic_calls
        path = request.url.path
        if path.endswith("/ingest/openai"):
            openai_calls += 1
            return httpx.Response(202, json={"ok": True})
        if path.endswith("/ingest/anthropic"):
            anthropic_calls += 1
            return httpx.Response(500, text="server error")
        raise AssertionError(f"unexpected ingest path: {path}")

    qpath = tmp_path / "q-mixed-delivered.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "mixed-200"})
    offline.enqueue("anthropic", {"event_id": "mixed-500b"})
    assert offline.size() == 2

    transport = httpx.MockTransport(handler)
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
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10, timeout=3.0)
        # Exactly the delivered openai row is acked in this same call --
        # the exhausted-retryable anthropic row is not.
        assert n == 1
        assert openai_calls == 1
        # anthropic 500s are retryable, so a single _send_format attempt
        # for it makes 3 HTTP calls (the configured max_attempts) before
        # exhausting and re-spilling.
        assert anthropic_calls == 3

        remaining_formats = [fmt for _, fmt, _ in offline.drain(limit=100)]
        assert "openai" not in remaining_formats
        assert remaining_formats.count("anthropic") >= 1

        # The already-delivered row must never be redelivered
        # (duplicate send) again, even though the anthropic row keeps
        # being retried in the same batch.
        for _ in range(2):
            client.flush_offline(limit=10, timeout=3.0)
        assert openai_calls == 1
    finally:
        client.shutdown()
        offline.close()


def _run_same_format_split_generations(
    tmp_path: Path, *, ok_first: bool
) -> tuple[int, list[str], list[str]]:
    """Shared harness for the per-row-id regression below.

    Enqueues two SAME-format-group (``openai``) offline rows, forces
    ``batch_size=1`` so the background loop can only drain one row per
    tick -- meaning a single ``flush_offline()`` call spans two separate
    ``_send_batch``/``_send_format`` generations for these two rows,
    exactly the reviewer's repro for the per-format-group clobber bug.
    One row's payload always gets a 2xx, the other always gets an
    exhausted-retryable 500 (matched by ``event_id`` in the request
    body, not by call order) -- ``ok_first`` controls which one is
    enqueued (and therefore drained/sent) first, so both the
    "success-then-failure" and "failure-then-success" orderings the
    review flagged as separately broken are exercised.

    Returns ``(acked_count, remaining_event_ids, request_order)``.
    """
    request_order: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = decode_ingest_body(request.content, request.headers)
        event_id = body[0]["event_id"]
        request_order.append(event_id)
        if event_id == "ok-row":
            return httpx.Response(202, json={"ok": True})
        return httpx.Response(500, text="server error")

    qpath = tmp_path / f"q-split-{ok_first}.sqlite3"
    offline = OfflineQueue(qpath)
    if ok_first:
        offline.enqueue("openai", {"event_id": "ok-row"})
        offline.enqueue("openai", {"event_id": "fail-row"})
    else:
        offline.enqueue("openai", {"event_id": "fail-row"})
        offline.enqueue("openai", {"event_id": "ok-row"})
    assert offline.size() == 2

    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
            flush_interval_ms=20,
            batch_size=1,
        ),
        transport=transport,
    )
    client._offline = offline
    client.start()
    try:
        n = client.flush_offline(limit=10, timeout=5.0)
        remaining = [
            payload["event_id"] for _, _, payload in offline.drain(limit=100)
        ]
        return n, remaining, list(request_order)
    finally:
        client.shutdown()
        offline.close()


def test_flush_offline_same_format_split_generations_success_then_failure(
    tmp_path: Path,
) -> None:
    """Terminal per-row-id regression, ordering 1: within one
    ``flush_offline()`` call, a delivered ``openai`` row sent in
    generation 1 and an exhausted-retryable ``openai`` row (SAME format
    group) sent in generation 2 must each keep their own ack outcome.

    With ``batch_size=1`` forced (default is 50, but the same gap is
    reachable any time a backlog of same-format rows exceeds
    ``batch_size`` within one ``flush_offline()`` call, e.g. a replay
    after an outage), the background loop drains and sends these two
    rows in two separate ``_send_batch`` generations. The now-removed
    per-format-group tracker (``self._unresolved_generation: dict[str,
    int]``) kept only the LAST write for the ``openai`` key -- so this
    exact ordering (delivered row's resolved-write happens first, then
    the failing row's unresolved-write clobbers it) left the dict
    reporting ``openai`` as unresolved, and the row that WAS
    successfully delivered was never acked -- a duplicate resend on the
    next ``flush_offline()`` call. Per-row-id tracking must ack exactly
    the delivered row and leave exactly the failed row unacked.
    """
    n, remaining, order = _run_same_format_split_generations(tmp_path, ok_first=True)
    # The failing row is retried (3 attempts, all 500) so it appears
    # multiple times in ``order`` -- what matters is that generation 1
    # (the single ``ok-row`` request) happened entirely before
    # generation 2 (the three ``fail-row`` requests).
    assert order.count("ok-row") == 1
    assert order.count("fail-row") == 3
    assert order.index("ok-row") < order.index("fail-row")
    assert n == 1
    assert "ok-row" not in remaining
    assert remaining.count("fail-row") >= 1


def test_flush_offline_same_format_split_generations_failure_then_success(
    tmp_path: Path,
) -> None:
    """Terminal per-row-id regression, ordering 2 (the reviewer's repro
    order): the failing ``openai`` row is sent in generation 1 and the
    delivered ``openai`` row in generation 2 of the SAME
    ``flush_offline()`` call.

    Under the old per-format-group dict this ordering also clobbered
    the outcome -- here the failing row's write landed first and the
    delivered row's resolved-write happened to overwrite it, which
    happened to leave ``openai`` marked resolved in this particular
    order (the opposite of the other ordering) -- either way the dict
    could not represent "one row succeeded, the other failed" for the
    same key at once. Per-row-id tracking is order-independent: the
    delivered row is acked and the failed row is not, regardless of
    which one was attempted first.
    """
    n, remaining, order = _run_same_format_split_generations(tmp_path, ok_first=False)
    # Generation 1 is the three retried ``fail-row`` requests; generation
    # 2 is the single ``ok-row`` request, entirely afterward.
    assert order.count("ok-row") == 1
    assert order.count("fail-row") == 3
    assert order.index("fail-row") < order.index("ok-row")
    assert n == 1
    assert "ok-row" not in remaining
    assert remaining.count("fail-row") >= 1


def test_spill_offline_does_not_duplicate_durable_row_across_retries(
    tmp_path: Path,
) -> None:
    """Regression: a durably-queued row that keeps failing across repeated
    ``flush_offline()`` cycles must not duplicate exponentially in SQLite.

    Before the fix, ``_spill_offline`` unconditionally INSERTed a brand
    new row for every payload being re-spilled after a retryable send
    failure -- even when that payload already originated from an
    existing durable ``OfflineQueue`` row (i.e. one ``flush_offline()``
    had just drained via ``TraceEvent.offline_row_id``).
    ``OfflineQueue.drain()`` is read-only (deletion only ever happens
    via explicit ``ack()``), so the original row was never removed --
    each failing retry cycle doubled the row count for that one logical
    event: confirmed 1 -> 2 -> 4 -> 8 -> 16 across 4 calls pre-fix. The
    fix updates the existing row in place (same id) instead, so the
    count must stay at exactly 1 across many repeated failing cycles.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="server error")

    qpath = tmp_path / "q-dup.sqlite3"
    offline = OfflineQueue(qpath)
    offline.enqueue("openai", {"event_id": "always-fails"})
    assert offline.size() == 1

    transport = httpx.MockTransport(handler)
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
    client._offline = offline
    client.start()
    try:
        for cycle in range(5):
            n = client.flush_offline(limit=100, timeout=3.0)
            # Never delivered (always 500) and never permanently
            # rejected -- nothing should ever be acked.
            assert n == 0
            # The exponential-growth bug's exact symptom: row count for
            # this one logical event doubling every cycle. The fix must
            # keep it bounded at exactly 1 (the original row, updated
            # in place) no matter how many retry cycles run.
            assert offline.size() == 1, (
                f"row count grew to {offline.size()} after cycle {cycle + 1}"
            )
        remaining = offline.drain(limit=10)
        assert len(remaining) == 1
        assert remaining[0][2]["event_id"] == "always-fails"
    finally:
        client.shutdown()
        offline.close()


def test_spill_offline_still_inserts_new_row_for_fresh_failure(
    tmp_path: Path,
) -> None:
    """Non-regression: a FRESH failure (live traffic, never durable
    before) must still be spilled as a brand-new offline-queue row --
    only the re-spill-of-an-already-durable-row path changes.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    offline = OfflineQueue(tmp_path / "q-fresh.sqlite3")
    assert offline.size() == 0

    transport = httpx.MockTransport(handler)
    client = EdenClient(
        EdenConfig(
            org_id="o",
            api_key="k",
            base_url="http://test.invalid",
            dry_run=False,
        ),
        transport=transport,
    )
    client._offline = offline
    client._http = httpx.AsyncClient(timeout=2.0, transport=transport)
    # No offline_row_id -- this is a fresh, never-durable live-traffic
    # event, exactly like TraceEvents built by ordinary instrumentation.
    batch = [TraceEvent(payload={"event_id": "fresh-fail"}, source_format="openai")]
    asyncio.run(client._send_batch(batch))
    assert offline.size() == 1
    rows = offline.drain(limit=10)
    assert len(rows) == 1
    _, fmt, payload = rows[0]
    assert fmt == "openai"
    assert payload["event_id"] == "fresh-fail"
    offline.close()


def test_otel_headers_include_org_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """OTLP exporter must send X-Org-Id (required with API key)."""
    reset_config()
    configure(org_id="org-otel", api_key="key-otel", project_id="proj")

    captured: dict[str, object] = {}

    class _FakeExporter:
        def __init__(self, endpoint=None, headers=None):
            captured["endpoint"] = endpoint
            captured["headers"] = dict(headers or {})

    class _FakeProcessor:
        def __init__(self, exporter):
            self.exporter = exporter

    class _FakeProvider:
        def __init__(self, resource=None):
            self.resource = resource
            self.processors = []

        def add_span_processor(self, proc):
            self.processors.append(proc)

    class _FakeResource:
        @staticmethod
        def create(attrs):
            return attrs

    class _FakeTraceMod:
        @staticmethod
        def set_tracer_provider(provider):
            captured["provider"] = provider

    import sys

    fake_otel = types.ModuleType("opentelemetry")
    fake_trace = types.ModuleType("opentelemetry.trace")
    fake_trace.set_tracer_provider = _FakeTraceMod.set_tracer_provider  # type: ignore[attr-defined]
    fake_otel.trace = fake_trace  # type: ignore[attr-defined]

    fake_exporter = types.ModuleType(
        "opentelemetry.exporter.otlp.proto.http.trace_exporter"
    )
    fake_exporter.OTLPSpanExporter = _FakeExporter  # type: ignore[attr-defined]
    # Parent packages required for nested imports.
    for name in (
        "opentelemetry.exporter",
        "opentelemetry.exporter.otlp",
        "opentelemetry.exporter.otlp.proto",
        "opentelemetry.exporter.otlp.proto.http",
        "opentelemetry.sdk",
        "opentelemetry.sdk.trace",
    ):
        if name not in sys.modules:
            monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    fake_resources = types.ModuleType("opentelemetry.sdk.resources")
    fake_resources.Resource = _FakeResource  # type: ignore[attr-defined]
    fake_sdk_trace = types.ModuleType("opentelemetry.sdk.trace")
    fake_sdk_trace.TracerProvider = _FakeProvider  # type: ignore[attr-defined]
    fake_export = types.ModuleType("opentelemetry.sdk.trace.export")
    fake_export.BatchSpanProcessor = _FakeProcessor  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "opentelemetry", fake_otel)
    monkeypatch.setitem(sys.modules, "opentelemetry.trace", fake_trace)
    monkeypatch.setitem(
        sys.modules,
        "opentelemetry.exporter.otlp.proto.http.trace_exporter",
        fake_exporter,
    )
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.resources", fake_resources)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace", fake_sdk_trace)
    monkeypatch.setitem(sys.modules, "opentelemetry.sdk.trace.export", fake_export)

    import eden_sdk.otel as otel_mod

    otel_mod._configured = False
    otel_mod.configure_exporter(service_name="test-svc", framework="pytest")

    headers = captured["headers"]
    assert isinstance(headers, dict)
    assert headers.get("X-Org-Id") == "org-otel"
    assert headers.get("X-Org-Api-Key") == "key-otel"
    assert headers.get("X-Project-Id") == "proj"
    assert headers.get("X-Source-Framework") == "pytest"
    assert "/orgs/org-otel/ingest/otel" in str(captured["endpoint"])
    # Reset so later tests can call ``eden.instrument()``.
    otel_mod._configured = False


def test_logging_forwarder_skips_eden_sdk_loggers() -> None:
    """SDK WARNINGs must not re-enter the logging → enqueue path."""
    from eden_sdk import client as client_mod

    client_mod.reset_default_client()
    configure(org_id="o", api_key="k", dry_run=True)
    uninstall_logging()
    handler = EdenLoggingHandler(level=logging.WARNING)
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        before = get_default_client_sent()
        logging.getLogger("eden_sdk.client").warning("synthetic sdk warning")
        after = get_default_client_sent()
        assert after == before
        # App loggers still forward.
        logging.getLogger("app.demo").error("boom")
        assert get_default_client_sent() == before + 1
    finally:
        root.removeHandler(handler)
        uninstall_logging()


def get_default_client_sent() -> int:
    from eden_sdk.client import get_default_client

    return get_default_client().sent


def test_langchain_stream_and_framework_share_trace_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Chunks and the aggregate llm.end event must share one trace_id."""
    import sys

    from eden_sdk.client import get_default_client, reset_default_client
    from eden_sdk.instrumentations import langchain as lc

    # Minimal langchain-core fake (fixture lives in test_instrumentations).
    callbacks = types.ModuleType("langchain_core.callbacks")

    class BaseCallbackHandler:
        pass

    class _Mgr:
        def __init__(self):
            self.handlers: list = []

        def add_handler(self, h):
            if h not in self.handlers:
                self.handlers.append(h)

        def remove_handler(self, h):
            if h in self.handlers:
                self.handlers.remove(h)

    _mgr = _Mgr()

    def get_callback_manager():
        return _mgr

    def set_handler(h):
        _mgr.add_handler(h)

    callbacks.BaseCallbackHandler = BaseCallbackHandler  # type: ignore[attr-defined]
    callbacks.get_callback_manager = get_callback_manager  # type: ignore[attr-defined]
    callbacks.set_handler = set_handler  # type: ignore[attr-defined]
    core = types.ModuleType("langchain_core")
    monkeypatch.setitem(sys.modules, "langchain_core", core)
    monkeypatch.setitem(sys.modules, "langchain_core.callbacks", callbacks)

    reset_default_client()
    configure(org_id="o", api_key="k", dry_run=True, capture_chunk_text=True)
    import eden_sdk.otel as otel_mod

    otel_mod._configured = False
    lc.uninstall()
    eden.instrument("langchain")
    handler = next(h for h in _mgr.handlers if isinstance(h, BaseCallbackHandler))

    client = get_default_client()
    captured: list[dict] = []
    original = client.enqueue

    def _capture(event: TraceEvent) -> None:
        captured.append(dict(event.payload))
        return original(event)

    client.enqueue = _capture  # type: ignore[method-assign]
    pinned = client._chunk_buffer

    run_id = "lc-join-1"
    handler.on_llm_start(
        serialized={"name": "openai-llm"},
        prompts=["hi"],
        run_id=run_id,
        parent_run_id=None,
        tags=[],
        metadata={},
    )
    handler.on_llm_new_token(token="Hello", run_id=run_id)
    handler.on_llm_new_token(token="!", run_id=run_id)
    handler.on_llm_end(
        response=types.SimpleNamespace(
            llm_output={"token_usage": {"prompt_tokens": 1, "completion_tokens": 1}},
            response_metadata={"model_name": "gpt-4o-mini"},
            generations=[[types.SimpleNamespace(text="Hello!")]],
        ),
        run_id=run_id,
        parent_run_id=None,
    )

    assert len(pinned) == 2
    chunk_tid = pinned[0]["trace_id"]
    assert all(c["trace_id"] == chunk_tid for c in pinned)
    framework = [e for e in captured if e.get("event_type") == "agent.run"]
    assert framework, f"expected framework event, got {captured!r}"
    assert framework[-1]["trace_id"] == chunk_tid
    lc.uninstall()


def test_gzip_ingest_still_round_trips() -> None:
    """Do not regress K35 Content-Encoding on batch ingest.

    N2: the wire encoding is zstd when zstandard is installed and gzip
    otherwise — the assertion accepts either, and the body is decoded
    via the encoding-agnostic ``decode_ingest_body`` helper.
    """
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["encoding"] = request.headers.get("content-encoding")
        seen["decoded"] = decode_ingest_body(request.content, request.headers)
        return httpx.Response(200, json={"accepted": 1})

    cfg = EdenConfig(org_id="o", api_key="k", base_url="https://api.example.com")
    transport = httpx.MockTransport(handler)
    client = EdenClient(cfg, transport=transport)
    client._http = httpx.AsyncClient(timeout=2.0, transport=transport)
    asyncio.run(
        client._send_batch(
            [TraceEvent(payload={"event_id": "e1"}, source_format="openai")]
        )
    )
    assert seen["encoding"] in ("gzip", "zstd")
    decoded = seen["decoded"]
    assert isinstance(decoded, list)
    assert decoded[0]["event_id"] == "e1"
