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
import logging
import os
import queue as _queue
import threading
import time
import weakref
from collections import deque
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from eden_sdk._fast_json import dumps_bytes as _fast_dumps_bytes
from eden_sdk._wire_compress import compress_wire as _compress_wire
from eden_sdk.config import EdenConfig, get_config
from eden_sdk.filters import _redact_string as _redact_text
from eden_sdk.filters import redact_payload
from eden_sdk.ingest_format import resolve_ingest_path

# ``User-Agent`` for ingestion. Pulled from ``__version__`` at
# import time; if the package is re-installed the new value
# takes effect. The gateway logs the SDK version on every POST
# so version drift across the fleet is visible in one place.
__version__ = "0.4.2"
_USER_AGENT = f"eden-sdk/{__version__} (python)"

# Match BE ``settings.ingestion_chunks_max_per_request`` (default 1000).
_INGEST_CHUNKS_MAX_PER_REQUEST = 1000

logger = logging.getLogger("eden_sdk.client")


#: Every live client, weakly held, so ``_reset_all_after_fork`` can reach them.
_LIVE_CLIENTS: weakref.WeakSet[EdenClient] = weakref.WeakSet()


def _reset_all_after_fork() -> None:
    """``os.register_at_fork`` hook: rebuild every client's state in the child.

    Runs in the child immediately after ``fork()``, on the one surviving thread.
    Each client's reset is isolated so one failure cannot leave the others in a
    half-forked state.
    """
    for client in list(_LIVE_CLIENTS):
        try:
            client._reset_after_fork()
        except Exception:  # noqa: BLE001 — a fork hook must never raise
            pass


if hasattr(os, "register_at_fork"):  # POSIX only; absent on Windows
    os.register_at_fork(after_in_child=_reset_all_after_fork)


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

    __slots__ = ("source_format", "payload", "offline_row_id")

    def __init__(
        self,
        payload: dict[str, Any],
        source_format: str = "openai",
        *,
        offline_row_id: int | None = None,
    ) -> None:
        self.source_format = source_format
        self.payload = payload
        # Set only when this event originated from ``flush_offline``
        # replaying a durable SQLite row (``OfflineQueue`` id). Lets
        # ``_send_batch``/``_send_format`` record that specific row's
        # resolution outcome (delivered / permanently rejected /
        # left-unresolved-and-respilled) at the exact row granularity
        # ``flush_offline`` needs for its ack decision — independent of
        # every other row that happens to share this event's format
        # group or land in the same or a different generation/batch.
        # ``None`` for ordinary (non-replay) events, which never
        # participate in the offline-ack bookkeeping.
        self.offline_row_id = offline_row_id

    def to_json_bytes(self) -> bytes:
        return _fast_dumps_bytes(self.payload)


def _parse_ingest_counts(resp: Any, sent_count: int) -> tuple[int, int, int]:
    """Return ``(accepted, rejected, sampled_out)`` from an ingest response body.

    A 2xx only means the request was understood; the body carries the
    per-row outcome as
    ``{accepted, rejected, deduplicated, sampled_out, total}``.
    ``sampled_out`` is the SERVER's own N16 gate dropping an event
    AFTER accepting the request — distinct from the SDK's own
    ``ClientSampler`` decision made before the event is ever sent.

    Falls back to "all accepted, none sampled out" whenever the body is
    not that shape, so an older or differently-shaped gateway can never
    make the SDK under-report what it sent.
    """
    try:
        body = resp.json()
    except Exception:
        return sent_count, 0, 0
    if not isinstance(body, dict):
        return sent_count, 0, 0
    if "accepted" not in body and "rejected" not in body:
        return sent_count, 0, 0
    try:
        accepted = int(body.get("accepted", sent_count) or 0)
        rejected = int(body.get("rejected", 0) or 0)
        sampled_out = int(body.get("sampled_out", 0) or 0)
    except (TypeError, ValueError):
        return sent_count, 0, 0
    return accepted, rejected, sampled_out


_warned_about_sdk_server_compounding = False


def _warn_once_about_sdk_server_compounding(profile: str) -> None:
    """Log once (per process) when the SDK itself samples on a non-``full``
    profile.

    The server applies its own independent ``sampling_profile`` gate
    (``src/eden/config.py``) — if an operator sets
    ``EDEN_SAMPLING_PROFILE=balanced`` intending to enable *server-side*
    N16, but the SDK reads the same env var, the two ~15% gates compound
    multiplicatively (0.15 * 0.15 = 2.25% effective keep) with nothing in
    either layer's logs to explain the gap. ``client_probabilistic_sampling``
    defaults to ``False`` specifically to avoid that outcome (see
    :class:`eden_sdk.sampling.ClientSampler`), but a deployment that
    explicitly opts in — or that intentionally wants client-side sampling
    with no server-side gate — should still see this once so the two knobs
    are never a silent surprise.
    """
    global _warned_about_sdk_server_compounding
    if profile == "full" or _warned_about_sdk_server_compounding:
        return
    _warned_about_sdk_server_compounding = True
    logger.warning(
        "eden sdk: sampling_profile=%r is active on the SDK. The server "
        "(src/eden/config.py's sampling_profile) applies its own "
        "independent N16 gate -- setting a non-full profile on BOTH "
        "sides compounds multiplicatively (e.g. balanced x balanced = "
        "2.25%% kept, not 15%%). By default the SDK only force-keeps "
        "error/slow/force_trace traces here and leaves the probabilistic "
        "drop to the server; set EDEN_CLIENT_PROBABILISTIC_SAMPLING=1 "
        "only if there is no server-side N16 gate to defer to.",
        profile,
    )


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
        # Events the SERVER's own N16 gate dropped after accepting the
        # request (parsed from the ingest response's ``sampled_out``
        # field) — distinct from ``_sampled_out_total`` above, which is
        # this SDK's own ``ClientSampler`` decision made before the
        # event is ever sent.
        self._server_sampled_out_total = 0
        self._sent_total = 0
        self._rejected_total = 0
        self._failed_total = 0
        self._latency_window: deque[float] = deque(maxlen=1024)
        from eden_sdk.sampling import ClientSampler, SampleSignals

        profile = getattr(self.config, "sampling_profile", "full") or "full"
        if profile not in ("full", "balanced", "aggressive"):
            profile = "full"
        self._sampler = ClientSampler(
            profile=profile,  # type: ignore[arg-type]
            keep_errors=bool(getattr(self.config, "sample_keep_errors", True)),
            client_probabilistic_sampling=bool(
                getattr(self.config, "client_probabilistic_sampling", False)
            ),
        )
        _warn_once_about_sdk_server_compounding(profile)
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
        # Per-row unresolved tracker. Contains the ``OfflineQueue`` row
        # id of every durable-replay row (see ``TraceEvent.offline_row_id``)
        # whose most recent send attempt did NOT complete with a 2xx
        # response and was NOT a permanent (non-retryable) rejection --
        # i.e. it exhausted retries, hit a transport error, and was
        # re-spilled to the offline queue as a brand-new row. A row id
        # absent from this set is resolved (delivered, or permanently
        # and intentionally dropped) as of the most recent attempt for
        # it.
        #
        # This has gone through two coarser generations before landing
        # here:
        #
        # 1. A single process-wide scalar (``_last_failed_generation``)
        #    collapsed every row's outcome into one flag for the whole
        #    ``flush_offline()`` call -- one failing row anywhere
        #    blocked acking every row the call drained.
        # 2. A per-format-group dict (keyed by
        #    ``resolve_ingest_path(source_format)``) fixed the
        #    cross-format blocking, but a single ``flush_offline()``
        #    call can drain more rows than one ``_send_batch`` handles
        #    in one tick (the background loop caps a drain at
        #    ``config.batch_size``, default 50, while ``flush_offline``'s
        #    own default ``limit`` is 100) -- so two SAME-format rows
        #    sent across two separate generations within one
        #    ``flush_offline()`` call collapsed onto one dict entry,
        #    and whichever row's ``_send_format`` call wrote last won,
        #    silently clobbering the other row's actual outcome.
        #
        # Tracking the specific ``OfflineQueue`` row id removes both
        # collapsing axes at once: two rows can never share a key
        # (SQLite's ``INTEGER PRIMARY KEY AUTOINCREMENT`` never reuses
        # an id, even after the row is deleted/acked), so it no longer
        # matters how many format groups, generations, or sub-batches a
        # single ``flush_offline()`` call's rows are scattered across --
        # each row's own entry (or lack of one) is authoritative for
        # that row alone. This also means no "since this call started"
        # generation baseline is needed: a row id is only ever produced
        # once, so finding it absent from the set is unambiguous
        # evidence of resolution, not stale data from an unrelated
        # earlier call.
        #
        # ``_processed_generation`` alone only tells us the HTTP
        # *attempt* finished, not that it *succeeded* (``_send_batch``
        # swallows all exceptions and re-spills failures to the offline
        # queue as new rows).
        #
        # Mutated from the background async-loop thread (inside
        # ``_send_format``) and read from ``flush_offline``, which runs
        # on whatever thread the caller invokes it from -- so all
        # access goes through ``_unresolved_lock``, mirroring the
        # ``_lifecycle_lock`` convention used elsewhere in this class
        # for state shared between the worker thread and callers.
        self._unresolved_lock = threading.Lock()
        # Offline rows re-enqueued by the *automatic* drain but not yet acked.
        # Held across worker ticks: see ``_auto_drain_offline`` for why the
        # automatic path cannot simply call ``flush_offline``.
        self._offline_inflight: list[int] = []
        self._offline_next_drain_at = 0.0
        # Only one replay may be in flight at a time.
        #
        # ``OfflineQueue.drain`` is a plain ``SELECT ... LIMIT`` — it does not
        # claim rows, which stay in SQLite until acked. So two concurrent
        # replays return the *same* rows and send them twice. That is a real
        # duplicate-send, and it appeared the moment the automatic drain was
        # added alongside the existing manual ``flush_offline()``: five tests
        # caught it by seeing one row delivered twice.
        self._offline_replay_lock = threading.Lock()
        # Tracked weakly so the at-fork handler can rebuild this client's
        # per-process state in a child without keeping it alive.
        _LIVE_CLIENTS.add(self)
        self._unresolved_offline_rows: set[int] = set()

    # ── Lifecycle ────────────────────────────────────────────────────

    def _reset_after_fork(self) -> None:
        """Rebuild per-process state in a forked child.

        ``os.fork()`` copies the whole address space but only the calling
        thread survives, so a child inherits:

        * **Queued events the parent still owns.** Measured directly: a parent
          with three buffered events forks, the parent's worker drains and sends
          them, and the child's copy of the queue still holds all three. The
          child's own worker then sends them again — silent duplicate telemetry,
          multiplied by the number of workers. This is the concrete bug; it hits
          every ``gunicorn --preload``, Celery prefork and ``multiprocessing``
          deployment that constructs the client before forking.
        * **Counters.** ``sent``/``dropped``/``failed`` start non-zero in the
          child, so per-process stats are wrong from the first tick.
        * **The offline SQLite handle.** A sqlite3 connection must not be used
          across a fork; sharing one invites corruption of the durable queue.
        * **A stale thread handle.** Harmless in practice — CPython's
          ``threading._after_fork`` marks it not-alive, so ``start()`` does
          create a fresh worker — but it is reset here for clarity.

        Everything is *rebuilt* rather than reused. A ``queue.Queue`` or
        ``Lock`` inherited from a process where another thread held its mutex at
        fork time can deadlock the first acquirer in the child, so draining the
        old queue here would be a hazard in exactly the situation this handler
        exists for.
        """
        max_queue = getattr(self.config, "max_queue", 10_000)
        self._queue = _queue.Queue(maxsize=max_queue)
        self._chunk_buffer = _ChunkBuffer()
        self._thread = None
        self._http = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._chunk_wake = threading.Event()
        self._chunk_idle = threading.Event()
        self._chunk_idle.set()
        self._loop_started = threading.Event()
        self._loop_failed = False
        self._loop_failed_event = threading.Event()
        self._generation_idle = threading.Event()
        self._generation_idle.set()
        self._lifecycle_lock = threading.Lock()
        self._unresolved_lock = threading.Lock()
        self._offline_replay_lock = threading.Lock()
        self._offline_inflight = []
        self._offline_next_drain_at = 0.0
        self._unresolved_offline_rows = set()
        self._generation = 0
        self._processed_generation = 0
        self._chunk_generation = 0
        self._chunk_processed_generation = 0
        self._dropped_total = 0
        self._sampled_out_total = 0
        self._server_sampled_out_total = 0
        self._sent_total = 0
        self._rejected_total = 0
        self._failed_total = 0
        self._latency_window = deque(maxlen=1024)
        # Reopen the durable queue on this process's own connection.
        self._offline = None
        offline_path = getattr(self.config, "offline_queue_path", None)
        if offline_path:
            try:
                from eden_sdk.offline_queue import OfflineQueue

                self._offline = OfflineQueue(offline_path)
            except Exception as exc:  # noqa: BLE001
                logger.warning("eden offline queue disabled after fork: %s", exc)

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
        # Stamp configured agent_id when the emitter omitted it so
        # Agents / Improve / autonomy always have a stable key.
        agent_id = getattr(self.config, "agent_id", None)
        if agent_id and isinstance(payload, dict) and not payload.get("agent_id"):
            payload["agent_id"] = agent_id
            event.payload = payload
        has_error = bool(
            payload.get("error")
            or payload.get("outcome") == "error"
            or payload.get("status") == "error"
        )
        duration_ms = float(payload.get("duration_ms") or 0)
        # Force-keep: a caller-supplied ``force_trace`` / ``eden.force_trace``
        # attribute (e.g. ``@trace_agent(attributes={"force_trace": True})``)
        # must bypass client-side sampling regardless of the active profile,
        # same as the explicit ``skip_sampling`` kwarg used for offline replay.
        attrs = payload.get("attributes")
        force = skip_sampling or bool(
            isinstance(attrs, dict)
            and (
                attrs.get("eden.force_trace") in (True, "true", "True")
                or attrs.get("force_trace") in (True, "true", "True")
            )
        )
        if not self._sampler.should_keep(
            self._SampleSignals(
                has_error=has_error,
                duration_ms=duration_ms,
                force=force,
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
            # Drop the oldest to make room. If the evicted event is a
            # durable-offline replay (``offline_row_id`` set by
            # ``flush_offline``), it never reaches ``_send_format`` and
            # so would otherwise never be added to
            # ``_unresolved_offline_rows`` -- ``flush_offline``'s ack
            # gate would then read "absent from the unresolved set" as
            # proof of delivery and wrongly ack (permanently delete) a
            # row that was actually dropped by back-pressure before any
            # send was ever attempted. Mark it unresolved here instead,
            # so it stays in the durable SQLite queue for a future
            # ``flush_offline()`` retry. Ordinary live-traffic events
            # (``offline_row_id is None``) are unaffected -- they keep
            # vanishing silently exactly as before.
            evicted: TraceEvent | None = None
            try:
                evicted = self._queue.get_nowait()
            except _queue.Empty:
                pass
            if evicted is not None:
                # Counted here, not only on the rarer double-full path below.
                # Without this, ``dropped_total()`` silently omitted every
                # ordinary back-pressure eviction.
                self._dropped_total += 1
                if evicted.offline_row_id is not None:
                    self._mark_rows_unresolved([evicted.offline_row_id])
            try:
                self._queue.put_nowait(event)
            except _queue.Full:
                self._dropped_total += 1
                logger.warning("eden sdk: queue full, dropped event")
                # Same rationale as above: the event being dropped here
                # (not the one evicted above) may itself be an offline
                # replay row if a concurrent producer refilled the
                # queue between the ``get_nowait`` and this
                # ``put_nowait``.
                if event.offline_row_id is not None:
                    self._mark_rows_unresolved([event.offline_row_id])
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

    # ── Offline auto-drain ───────────────────────────────────────────

    #: Minimum gap between automatic drain attempts, seconds. Without a gate the
    #: worker would hit SQLite on every idle tick to find nothing.
    _OFFLINE_DRAIN_INTERVAL_S = 5.0

    #: Rows pulled per automatic attempt. Deliberately smaller than
    #: ``flush_offline``'s default 100 so a large backlog is replayed in slices
    #: that interleave with live traffic instead of starving it.
    _OFFLINE_DRAIN_BATCH = 25

    def _auto_drain_offline(self) -> None:
        """Replay durable offline rows without blocking the worker.

        ``flush_offline()`` exists and is correct, but nothing ever called it —
        so events spilled to SQLite while the collector was unreachable stayed
        there indefinitely unless the application happened to call it by hand.
        For a durability feature whose whole purpose is "do not lose events when
        the network is down", never draining is the same as never having it.

        It cannot simply be invoked from here: ``flush_offline`` calls
        ``self.flush()``, which waits for the queue to drain — and the thing that
        drains the queue is this very worker. Calling it from inside the loop
        deadlocks until the 5s timeout, every tick.

        So the same work is split across ticks instead:

        * **ack first** — rows re-enqueued on an earlier tick whose sends have
          now completed are acked (deleted) unless they were marked unresolved.
        * **then pull** — only while the in-memory queue is empty, so replay
          never competes with live traffic, and only every
          ``_OFFLINE_DRAIN_INTERVAL_S``.

        The ack rule is identical to ``flush_offline``'s and rests on the same
        two facts: SQLite ``INTEGER PRIMARY KEY AUTOINCREMENT`` never reuses a
        row id, so absence from ``_unresolved_offline_rows`` is unambiguous
        evidence *this* row resolved; and a permanently rejected row is marked
        resolved rather than unresolved, so it is acked away instead of being
        resent to a doomed endpoint forever.
        """
        if self._offline is None:
            return
        # Non-blocking: if a manual ``flush_offline()`` holds the lock, skip this
        # tick entirely rather than queue up behind it.
        if not self._offline_replay_lock.acquire(blocking=False):
            return
        try:
            self._auto_drain_offline_locked()
        finally:
            self._offline_replay_lock.release()

    def _auto_drain_offline_locked(self) -> None:
        """Body of :meth:`_auto_drain_offline`, run under the replay lock."""
        if self._offline is None:
            return

        # ── ack what has resolved since the last tick ──
        if self._offline_inflight and (
            self._queue.empty()
            and self._processed_generation >= self._generation
        ):
            with self._unresolved_lock:
                unresolved = set(self._unresolved_offline_rows)
            ackable = [r for r in self._offline_inflight if r not in unresolved]
            if ackable:
                try:
                    self._offline.ack(ackable)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("eden sdk: offline ack failed: %s", exc)
            # Rows left unresolved stay in SQLite for a later attempt; drop the
            # in-flight tracking either way so the next slice can start.
            self._offline_inflight = []

        # ── pull the next slice, only when idle and not too often ──
        if self._offline_inflight or not self._queue.empty():
            return
        now = time.monotonic()
        if now < self._offline_next_drain_at:
            return
        self._offline_next_drain_at = now + self._OFFLINE_DRAIN_INTERVAL_S
        try:
            rows = self._offline.drain(limit=self._OFFLINE_DRAIN_BATCH)
        except Exception as exc:  # noqa: BLE001
            logger.warning("eden sdk: offline drain failed: %s", exc)
            return
        if not rows:
            return
        logger.debug("eden sdk: auto-replaying %d offline event(s)", len(rows))
        for rid, fmt, payload in rows:
            # ``skip_sampling`` so ClientSampler cannot discard a durable row
            # that would then be acked away as if delivered.
            self.enqueue(
                TraceEvent(payload=payload, source_format=fmt, offline_row_id=rid),
                skip_sampling=True,
            )
            self._offline_inflight.append(rid)

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
                #
                # Conditional on the queue being empty. Waiting
                # unconditionally meant that whenever ``_drain`` left a
                # backlog (queue deeper than one batch), the loop parked for a
                # full ``flush_interval`` with work already in hand — capping
                # throughput at about batch_size / flush_interval however fast
                # the transport was. Idle behaviour is unchanged: an empty queue
                # still parks on the event and wakes on the next enqueue.
                if self._queue.empty():
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
                # Replay durable offline rows. Non-blocking and idle-gated —
                # see ``_auto_drain_offline`` for why ``flush_offline`` itself
                # cannot be called from this thread. Placed after the send so a
                # replay slice is pulled only once the live batch is away.
                self._auto_drain_offline()
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
            # No org id, so there is nowhere to send. This used to drop
            # the buffer with no log AND without incrementing
            # _dropped_total, so `client.dropped` read 0 while every
            # streaming chunk was discarded — a misconfigured client
            # looked identical to a healthy idle one. The event path
            # already logs this; only chunks swallowed it.
            n = len(self._chunk_buffer)
            self._dropped_total += n
            if n:
                logger.warning(
                    "eden sdk: no org id configured — discarding %d "
                    "streaming chunk(s); set EDEN_ORG_ID",
                    n,
                )
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
            body, encoding = _compress_wire(_fast_dumps_bytes({"chunks": batch}))
            headers = self.config.auth_headers()
            headers.setdefault("Content-Type", "application/json")
            headers.setdefault("Content-Encoding", encoding)
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

    def _mark_rows_resolved(self, row_ids: list[int]) -> None:
        """Record that each id in ``row_ids`` had its most recent send
        attempt resolve (delivered, or permanently and intentionally
        dropped).

        ``row_ids`` are ``OfflineQueue`` row ids (``TraceEvent.offline_row_id``)
        for the specific rows this ``_send_format`` call just attempted --
        never a format-group-wide or batch-wide aggregate. No-op for
        events that did not originate from a durable-offline replay
        (``row_ids`` is already filtered to non-``None`` ids by the
        caller).

        Called from the background async-loop thread. Guarded by
        ``_unresolved_lock`` so ``flush_offline`` (running on the
        caller's thread) never observes a torn/partial update.
        """
        if not row_ids:
            return
        with self._unresolved_lock:
            for rid in row_ids:
                self._unresolved_offline_rows.discard(rid)

    def _mark_rows_unresolved(self, row_ids: list[int]) -> None:
        """Record that each id in ``row_ids`` was left *unresolved* --
        re-spilled to the offline queue under new row ids rather than
        delivered or permanently dropped. See ``_mark_rows_resolved``."""
        if not row_ids:
            return
        with self._unresolved_lock:
            self._unresolved_offline_rows.update(row_ids)

    async def _send_batch(self, batch: list[TraceEvent]) -> None:
        assert self._http is not None
        # Group by source_format so each ingestion route gets its own
        # request -- routes are 1:1 with decoder names. This grouping is
        # purely about *how many HTTP requests* to make; it is no longer
        # also doing double duty as the ack-resolution granularity (see
        # ``_mark_rows_resolved``/``_mark_rows_unresolved``), so groups
        # keep whole ``TraceEvent`` objects rather than bare payload
        # dicts -- each event's ``offline_row_id`` needs to survive
        # through to ``_send_format`` for that per-row bookkeeping.
        groups: dict[str, list[TraceEvent]] = {}
        for ev in batch:
            path_fmt = resolve_ingest_path(ev.source_format)
            groups.setdefault(path_fmt, []).append(ev)

        # Build auth headers once per batch; each format copies.
        base_headers = self.config.auth_headers()

        async def _send_format(
            source_format: str, events: list[TraceEvent]
        ) -> bool:
            """Returns ``True`` when this send is *resolved* -- either
            delivered (confirmed 2xx) or permanently undeliverable
            (non-retryable 4xx) and therefore intentionally dropped, never
            re-spilled. Returns ``False`` only when it is left
            *unresolved*: re-spilled to the offline queue for a later
            retry (exhausted retryable 5xx/408/429, or a transport
            exception).

            Also records the outcome at the granularity ``flush_offline``
            actually needs: per individual ``OfflineQueue`` row id (via
            ``_mark_rows_resolved``/``_mark_rows_unresolved``), for
            whichever of ``events`` carry one (``TraceEvent.offline_row_id``
            is ``None`` for ordinary, non-replay events and is simply
            skipped). This is deliberately independent of both the format
            group and how many other ``_send_format`` calls/generations
            this ``flush_offline()`` call spans -- two rows of the same
            format sent across two separate sub-batches must each keep
            their own outcome, never collapse onto a shared key. A
            permanent 4xx is resolved (in the sense that nothing further
            will ever be attempted for it) even though it was never
            delivered, so it must not block an ack either.
            """
            payloads = [ev.payload for ev in events]
            row_ids = [
                ev.offline_row_id for ev in events if ev.offline_row_id is not None
            ]
            count = len(payloads) if self._BATCH_AS_ARRAY else 1
            try:
                url = self.config.ingest_url(source_format)
                headers = dict(base_headers)
                headers.setdefault("Content-Type", "application/json")
                headers.setdefault("User-Agent", _USER_AGENT)
                if self.config.redact_on_client:
                    payloads = [redact_payload(p) for p in payloads]
                if self._BATCH_AS_ARRAY:
                    raw = _fast_dumps_bytes(payloads)
                else:
                    raw = _fast_dumps_bytes(payloads[0])
                    count = 1
                body, encoding = _compress_wire(raw)
                # Direct assignment (not setdefault): the wire encoding is
                # decided by ``_compress_wire`` (zstd when available, else
                # gzip) and must match the bytes actually sent.
                headers["Content-Encoding"] = encoding
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
                        self._spill_offline(source_format, events, payloads)
                        self._mark_rows_unresolved(row_ids)
                        return False

                    status = resp.status_code
                    if 200 <= status < 300:
                        # A 2xx does NOT mean every event was stored. The
                        # server answers {accepted, rejected, deduplicated,
                        # total} and rejects malformed rows individually.
                        # Crediting `count` regardless made a 100%-rejected
                        # batch indistinguishable from a clean flush — the
                        # exact shape that let a broken ingest endpoint sit
                        # unnoticed while SDKs reported success.
                        #
                        # Rejected rows are NOT retried: they are rejected
                        # for being malformed, so resending loops forever.
                        # They are surfaced instead, which is what the
                        # customer actually needs.
                        accepted, rejected, server_sampled_out = _parse_ingest_counts(
                            resp, count
                        )
                        self._sent_total += accepted
                        if server_sampled_out:
                            self._server_sampled_out_total += server_sampled_out
                        if rejected:
                            self._rejected_total += rejected
                            logger.warning(
                                "eden ingest %s: server rejected %d/%d event(s) "
                                "as malformed; they will NOT be retried",
                                source_format, rejected, count,
                            )
                        self._mark_rows_resolved(row_ids)
                        return True
                    if status == 413 and self._BATCH_AS_ARRAY and len(events) > 1:
                        # 413 is not permanent — it is a statement about *this
                        # batch's size*, and the same events split in two will
                        # succeed. Without this branch the classification below
                        # treated it as a non-retryable 4xx: the batch was
                        # counted as failed, deliberately not spilled ("would
                        # poison the offline queue with payloads that can never
                        # succeed"), and its offline rows were marked *resolved*
                        # — acked away as though delivered. So one oversized
                        # batch silently destroyed every event in it, including
                        # durable replay rows.
                        #
                        # The chunk path has had this bisect since it was
                        # written (``_post_chunk_batch``); the main event path
                        # never got it. Each half recurses through this same
                        # function, so per-row bookkeeping stays exact and a
                        # single pathological event ends up alone in a batch of
                        # one, where the genuine "too large to ever send"
                        # verdict is correct.
                        mid = len(events) // 2
                        logger.warning(
                            "eden ingest %s returned 413; splitting %d -> %d+%d",
                            source_format,
                            len(events),
                            mid,
                            len(events) - mid,
                        )
                        first = await _send_format(source_format, events[:mid])
                        second = await _send_format(source_format, events[mid:])
                        return first and second
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
                            self._spill_offline(source_format, events, payloads)
                            self._mark_rows_unresolved(row_ids)
                            return False
                        # Permanent failure: nothing was (or ever will
                        # be) spilled for it, so it's resolved -- must
                        # not block ``flush_offline``'s ack gate, or
                        # the offline row would sit forever and be
                        # resent to the same doomed endpoint on every
                        # replay.
                        self._mark_rows_resolved(row_ids)
                        return True
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
                self._spill_offline(source_format, events, payloads)
                self._mark_rows_unresolved(row_ids)
                return False

        # Each individual row's outcome is recorded independently (via
        # ``_mark_rows_resolved``/``_mark_rows_unresolved`` inside
        # ``_send_format``) as it resolves, rather than collapsed into
        # one aggregate flag per format group or per whole batch -- so a
        # failure for one row never taints the ack-eligibility of any
        # other row, whether it shares this row's format group, a
        # different one, or a different generation/sub-batch entirely.
        await asyncio.gather(
            *(_send_format(fmt, events) for fmt, events in groups.items())
        )

    def _spill_offline(
        self,
        source_format: str,
        events: list[TraceEvent],
        payloads: list[dict[str, Any]],
    ) -> None:
        """Durably persist a batch of payloads whose send just failed.

        ``events`` and ``payloads`` are parallel (same order, same
        length) -- ``payloads`` may have been redacted since ``events``
        was built (see the ``redact_on_client`` step in
        ``_send_format``), so both are needed: ``events`` tells us
        provenance (``TraceEvent.offline_row_id``), ``payloads`` is the
        actual content to persist.

        Two cases, handled differently to avoid unbounded row growth:

        * Fresh live-traffic failures (``offline_row_id is None`` --
          this payload has never been in the durable queue before):
          insert a brand-new row, exactly as before.
        * Re-spill of an already-durable row (``offline_row_id`` set --
          this payload originated from ``flush_offline()`` draining an
          existing ``OfflineQueue`` row and is now failing again):
          update that EXISTING row in place (same id, refreshed
          payload/timestamp) instead of inserting a second row.
          ``OfflineQueue.drain()`` is read-only and deletion only ever
          happens via explicit ``ack()`` -- so inserting a new row here
          without removing the original would duplicate that logical
          event on every failing ``flush_offline()`` cycle (1 -> 2 -> 4
          -> 8 -> ... rows) until ``max_rows`` is hit and
          ``_trim_locked()`` starts silently dropping the OLDEST rows
          (which need not even be the duplicates). Keeping the same row
          id also means ``_unresolved_offline_rows`` tracking (keyed by
          that id) needs no further changes -- the id never changes.
        """
        if self._offline is None:
            return
        fresh: list[tuple[str, dict[str, Any]]] = []
        durable_updates: list[tuple[int, str, dict[str, Any]]] = []
        for ev, payload in zip(events, payloads, strict=True):
            if ev.offline_row_id is not None:
                durable_updates.append((ev.offline_row_id, source_format, payload))
            else:
                fresh.append((source_format, payload))
        if durable_updates:
            try:
                self._offline.update_many(durable_updates)
            except Exception as exc:  # noqa: BLE001
                # Fall back to per-row so a single bad row does not
                # drop the whole update batch.
                logger.debug("offline spill update failed: %s", exc)
                for rid, fmt, payload in durable_updates:
                    try:
                        self._offline.update_many([(rid, fmt, payload)])
                    except Exception as row_exc:  # noqa: BLE001
                        logger.debug(
                            "offline spill update failed for row %s: %s",
                            rid,
                            row_exc,
                        )
        if fresh:
            try:
                self._offline.enqueue_many(fresh)
            except Exception as exc:  # noqa: BLE001
                # Fall back to per-row so a single bad payload does not
                # drop the whole spill batch.
                logger.debug("offline spill batch failed: %s", exc)
                for fmt, payload in fresh:
                    try:
                        self._offline.enqueue(fmt, payload)
                    except Exception as row_exc:  # noqa: BLE001
                        logger.debug("offline spill failed: %s", row_exc)

    def flush_offline(self, limit: int = 100, *, timeout: float = 5.0) -> int:
        """Re-enqueue durable offline events after reconnect. Returns count acked.

        Rows stay in SQLite until flush fully succeeds (queue drained,
        in-flight send completed) AND that specific row actually
        reported success or was permanently, non-retryably rejected. On
        timeout, leftover in-memory events, or a *retryable* send
        failure, a row's id is left unacked so a later replay can
        retry. Sampling is bypassed on this path so ClientSampler
        cannot drop durable rows that would then be acked away.

        The ack decision is made **per row id**, not per format group
        and not for the call as a whole: a single ``flush_offline()``
        call can drain more rows than one ``_send_batch`` tick handles
        (the background loop caps a drain at ``config.batch_size``,
        default 50, while this method's own default ``limit`` is 100),
        so two rows of the *same* format group can end up sent in two
        separate generations/sub-batches within one call. Gating on
        anything coarser than the row id itself -- a shared aggregate
        flag for the whole call, or a shared key per format group --
        risks one row's outcome silently overwriting another's: e.g. a
        delivered ``openai`` row from generation 1 and a
        retry-exhausted ``openai`` row from generation 2 of the same
        call must each keep their own fate, independent of send order,
        rather than collapsing onto one shared "openai" result where
        whichever write happens last wins. Every row id drained here is
        checked against ``_unresolved_offline_rows`` individually, so
        exactly the rows that resolved (delivered or permanently
        rejected) in *this* call are acked, regardless of how many
        generations, sub-batches, or format groups this call's rows
        were scattered across.

        A retryable-failed send is NOT the same as a completed one:
        ``_send_batch`` swallows all exceptions internally and re-spills
        retryable failures (exhausted 5xx/408/429, transport errors) to
        the offline queue as brand-new rows, but it still unconditionally
        bumps ``_processed_generation`` in its ``finally`` block. Gating
        the ack purely on "queue drained and generation caught up" would
        therefore report a positive acked count even when the events were
        merely re-spilled under new row ids, not delivered -- so we also
        require, per row id, that it was not marked unresolved
        (``_unresolved_offline_rows``). Because ``OfflineQueue`` row ids
        are never reused (SQLite ``INTEGER PRIMARY KEY AUTOINCREMENT``),
        a row id found absent from that set is unambiguous evidence this
        specific row resolved -- no "since this call started" baseline
        is needed the way the coarser format-group tracking required.

        Permanent, non-retryable rejections (e.g. 400/401/422) are the
        one exception: they are deliberately never re-spilled (see
        ``_spill_offline`` callers in ``_send_batch``) since they can
        never succeed, so the row is marked *resolved* (see
        ``_mark_rows_resolved``) rather than unresolved -- it is acked
        away after the single attempt just like a successful delivery,
        instead of being resent to the same doomed endpoint forever.
        """
        if self._offline is None:
            return 0
        # Serialised against the worker's automatic drain and against another
        # thread calling this method: ``drain`` does not claim rows, so two
        # overlapping replays would send the same rows twice.
        with self._offline_replay_lock:
            return self._flush_offline_locked(limit=limit, timeout=timeout)

    def _flush_offline_locked(self, *, limit: int, timeout: float) -> int:
        """Body of :meth:`flush_offline`, run under the replay lock."""
        if self._offline is None:
            return 0
        drained = self._offline.drain(limit=limit)
        if not drained:
            return 0
        ids: list[int] = []
        for rid, fmt, payload in drained:
            self.enqueue(
                TraceEvent(payload=payload, source_format=fmt, offline_row_id=rid),
                skip_sampling=True,
            )
            ids.append(rid)
        self.flush(timeout=timeout)
        if not (
            self._queue.empty() and self._processed_generation >= self._generation
        ):
            # Timed out, or the in-flight send hasn't finished yet --
            # nothing this call attempted is confirmed resolved.
            return 0
        # Snapshot under the lock so a concurrent background-thread
        # mutation (another row resolving or failing in a later,
        # unrelated batch) can't be observed mid-iteration.
        with self._unresolved_lock:
            unresolved_snapshot = set(self._unresolved_offline_rows)
        ackable_ids = [rid for rid in ids if rid not in unresolved_snapshot]
        if not ackable_ids:
            return 0
        self._offline.ack(ackable_ids)
        return len(ackable_ids)

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
    def server_sampled_out(self) -> int:
        """Events the SERVER's own N16 gate dropped after accepting the
        request. Parsed from the ingest response's ``sampled_out`` field —
        see :func:`_parse_ingest_counts`. Distinct from :attr:`sampled_out`
        (this SDK's own :class:`~eden_sdk.sampling.ClientSampler` decision,
        made before the event is ever sent)."""
        return self._server_sampled_out_total

    @property
    def failed(self) -> int:
        return self._failed_total

    @property
    def rejected(self) -> int:
        """Events the server accepted the request for but refused to store.

        Distinct from :attr:`failed` (the request itself did not
        succeed). A 2xx carries per-row outcomes in its body — a fully
        rejected batch still returns 200 — so without this counter a
        100%-rejected stream is indistinguishable from a healthy one.
        These are NOT retried: they are rejected as malformed, so
        resending would loop forever.
        """
        return self._rejected_total

    @property
    def offline_dropped(self) -> int:
        """Rows silently evicted from the durable offline queue on overflow.

        ``0`` when no offline queue is configured. Distinct from
        :attr:`dropped` (in-memory queue back-pressure drops) -- this
        counts durable SQLite rows lost because the offline queue itself
        hit ``max_rows`` while the network was down for a long stretch.
        Surfaced here so operators can actually observe offline-queue
        data loss instead of it being a write-only counter.
        """
        if self._offline is None:
            return 0
        return self._offline.dropped

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
# Serializes the *slow* work of building + starting a fresh singleton
# (construction plus ``start()``'s up-to-1s blocking wait on
# ``_loop_started``). ``_lock`` itself is only ever held for quick
# reads/writes of the ``_default`` pointer -- so ``reset_default_client()``
# and ``_atexit_shutdown()`` (which also take ``_lock``) are never stuck
# behind another thread's in-flight sender startup. See the analogous
# ``EdenClient._lifecycle_lock`` comment (~line 191) for why the
# check-and-create step still needs *some* lock even though the wait
# itself doesn't need to hold it.
_init_lock = threading.Lock()


def get_default_client() -> EdenClient:
    """Return the process-wide :class:`EdenClient` singleton.

    The first call also starts the sender thread and registers an
    :mod:`atexit` hook for a best-effort final flush.

    Concurrent first-callers serialize on ``_init_lock`` (not the
    short-lived ``_lock``) while one of them constructs the client and
    runs its blocking ``start()``. Callers never get a client back
    before its ``start()`` has been attempted and resolved -- so a
    caller can't observe a half-initialized sender, matching the
    invariant ``EdenClient.start()`` documents for its own
    ``_lifecycle_lock``.
    """
    global _default, _atexit_registered
    with _lock:
        if _default is not None:
            return _default
    with _init_lock:
        with _lock:
            if _default is not None:
                return _default
        client = EdenClient()
        try:
            client.start()
        except Exception:
            # start() failed (the sender thread died before flipping
            # _loop_started). Do NOT publish this broken client --
            # `_default` was never assigned in this branch, so it's
            # already None, but we clear it explicitly (mirroring
            # reset_default_client()'s pattern) so a future refactor
            # that publishes earlier can't silently reintroduce a
            # poisoned singleton that every subsequent call would
            # return with no retry and 100% event loss.
            with _lock:
                _default = None
            raise
        with _lock:
            _default = client
            if not _atexit_registered:
                atexit.register(_atexit_shutdown)
                _atexit_registered = True
        return client


def _atexit_shutdown() -> None:
    global _default
    # Guarded by ``_lock`` (mirroring ``reset_default_client()``) so a
    # background thread calling ``get_default_client()`` concurrently
    # with atexit teardown can't get a reference to a client whose
    # worker thread is already gone mid-shutdown -- which would leave
    # its enqueued events sitting in ``self._queue`` forever with
    # nothing left to drain them.
    with _lock:
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
