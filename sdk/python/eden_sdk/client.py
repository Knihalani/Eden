"""Batched, async, fire-and-forget HTTP sender.

The :class:`EdenClient` is the SDK's only network surface. Events from
auto-instrumentation or the :func:`eden.trace` context manager are
enqueued, then flushed either when the batch fills or when a timer
fires. The hot path is *non-blocking*: callers never wait on the
network — they just append to an in-memory queue and return.

Threading
---------
- A single background thread runs the async event loop with an
  ``httpx.AsyncClient`` connection pool.
- Producer threads (the user's main code, callback handlers, etc.)
  call :meth:`enqueue` which is just a ``queue.put_nowait`` plus
  a ``threading.Event.set`` to wake the loop.
- The loop pops events, builds a batch, and ``await``s the HTTP POST.
- On a full queue (back-pressure) the oldest event is dropped with
  a warning — the SDK must never block user code.

Shutdown
--------
Call :func:`shutdown` (or use the SDK as a context manager via
:func:`get_default_client` returning a singleton) to flush and stop
the worker. ``atexit`` registers a best-effort flush.
"""

from __future__ import annotations

import atexit
import json
import logging
import queue as _queue
import threading
import time
from collections import deque
from typing import Any, Optional

import httpx

from eden_sdk.config import EdenConfig, get_config

logger = logging.getLogger("eden_sdk.client")


# ── Public types ──────────────────────────────────────────────────────


class TraceEvent:
    """A single telemetry event ready for the wire.

    The SDK only ships JSON-safe dicts — this is a thin convenience
    wrapper that records the source format and the dict payload so
    the sender can route to the right ingestion endpoint.
    """

    __slots__ = ("source_format", "payload", "dropped", "enqueued_at")

    def __init__(
        self,
        payload: dict[str, Any],
        source_format: str = "openai",
    ) -> None:
        self.source_format = source_format
        self.payload = payload
        self.dropped = False
        self.enqueued_at = time.monotonic()

    def to_json_bytes(self) -> bytes:
        return json.dumps(self.payload, default=str).encode("utf-8")


# ── Sender ────────────────────────────────────────────────────────────


class EdenClient:
    """Batched, async HTTP sender.

    Most users never instantiate this directly — :func:`get_default_client`
    returns a process-wide singleton. Tests can build their own
    :class:`EdenClient` with a custom config.
    """

    # Per-batch endpoint format: we POST one event at a time, but the
    # ingestion route also accepts a JSON array. The default decoder
    # accepts both shapes. We use array form to halve the number of
    # round-trips for bursts of activity.
    _BATCH_AS_ARRAY = True

    def __init__(self, config: Optional[EdenConfig] = None) -> None:
        self.config = config or get_config()
        self._queue: _queue.Queue[TraceEvent] = _queue.Queue(
            maxsize=self.config.max_queue
        )
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._http: Optional[httpx.AsyncClient] = None
        self._loop_started = threading.Event()
        self._dropped_total = 0
        self._sent_total = 0
        self._failed_total = 0
        self._latency_window: deque[float] = deque(maxlen=1024)

    # ── Lifecycle ────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the background sender thread (idempotent)."""
        if self._thread is not None and self._thread.is_alive():
            return
        if not self.config.enabled:
            logger.debug("eden client disabled; not starting sender")
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run_loop, name="eden-sdk-sender", daemon=True
        )
        self._thread.start()
        # Wait until the loop has its asyncio loop ready so that
        # shutdown() can join immediately.
        self._loop_started.wait(timeout=1.0)

    def shutdown(self, timeout: float = 5.0) -> None:
        """Stop the sender, draining the queue first."""
        if self._thread is None:
            return
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=timeout)
        self._thread = None

    # ── Producer API ─────────────────────────────────────────────────

    def enqueue(self, event: TraceEvent) -> None:
        """Non-blocking enqueue. Drops oldest on overflow.

        Designed to be called from any thread — including the
        framework callbacks running on the user's event loop.
        """
        if not self.config.enabled:
            return
        if self.config.dry_run:
            self._sent_total += 1
            logger.debug(
                "eden[dry-run] fmt=%s keys=%s",
                event.source_format,
                sorted(event.payload.keys()),
            )
            return
        try:
            self._queue.put_nowait(event)
        except _queue.Full:
            # Drop the oldest to make room.
            try:
                self._queue.get_nowait()
            except _queue.Empty:
                pass
            try:
                self._queue.put_nowait(event)
            except _queue.Full:
                self._dropped_total += 1
                logger.warning("eden sdk: queue full, dropped event")
        self._wake.set()

    def flush(self, timeout: float = 2.0) -> None:
        """Block until the current queue is drained (best-effort)."""
        if not self.config.enabled:
            return
        deadline = time.monotonic() + timeout
        while not self._queue.empty() and time.monotonic() < deadline:
            time.sleep(0.01)
        # Give in-flight HTTP up to half the timeout to complete.
        time.sleep(min(0.2, timeout / 4))

    # ── Internal loop ────────────────────────────────────────────────

    def _run_loop(self) -> None:
        import asyncio

        asyncio.run(self._async_loop())

    async def _async_loop(self) -> None:
        import asyncio

        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(self.config.timeout_s),
            limits=httpx.Limits(
                max_connections=16, max_keepalive_connections=8
            ),
        )
        self._loop_started.set()
        flush_interval = self.config.flush_interval_ms / 1000.0
        try:
            while not self._stop.is_set():
                # Wait for the next event or the flush interval.
                self._wake.wait(timeout=flush_interval)
                self._wake.clear()
                if self._stop.is_set() and self._queue.empty():
                    break
                batch = self._drain(self.config.batch_size)
                if batch:
                    await self._send_batch(batch)
        finally:
            # Final drain on shutdown.
            tail = self._drain(self.config.batch_size)
            if tail:
                await self._send_batch(tail)
            await self._http.aclose()
            self._http = None

    def _drain(self, max_items: int) -> list[TraceEvent]:
        items: list[TraceEvent] = []
        for _ in range(max_items):
            try:
                items.append(self._queue.get_nowait())
            except _queue.Empty:
                break
        return items

    async def _send_batch(self, batch: list[TraceEvent]) -> None:
        assert self._http is not None
        # Group by source_format so each ingestion route gets its
        # own request. Routes are 1:1 with decoder names.
        groups: dict[str, list[dict[str, Any]]] = {}
        for ev in batch:
            groups.setdefault(ev.source_format, []).append(ev.payload)
        for source_format, payloads in groups.items():
            try:
                url = self.config.ingest_url(source_format)
                headers = self.config.auth_headers()
                headers.setdefault("Content-Type", "application/json")
                if self._BATCH_AS_ARRAY:
                    body = json.dumps(payloads, default=str).encode("utf-8")
                else:
                    body = json.dumps(payloads[0], default=str).encode("utf-8")
                t0 = time.perf_counter()
                resp = await self._http.post(
                    url, content=body, headers=headers
                )
                dt = (time.perf_counter() - t0) * 1000.0
                self._latency_window.append(dt)
                # 2xx = accepted; 4xx = rejected by the server (auth,
                # validation) and should be counted as failed so operators
                # notice a misconfigured org_id / api_key. 5xx is a
                # server error; either way the event did not land.
                if 200 <= resp.status_code < 300:
                    self._sent_total += len(payloads)
                else:
                    self._failed_total += len(payloads)
                    logger.warning(
                        "eden ingest %s returned %s: %s",
                        source_format,
                        resp.status_code,
                        resp.text[:200],
                    )
            except Exception as exc:  # noqa: BLE001
                self._failed_total += len(payloads)
                logger.warning("eden ingest %s failed: %s", source_format, exc)

    # ── Stats / introspection ─────────────────────────────────────────

    @property
    def sent(self) -> int:
        return self._sent_total

    @property
    def dropped(self) -> int:
        return self._dropped_total

    @property
    def failed(self) -> int:
        return self._failed_total

    def p99_latency_ms(self) -> float:
        """99th percentile of recent send latencies in milliseconds."""
        if not self._latency_window:
            return 0.0
        ordered = sorted(self._latency_window)
        idx = max(0, int(round(0.99 * (len(ordered) - 1))))
        return ordered[idx]


# ── Singleton ────────────────────────────────────────────────────────

_lock = threading.Lock()
_default: Optional[EdenClient] = None
_atexit_registered = False


def get_default_client() -> EdenClient:
    """Return the process-wide :class:`EdenClient` singleton.

    The first call also starts the sender thread and registers an
    :mod:`atexit` hook for a best-effort final flush.
    """
    global _default, _atexit_registered
    with _lock:
        if _default is None:
            _default = EdenClient()
            _default.start()
            if not _atexit_registered:
                atexit.register(_atexit_shutdown)
                _atexit_registered = True
    return _default


def _atexit_shutdown() -> None:
    global _default
    if _default is None:
        return
    try:
        _default.flush(timeout=2.0)
    finally:
        _default.shutdown(timeout=2.0)
        _default = None


def reset_default_client() -> None:
    """Test helper: drop the singleton (synchronously)."""
    global _default
    with _lock:
        if _default is not None:
            _default.shutdown(timeout=2.0)
            _default = None
