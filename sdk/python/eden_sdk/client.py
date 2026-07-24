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

import asyncio
import atexit
import gzip
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
from eden_sdk.ingest_format import resolve_ingest_path

# Compact JSON for the wire — fewer bytes to gzip, faster dumps.
_JSON_SEPARATORS = (",", ":")

# ``User-Agent`` for ingestion. Pulled from ``__version__`` at
# import time; if the package is re-installed the new value
# takes effect. The gateway logs the SDK version on every POST
# so version drift across the fleet is visible in one place.
__version__ = "0.3.4"
_USER_AGENT = f"eden-sdk/{__version__} (python)"

# Match BE ``settings.ingestion_chunks_max_per_request`` (default 1000).
_INGEST_CHUNKS_MAX_PER_REQUEST = 1000

logger = logging.getLogger("eden_sdk.client")


class _ChunkBuffer(deque):
    """Streaming chunk buffer: O(1) left-eviction + list-compatible slices.

    Instrumentations and tests treat ``_chunk_buffer`` like a list
    (``append``, ``extend``, ``buf[1:]``). A plain ``deque`` rejects
    slices; this subclass restores that API without paying O(n)
    ``list.pop(0)`` on overflow.
    """

    def __getitem__(self, index):  # type: ignore[override]
        if isinstance(index, slice):
            start, stop, step = index.indices(len(self))
            return [deque.__getitem__(self, i) for i in range(start, stop, step)]
        return deque.__getitem__(self, index)


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
        return json.dumps(
            self.payload, default=str, separators=_JSON_SEPARATORS
        ).encode("utf-8")


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
        # with a smaller payload shape. ``deque`` keeps overflow
        # eviction O(1) (list ``pop(0)`` was O(n) per drop).
        self._chunk_buffer: _ChunkBuffer = _ChunkBuffer()
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
        self._sampled_out_total = 0
        self._sent_total = 0
        self._failed_total = 0
        self._latency_window: deque[float] = deque(maxlen=1024)
        from eden_sdk.sampling import ClientSampler, SampleSignals

        profile = getattr(self.config, "sampling_profile", "full") or "full"
        if profile not in ("full", "balanced", "aggressive"):
            profile = "full"
        self._sampler = ClientSampler(
            profile=profile,  # type: ignore[arg-type]
            keep_errors=bool(getattr(self.config, "sample_keep_errors", True)),
        )
        self._SampleSignals = SampleSignals
        self._offline = None
        offline_path = getattr(self.config, "offline_queue_path", None)
        if offline_path:
            try:
                from eden_sdk.offline_queue import OfflineQueue

                self._offline = OfflineQueue(offline_path)
            except Exception as exc:  # noqa: BLE001
                logger.warning("eden offline queue disabled: %s", exc)
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

    def enqueue(self, event: TraceEvent, *, skip_sampling: bool = False) -> None:
        """Non-blocking enqueue. Drops oldest on overflow.

        Designed to be called from any thread — including the
        framework callbacks running on the user's event loop.

        ``skip_sampling`` is for durable offline replay: events already
        persisted to SQLite must not be dropped by ClientSampler and
        then acked away.
        """
        if not self.config.enabled:
            return
        payload = event.payload if isinstance(event.payload, dict) else {}
        has_error = bool(
            payload.get("error")
            or payload.get("outcome") == "error"
            or payload.get("status") == "error"
        )
        duration_ms = float(payload.get("duration_ms") or 0)
        if not self._sampler.should_keep(
            self._SampleSignals(
                has_error=has_error,
                duration_ms=duration_ms,
                force=skip_sampling,
            )
        ):
            self._sampled_out_total += 1
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
                # Sync wait is intentional: this thread's event loop only
                # runs sender work, and the wait sits *between* batches
                # (never across in-flight asyncio.gather POSTs). Parking
                # via run_in_executor on every tick crushed throughput.
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
        # The worker loop waits on ``_wake`` (not ``_chunk_wake`` alone),
        # so both must be signalled or ``flush_chunks`` stalls until the
        # next flush-interval tick.
        self._wake.set()
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
        # Drop oldest to make room. deque.popleft is O(1);
        # the previous list.pop(0) was O(n) per eviction.
        while len(self._chunk_buffer) >= self._chunk_buffer_max:
            try:
                self._chunk_buffer.popleft()
            except IndexError:
                break
            self._dropped_total += 1
        self._chunk_buffer.append(chunk)
        # Wake the worker so the chunk ships promptly rather
        # than waiting for the next batch window. ``_wake`` is
        # what ``_async_loop`` actually waits on; ``_chunk_wake``
        # is also set for flush_chunks() polling compatibility.
        self._wake.set()
        self._chunk_wake.set()

    async def _send_chunks(self) -> None:
        """POST buffered streaming chunks to ``/ingest/chunks``.

        Best-effort: a transport failure logs a warning and counts
        the chunks as failed, but does not raise (the user's stream
        already returned to them). Each POST is capped at
        ``_INGEST_CHUNKS_MAX_PER_REQUEST``; a 413 splits the batch
        and retries rather than permanently dropping.
        """
        assert self._http is not None
        if not self._chunk_buffer:
            return
        if self.config.dry_run:
            # Mirror ``enqueue``: count as sent, never POST.
            self._sent_total += len(self._chunk_buffer)
            self._chunk_buffer.clear()
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
            for _ in range(overflow):
                self._chunk_buffer.popleft()
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
        # Ownership swap: avoid copying the chunk dicts.
        chunks = self._chunk_buffer
        self._chunk_buffer = _ChunkBuffer()
        # Apply the client-side PII safety net in-place (we own
        # ``chunks`` now). Avoid ``{**c, ...}`` which copied every
        # chunk dict on the hot streaming path.
        if self.config.redact_on_client:
            for c in chunks:
                dt = c.get("delta_text")
                c["delta_text"] = _redact_text(dt if isinstance(dt, str) else "")
        chunk_list = list(chunks)
        for i in range(0, len(chunk_list), _INGEST_CHUNKS_MAX_PER_REQUEST):
            await self._post_chunk_batch(
                url,
                chunk_list[i : i + _INGEST_CHUNKS_MAX_PER_REQUEST],
            )

    async def _post_chunk_batch(
        self, url: str, batch: list[dict]
    ) -> None:
        """POST one chunk batch (≤1000). On 413, bisect and retry."""
        if not batch:
            return
        try:
            body = gzip.compress(
                json.dumps(
                    {"chunks": batch},
                    default=str,
                    separators=_JSON_SEPARATORS,
                ).encode("utf-8"),
                compresslevel=1,
            )
            headers = self.config.auth_headers()
            headers.setdefault("Content-Type", "application/json")
            headers.setdefault("Content-Encoding", "gzip")
            headers.setdefault("User-Agent", _USER_AGENT)

            attempt = 0
            max_attempts = 3
            base_delay_s = 0.2
            while True:
                attempt += 1
                t0 = time.perf_counter()
                try:
                    resp = await self._http.post(url, content=body, headers=headers)
                    dt = (time.perf_counter() - t0) * 1000.0
                    self._latency_window.append(dt)
                except Exception as exc:  # noqa: BLE001
                    if attempt < max_attempts:
                        delay = min(base_delay_s * (2 ** (attempt - 1)), 5.0)
                        logger.warning(
                            "eden ingest chunks attempt %d/%d failed: %s; retrying in %.2fs",
                            attempt,
                            max_attempts,
                            exc,
                            delay,
                        )
                        await asyncio.sleep(delay)
                        continue
                    self._failed_total += len(batch)
                    logger.warning(
                        "eden ingest chunks failed after %d attempts: %s",
                        attempt,
                        exc,
                    )
                    return

                status = resp.status_code
                if 200 <= status < 300:
                    self._sent_total += len(batch)
                    return
                if status == 413 and len(batch) > 1:
                    mid = len(batch) // 2
                    logger.warning(
                        "eden ingest chunks returned 413; splitting %d -> %d+%d",
                        len(batch),
                        mid,
                        len(batch) - mid,
                    )
                    await self._post_chunk_batch(url, batch[:mid])
                    await self._post_chunk_batch(url, batch[mid:])
                    return
                retryable = status == 408 or status == 429 or status >= 500
                if not retryable or attempt >= max_attempts:
                    self._failed_total += len(batch)
                    logger.warning(
                        "eden ingest chunks returned %s: %s",
                        status,
                        resp.text[:200],
                    )
                    return
                delay = min(base_delay_s * (2 ** (attempt - 1)), 5.0)
                retry_after = resp.headers.get("retry-after")
                if retry_after is not None:
                    delay = self._parse_retry_after(retry_after, fallback=delay)
                logger.warning(
                    "eden ingest chunks returned %s; retrying in %.2fs (attempt %d/%d)",
                    status,
                    delay,
                    attempt,
                    max_attempts,
                )
                await asyncio.sleep(delay)
        except Exception as exc:  # noqa: BLE001
            self._failed_total += len(batch)
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
            path_fmt = resolve_ingest_path(ev.source_format)
            groups.setdefault(path_fmt, []).append(ev.payload)

        # Build auth headers once per batch; each format copies.
        base_headers = self.config.auth_headers()

        async def _send_format(
            source_format: str, payloads: list[dict[str, Any]]
        ) -> None:
            count = len(payloads) if self._BATCH_AS_ARRAY else 1
            try:
                url = self.config.ingest_url(source_format)
                headers = dict(base_headers)
                headers.setdefault("Content-Type", "application/json")
                headers.setdefault("Content-Encoding", "gzip")
                headers.setdefault("User-Agent", _USER_AGENT)
                if self.config.redact_on_client:
                    payloads = [redact_payload(p) for p in payloads]
                if self._BATCH_AS_ARRAY:
                    raw = json.dumps(
                        payloads, default=str, separators=_JSON_SEPARATORS
                    ).encode("utf-8")
                else:
                    raw = json.dumps(
                        payloads[0], default=str, separators=_JSON_SEPARATORS
                    ).encode("utf-8")
                    count = 1
                body = gzip.compress(raw, compresslevel=1)
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
                        # Network exhaustion is retryable later — spill.
                        self._spill_offline(source_format, payloads)
                        break

                    status = resp.status_code
                    if 200 <= status < 300:
                        self._sent_total += count
                        break
                    retryable = status == 408 or status == 429 or status >= 500
                    if not retryable or attempt >= max_attempts:
                        self._failed_total += count
                        logger.warning(
                            "eden ingest %s returned %s: %s",
                            source_format, status, resp.text[:200],
                        )
                        # Only spill transient failures. Permanent 4xx
                        # (auth/validation) would poison the offline
                        # queue with payloads that can never succeed.
                        if retryable:
                            self._spill_offline(source_format, payloads)
                        break
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
                self._failed_total += count
                logger.warning("eden ingest %s failed: %s", source_format, exc)
                self._spill_offline(source_format, payloads)

        await asyncio.gather(
            *(_send_format(fmt, payloads) for fmt, payloads in groups.items())
        )

    def _spill_offline(self, source_format: str, payloads: list[dict[str, Any]]) -> None:
        if self._offline is None:
            return
        try:
            self._offline.enqueue_many(
                [(source_format, p) for p in payloads]
            )
        except Exception as exc:  # noqa: BLE001
            # Fall back to per-row so a single bad payload does not
            # drop the whole spill batch.
            logger.debug("offline spill batch failed: %s", exc)
            for p in payloads:
                try:
                    self._offline.enqueue(source_format, p)
                except Exception as row_exc:  # noqa: BLE001
                    logger.debug("offline spill failed: %s", row_exc)

    def flush_offline(self, limit: int = 100, *, timeout: float = 5.0) -> int:
        """Re-enqueue durable offline events after reconnect. Returns count acked.

        Rows stay in SQLite until flush fully succeeds (queue drained and
        in-flight send completed). On timeout or leftover in-memory events,
        ids are left unacked so a later replay can retry. Sampling is
        bypassed on this path so ClientSampler cannot drop durable rows
        that would then be acked away. Failed sends are re-spilled by
        ``_send_batch`` when the failure is transient.
        """
        if self._offline is None:
            return 0
        drained = self._offline.drain(limit=limit)
        if not drained:
            return 0
        ids: list[int] = []
        for rid, fmt, payload in drained:
            self.enqueue(
                TraceEvent(payload=payload, source_format=fmt),
                skip_sampling=True,
            )
            ids.append(rid)
        self.flush(timeout=timeout)
        flushed = (
            self._queue.empty()
            and self._processed_generation >= self._generation
        )
        if not flushed:
            return 0
        self._offline.ack(ids)
        return len(ids)

    # ── Stats / introspection ─────────────────────────────────────────

    @property
    def sent(self) -> int:
        return self._sent_total

    @property
    def dropped(self) -> int:
        return self._dropped_total

    @property
    def sampled_out(self) -> int:
        return self._sampled_out_total

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
