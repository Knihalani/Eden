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
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from eden_sdk.config import EdenConfig, get_config
from eden_sdk.filters import _redact_string as _redact_text
from eden_sdk.filters import redact_payload

# ``User-Agent`` for ingestion. Pulled from ``__version__`` at
# import time; if the package is re-installed the new value
# takes effect. The gateway logs the SDK version on every POST
# so version drift across the fleet is visible in one place.
__version__ = "0.2.17"
_USER_AGENT = f"eden-sdk/{__version__} (python)"

logger = logging.getLogger("eden_sdk.client")


# ── Public types ──────────────────────────────────────────────────────


class TraceEvent:
    """A single telemetry event ready for the wire.

    The SDK only ships JSON-safe dicts — this is a thin convenience
    wrapper that records the source format and the dict payload so
    the sender can route to the right ingestion endpoint.
    """

    __slots__ = ("source_format", "payload")

    def __init__(
        self,
        payload: dict[str, Any],
        source_format: str = "openai",
    ) -> None:
        self.source_format = source_format
        self.payload = payload

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

    def __init__(
        self,
        config: EdenConfig | None = None,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        """Build a sender.

        Parameters
        ----------
        config
            Runtime configuration. Defaults to the process-wide
            config singleton.
        transport
            Optional httpx async transport to install on the
            internal AsyncClient. Use this to inject a
            MockTransport in tests or a custom transport in
            production (e.g. for custom TLS / metrics).
        """
        self.config = config or get_config()
        self._queue: _queue.Queue[TraceEvent] = _queue.Queue(
            maxsize=self.config.max_queue
        )
        # Streaming chunks accumulate here and are flushed on the
        # same worker tick (or via :meth:`flush_chunks`). Distinct
        # from the regular queue because they go to ``/ingest/chunks``
        # with a smaller payload shape.
        self._chunk_buffer: list[dict[str, Any]] = []
        # Chunk buffer cap. Mirrors ``max_queue`` for the
        # regular event queue: prevents a runaway streaming
        # response (e.g. a model echoing millions of small
        # tokens) from OOM-ing the process before the
        # sender thread can flush. Without this, an
        # instrumentation that enqueues one chunk per
        # token on an unbounded stream would grow
        # ``self._chunk_buffer`` without bound -- the
        # Python GIL keeps ``.append`` atomic but does
        # not save us from running out of memory.
        self._chunk_buffer_max = 4096
        self._chunk_wake = threading.Event()
        self._chunk_generation = 0
        self._chunk_processed_generation = 0
        self._chunk_idle = threading.Event()
        self._chunk_idle.set()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._http: httpx.AsyncClient | None = None
        # Transport precedence: explicit kwarg > config.transport > None.
        # The config field is what :func:`configure` threads through
        # the singleton, so users can set ``configure(transport=...)``
        # to mock the gateway in tests.
        cfg_transport = getattr(self.config, "transport", None)
        self._transport: httpx.AsyncBaseTransport | None = (
            transport if transport is not None else cfg_transport
        )
        self._loop_started = threading.Event()
        # Loop failure latch: set when the worker thread exits
        # before flipping _loop_started (e.g. AsyncClient construction
        # raised an invalid-transport error). Without this, start()
        # would silently time out on _loop_started.wait() and return as
        # if the sender was up, while the thread was already dead --
        # every subsequent enqueue() would land in a queue that nothing
        # drains, and events would silently disappear.
        self._loop_failed = False
        self._loop_failed_event = threading.Event()
        # Lifecycle lock: serialises ``start()`` + ``shutdown()`` so
        # two callers can't both observe ``self._thread is None``
        # and race to create a second worker thread.
        self._lifecycle_lock = threading.Lock()
        self._dropped_total = 0
        self._sent_total = 0
        self._failed_total = 0
        self._latency_window: deque[float] = deque(maxlen=1024)
        # Generation counter: incremented at the end of each
        # send_batch. ``flush()`` waits until the queue is empty
        # AND the generation is stable for one tick — that way
        # we know the in-flight HTTP has finished.
        self._generation = 0
        self._processed_generation = 0
        self._generation_idle = threading.Event()
        self._generation_idle.set()

    # ── Lifecycle ────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the background sender thread (idempotent).

        Safe to call from multiple threads concurrently: the
        check-and-create is guarded by ``self._lifecycle_lock`` so
        two callers cannot each spin up their own worker thread
        (which would have raced to drain the same queue and double-
        posted every batch). Without the lock, two threads that
        both see ``self._thread is None`` could each create a
        worker and leave the queue in an inconsistent state when
        one of them later called ``shutdown()``.
        """
        with self._lifecycle_lock:
            if self._thread is not None and self._thread.is_alive():
                return
            if not self.config.enabled:
                logger.debug("eden client disabled; not starting sender")
                return
            self._stop.clear()
            # Reset the start latch so a fresh ``start()`` after
            # ``shutdown()`` actually waits for the new loop
            # to come up. Without this, the second ``start()``
            # returned immediately because the latch was still
            # set from the previous run, racing ``enqueue()``
            # against an in-flight HTTP client that's about to
            # be re-created.
            self._loop_started.clear()
            # Reset the failure latch for the new worker. If the
            # previous run died (e.g. transport error) and the
            # caller is retrying start(), we want this run to
            # report its own outcome.
            self._loop_failed = False
            self._loop_failed_event.clear()
            self._thread = threading.Thread(
                target=self._run_loop, name="eden-sdk-sender", daemon=True
            )
            self._thread.start()
        # Wait until the loop has its asyncio loop ready so that
        # shutdown() can join immediately. Outside the lock so a
        # long shutdown of a previous EdenClient doesn't block
        # other threads from creating fresh EdenClients.
        self._loop_started.wait(timeout=1.0)
        if self._loop_failed:
            # The thread died before flipping _loop_started (or
            # set it itself after catching the exception in
            # _run_loop). Surface a clear RuntimeError so the
            # caller does NOT silently treat the sender as up
            # -- otherwise enqueue() calls would land in a queue
            # nothing drains.
            raise RuntimeError(
                "eden sdk: sender thread failed to start; "
                "check the log for the underlying error"
            )

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
        # Wake the worker when a streaming chunk lands so it flushes
        # without waiting for the full batch window. The producer
        # pays only the ``Event.set`` cost.
        if self._chunk_buffer:
            self._chunk_wake.set()

    def flush(self, timeout: float = 2.0) -> None:
        """Block until the queue, in-flight HTTP, and chunk buffer
        are all drained.

        Waits up to ``timeout`` seconds. Returns early as soon as
        *every* of the following is true:

        * the regular event queue is empty,
        * the in-flight batch HTTP has completed,
        * the streaming chunk buffer is empty, AND
        * the in-flight chunk HTTP has completed.

        Used by the test-suite, by ``atexit`` for a clean shutdown,
        and by callers that need to guarantee all events for a
        transaction have shipped before the process exits (e.g.
        AWS Lambda, short-lived CLI scripts).
        """
        if not self.config.enabled:
            return
        # Force both workers to drain on the next loop tick.
        self._wake.set()
        self._chunk_wake.set()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if (
                self._queue.empty()
                and self._processed_generation >= self._generation
                and not self._chunk_buffer
                and self._chunk_processed_generation >= self._chunk_generation
            ):
                return
            # Block on whichever idle event is currently signalled,
            # then re-check. We poll both with a small timeout so
            # the queue state check is responsive.
            self._generation_idle.wait(timeout=0.01)
            self._generation_idle.clear()
            self._chunk_idle.wait(timeout=0.01)
            self._chunk_idle.clear()

    # ── Internal loop ────────────────────────────────────────────────

    def _run_loop(self) -> None:
        # Thread entry point. Wraps asyncio.run so any exception raised
        # before _loop_started.set() (e.g. an invalid httpx.AsyncClient
        # transport argument) is logged and surfaces via _loop_failed
        # instead of silently killing the worker.
        import asyncio

        try:
            asyncio.run(self._async_loop())
        except Exception as exc:  # noqa: BLE001
            # The async loop sets _loop_started as soon as the
            # AsyncClient is built. If we get here before that line
            # ran, start() is still waiting on the latch -- release it
            # with a failure signal so the caller knows the sender
            # never came up. If the loop already started and crashed
            # mid-run, this branch is the only visible signal --
            # log at WARNING so the issue is not silently swallowed.
            self._loop_failed = True
            self._loop_failed_event.set()
            self._loop_started.set()
            logger.warning(
                "eden sdk: sender thread exited before loop was ready: %s",
                exc,
            )

    async def _async_loop(self) -> None:

        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(self.config.timeout_s),
            limits=httpx.Limits(
                max_connections=16, max_keepalive_connections=8
            ),
            transport=self._transport,
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
                    self._generation += 1
                    try:
                        await self._send_batch(batch)
                    finally:
                        self._processed_generation = self._generation
                        self._generation_idle.set()
                else:
                    # Queue is empty: tell flush() it can return.
                    self._generation_idle.set()
                # Drain streaming chunks on the same loop tick.
                if self._chunk_buffer:
                    self._chunk_generation += 1
                    try:
                        await self._send_chunks()
                    finally:
                        self._chunk_processed_generation = self._chunk_generation
                        self._chunk_idle.set()
                else:
                    self._chunk_idle.set()
        finally:
            # Final drain on shutdown.
            tail = self._drain(self.config.batch_size)
            if tail:
                self._generation += 1
                await self._send_batch(tail)
                self._processed_generation = self._generation
            if self._chunk_buffer:
                self._chunk_generation += 1
                await self._send_chunks()
                self._chunk_processed_generation = self._chunk_generation
            self._generation_idle.set()
            self._chunk_idle.set()
            if self._http is not None:
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

    def flush_chunks(self, timeout: float = 2.0) -> None:
        """Block until buffered streaming chunks are flushed.

        Mirrors :meth:`flush` but for the streaming chunks buffer.
        No-op when there are no buffered chunks.
        """
        if not self.config.enabled:
            return
        self._chunk_wake.set()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if (
                not self._chunk_buffer
                and self._chunk_processed_generation >= self._chunk_generation
            ):
                return
            self._chunk_idle.wait(timeout=0.01)
            self._chunk_idle.clear()

    def ingest_chunks_url(self) -> str | None:
        """Return the canonical streaming chunks URL, or ``None`` when
        the org id is not configured."""
        if not self.config.org_id:
            return None
        base = self.config.base_url.rstrip("/")
        return f"{base}/orgs/{self.config.org_id}/ingest/chunks"

    def _enqueue_chunk(self, chunk: dict[str, Any]) -> None:
        """Push a streaming chunk onto the buffer with oldest-drop overflow.

        The producer-side API for streaming chunks. Mirrors
        :meth:`enqueue` for the regular event queue: never
        blocks the user thread, and on overflow drops the
        oldest entry to make room for the new one. The cap
        prevents a runaway stream from exhausting memory
        before the sender thread can drain.
        """
        if not self.config.enabled:
            return
        if self.config.dry_run:
            self._sent_total += 1
            return
        # Drop oldest to make room. This is O(n) for a list,
        # but n is bounded by _chunk_buffer_max and the
        # append/drop pair is amortised across the cap, so
        # total work stays O(max) per overflow cycle.
        while len(self._chunk_buffer) >= self._chunk_buffer_max:
            try:
                self._chunk_buffer.pop(0)
            except IndexError:
                break
            self._dropped_total += 1
        self._chunk_buffer.append(chunk)
        # Wake the worker so the chunk ships promptly rather
        # than waiting for the next batch window.
        self._chunk_wake.set()

    async def _send_chunks(self) -> None:
        """POST buffered streaming chunks to ``/ingest/chunks``.

        Best-effort: a transport failure logs a warning and counts
        the chunks as failed, but does not raise (the user's stream
        already returned to them).
        """
        assert self._http is not None
        if not self._chunk_buffer:
            return
        # Defensive trim: instrumentations may append directly
        # to ``self._chunk_buffer`` (bypassing the
        # ``_enqueue_chunk`` helper), and a producer faster
        # than the worker tick could pile up more than
        # ``_chunk_buffer_max`` entries between flushes. Drop
        # the oldest now so we never ship a buffer larger
        # than the configured cap, and never OOM the process
        # between ticks.
        if len(self._chunk_buffer) > self._chunk_buffer_max:
            overflow = len(self._chunk_buffer) - self._chunk_buffer_max
            self._chunk_buffer = self._chunk_buffer[overflow:]
            self._dropped_total += overflow
            logger.warning(
                "eden sdk: chunk buffer overflow, dropped %d oldest",
                overflow,
            )
        url = self.ingest_chunks_url()
        if url is None:
            # No org id — drop silently.
            self._chunk_buffer.clear()
            return
        chunks = self._chunk_buffer
        self._chunk_buffer = []
        # Apply the client-side PII safety net to every chunk's
        # ``delta_text`` before it leaves the process. Streaming
        # responses often contain model-echoed PII (an email
        # address the user put in the prompt that the model then
        # repeated in its reply) — without this, that PII would
        # bypass the batched redaction in ``_send_batch``.
        if self.config.redact_on_client:
            chunks = [
                {
                    **c,
                    "delta_text": _redact_text(
                        c["delta_text"] if isinstance(c.get("delta_text"), str) else ""
                    ),
                }
                for c in chunks
            ]
        try:
            body = json.dumps({"chunks": chunks}, default=str).encode("utf-8")
            headers = self.config.auth_headers()
            headers.setdefault("Content-Type", "application/json")
            headers.setdefault("User-Agent", _USER_AGENT)
            t0 = time.perf_counter()
            resp = await self._http.post(url, content=body, headers=headers)
            dt = (time.perf_counter() - t0) * 1000.0
            self._latency_window.append(dt)
            if 200 <= resp.status_code < 300:
                self._sent_total += len(chunks)
            else:
                self._failed_total += len(chunks)
                logger.warning(
                    "eden ingest chunks returned %s: %s",
                    resp.status_code,
                    resp.text[:200],
                )
        except Exception as exc:  # noqa: BLE001
            self._failed_total += len(chunks)
            logger.warning("eden ingest chunks failed: %s", exc)

    def _parse_retry_after(
        self, value: str, fallback: float
    ) -> float:
        """Parse a ``Retry-After`` header value (RFC 7231).

        The header may be either a delta-seconds integer (``"5"``)
        or an HTTP-date (``"Wed, 21 Oct 2015 07:28:00 GMT"``).
        Returns the seconds-to-wait, capped at 30s, falling back
        to ``fallback`` on any parse failure so a malformed
        header never wedges the retry loop.
        """
        # Fast path: integer / float seconds.
        try:
            return min(float(value), 30.0)
        except (TypeError, ValueError):
            pass
        # Slow path: HTTP-date. parsedate_to_datetime returns
        # ``None`` for unparseable input (does not raise), so the
        # explicit None check is required.
        try:
            target = parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return fallback
        if target is None:
            return fallback
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc)
        # parsedate_to_datetime returns a timezone-naive datetime
        # by default; treat as UTC. If it's already aware, use
        # it directly.
        if target.tzinfo is None:
            target = target.replace(tzinfo=timezone.utc)
        delta = (target - now).total_seconds()
        # A past HTTP-date means "retry now" -- clamp to 0 so we
        # don't accidentally back off further. A far-future
        # date is capped to keep the worker responsive.
        if delta <= 0:
            return 0.0
        return min(delta, 30.0)

    async def _send_batch(self, batch: list[TraceEvent]) -> None:
        assert self._http is not None
        # Group by source_format so each ingestion route gets its
        # own request. Routes are 1:1 with decoder names.
        groups: dict[str, list[dict[str, Any]]] = {}
        for ev in batch:
            groups.setdefault(ev.source_format, []).append(ev.payload)
        for source_format, payloads in groups.items():
            count = len(payloads) if self._BATCH_AS_ARRAY else 1
            try:
                url = self.config.ingest_url(source_format)
                headers = self.config.auth_headers()
                headers.setdefault("Content-Type", "application/json")
                headers.setdefault("User-Agent", _USER_AGENT)
                # Apply the client-side safety-net PII redactor to
                # every payload before it leaves the process. The
                # gateway remains the source of truth; this is a
                # belt-and-suspenders pass for local dev and as a
                # backstop if the gateway is down or misconfigured.
                if self.config.redact_on_client:
                    payloads = [redact_payload(p) for p in payloads]
                if self._BATCH_AS_ARRAY:
                    body = json.dumps(payloads, default=str).encode("utf-8")
                else:
                    body = json.dumps(payloads[0], default=str).encode("utf-8")
                    # Single-event mode: we send one event per request,
                    # so each request only counts one event regardless of
                    # the size of the drained batch.
                    count = 1
                # Retry transient failures (5xx, 408, 429, network) with
                # exponential backoff. 4xx other than 408/429 are
                # considered permanent (auth/validation) and bail out
                # immediately. Retry-After from the server is honoured
                # up to a max of 30s per attempt.
                import asyncio
                attempt = 0
                max_attempts = 3
                base_delay_s = 0.2
                while True:
                    attempt += 1
                    t0 = time.perf_counter()
                    try:
                        resp = await self._http.post(
                            url, content=body, headers=headers
                        )
                        dt = (time.perf_counter() - t0) * 1000.0
                        self._latency_window.append(dt)
                    except Exception as exc:  # noqa: BLE001
                        # Network-level failure — retryable.
                        if attempt < max_attempts:
                            delay = min(base_delay_s * (2 ** (attempt - 1)), 5.0)
                            logger.warning(
                                "eden ingest %s attempt %d/%d failed: %s; retrying in %.2fs",
                                source_format, attempt, max_attempts, exc, delay,
                            )
                            await asyncio.sleep(delay)
                            continue
                        self._failed_total += count
                        logger.warning(
                            "eden ingest %s failed after %d attempts: %s",
                            source_format, attempt, exc,
                        )
                        break

                    status = resp.status_code
                    if 200 <= status < 300:
                        self._sent_total += count
                        break
                    # 408 (Request Timeout), 429 (Too Many Requests),
                    # and any 5xx are retryable; other 4xx are not.
                    # Mirrors the TS SDK (status === 429 || status === 408 || status >= 500).
                    retryable = status == 408 or status == 429 or status >= 500
                    if not retryable or attempt >= max_attempts:
                        self._failed_total += count
                        logger.warning(
                            "eden ingest %s returned %s: %s",
                            source_format, status, resp.text[:200],
                        )
                        break
                    # Respect Retry-After if present. The spec (RFC 7231)
                    # allows either a delta-seconds integer or an
                    # HTTP-date -- the original code only handled the
                    # former and silently fell back to exponential
                    # backoff on HTTP-date, ignoring the server's
                    # intent. Parse both forms; cap the resulting
                    # delay at 30s so a misconfigured gateway can't
                    # stall ingestion indefinitely.
                    delay = min(base_delay_s * (2 ** (attempt - 1)), 5.0)
                    retry_after = resp.headers.get("retry-after")
                    if retry_after is not None:
                        delay = self._parse_retry_after(retry_after, fallback=delay)
                    logger.warning(
                        "eden ingest %s returned %s; retrying in %.2fs (attempt %d/%d)",
                        source_format, status, delay, attempt, max_attempts,
                    )
                    await asyncio.sleep(delay)
            except Exception as exc:  # noqa: BLE001
                # Outermost catch: anything the retry loop didn't handle.
                self._failed_total += count
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
_default: EdenClient | None = None
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
