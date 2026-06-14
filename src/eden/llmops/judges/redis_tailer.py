"""RedisTailer — async worker that consumes the
``telemetry:{tenant_id}:{trace_id}:events`` Redis stream written by
``TelemetryCollector._route_redis`` and runs the registered judges
on each qualifying event.

The tailer is started from ``src/eden/api/app.py``'s ``lifespan``
context and runs as a background task. Per-tenant concurrency is
capped to avoid stampeding the judge LLM on a high-volume tenant.

Failure policy: any single error in the read loop is logged and
the loop continues. The tailer must never crash the app process.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import logging
from typing import Any

from .registry import get_judge_registry
from .runner import JudgeRunner

logger = logging.getLogger(__name__)


# Redis stream key shape — mirrors what
# ``TelemetryCollector._route_redis`` writes.
def _stream_key(tenant_id: str, trace_id: str) -> str:
    return f"telemetry:{tenant_id}:{trace_id}:events"


class _LightEvent:
    """Minimal stand-in for ``TelemetryEvent`` used by the tailer.

    Defined at module level so the hot loop in ``_process_key``
    doesn't rebuild the class object on every event. The slots
    mirror the fields the judges actually read.
    """

    __slots__ = (
        "event_id", "event_type", "trace_id", "span_id",
        "payload", "attributes", "tags", "source_format",
        "tenant_id", "agent_id", "environment_id",
        "metrics", "duration_ms", "outcome", "name",
        "timestamp", "realm", "project_id",
        "agent_version", "parent_span_id",
    )


class RedisTailer:
    """Background worker: tail Redis telemetry stream → run judges.

    The worker enumerates ``telemetry:*:events`` keys (cheap with
    SCAN; a server with many keys would warrant a per-tenant
    subscription instead), reads the most recent entries, and runs
    the registry's judges on each new event. Scoring is best-effort.

    On every Nth tick (default: every tick) the tailer also invokes
    ``PromotionLoop.run_once()`` so the closed-loop flywire keeps
    advancing. Same async / best-effort posture: a failure logs and
    the loop continues.

    Concurrency: ``max_concurrent_per_tenant`` is enforced via a
    per-tenant ``asyncio.Semaphore`` so a noisy tenant can't
    starve quieter ones.
    """

    def __init__(
        self,
        *,
        llm_client: Any = None,
        max_concurrent_per_tenant: int = 4,
        poll_interval_seconds: float = 1.0,
        max_events_per_poll: int = 100,
        promotion_loop_every_n_polls: int = 1,
    ) -> None:
        self.llm_client = llm_client
        self.max_concurrent_per_tenant = max_concurrent_per_tenant
        self.poll_interval_seconds = poll_interval_seconds
        self.max_events_per_poll = max_events_per_poll
        # Run ``PromotionLoop.run_once()`` every N polls (default: every
        # poll). Set to 0 to disable the promotion loop entirely.
        self.promotion_loop_every_n_polls = promotion_loop_every_n_polls
        self._semaphores: dict[str, asyncio.Semaphore] = {}
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._poll_count: int = 0
        # Cached runner — JudgeRunner construction is cheap but not
        # free, and ``_poll_once`` runs on every tick (default 1 Hz).
        # Reusing it avoids per-tick allocation.
        self._runner: JudgeRunner | None = None
        # Cross-poll dedup set. The previous implementation
        # allocated a fresh ``set`` inside ``_poll_once``, which
        # meant events straddling a poll boundary could be
        # re-scored (duplicate judge runs + duplicate promotion
        # actions). Hold it as instance state so dedup is
        # continuous across ticks.
        # Bounded so the tailer can't OOM if it loses its
        # backing store; ``maxlen`` evicts oldest-first.
        self._seen: collections.deque[str] = collections.deque(maxlen=50_000)
        self._seen_set: set[str] = set()

    async def start(self) -> None:
        """Start the background polling task. Idempotent."""
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="judge-redis-tailer")

    async def stop(self) -> None:
        """Stop the background task. Awaits current iteration."""
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (TimeoutError, asyncio.CancelledError):
                self._task.cancel()

    async def _run(self) -> None:
        """Main loop. Errors are logged and looped over."""
        from eden.config import get_settings
        settings = get_settings()
        if not getattr(settings, "judges_async_tailer_enabled", True):
            logger.info("judges_async_tailer disabled by settings; tailer not starting")
            return

        logger.info("judge redis tailer started")
        while not self._stop.is_set():
            try:
                await self._poll_once()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning(f"judge tailer poll failed: {exc}")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    self._stop.wait(), timeout=self.poll_interval_seconds
                )
        logger.info("judge redis tailer stopped")

    async def _poll_once(self) -> None:
        """One iteration: enumerate known stream keys, pull recent
        entries, run judges on each.

        The tailer uses an in-memory set of seen event_ids so it
        doesn't re-score the same event. Realistically a Redis
        consumer group + last-delivered-id cursor is the right
        primitive; that's the Phase 3 upgrade.
        """
        self._poll_count += 1

        from eden.storage.redis import get_redis_client

        client = await get_redis_client()
        if client is None:
            return

        registry = get_judge_registry()
        if self._runner is None:
            self._runner = JudgeRunner(llm_client=self.llm_client)
        runner = self._runner
        # Use the instance-level dedup set so an event that
        # straddles two poll cycles is only scored once. The
        # matching ``_seen`` deque enforces the maxlen cap so
        # the in-memory dedup state can't grow without bound
        # (e.g. if the backing store were reset and the tailer
        # restarted without the queue being cleared).
        seen = self._seen_set

        # Enumerate keys. SCAN avoids blocking the server.
        try:
            async for key in client.scan_iter(match="telemetry:*:events", count=200):
                key_str = key.decode() if isinstance(key, bytes) else str(key)
                # Parse tenant_id + trace_id out of the key.
                parts = key_str.split(":")
                if len(parts) != 4:
                    continue
                _, tenant_id, trace_id, _ = parts
                await self._process_key(
                    client, key_str, tenant_id, trace_id,
                    registry, runner, seen,
                )
        except Exception as exc:
            logger.debug(f"scan_iter failed: {exc}")

        # Promotion loop — runs the closed-loop flywire on the same
        # tick. Same best-effort posture: a failure is logged, the
        # outer loop continues.
        if self.promotion_loop_every_n_polls > 0 and (
            self._poll_count % self.promotion_loop_every_n_polls == 0
        ):
            try:
                from eden.llmops.promotion import get_promotion_loop
                loop = get_promotion_loop()
                await loop.run_once()
            except Exception as exc:
                logger.debug(f"promotion loop tick failed: {exc}")

    async def _process_key(
        self,
        client: Any,
        key: str,
        tenant_id: str,
        trace_id: str,
        registry: Any,
        runner: JudgeRunner,
        seen: set[str],
    ) -> None:
        try:
            # Read the most recent N entries.
            entries = await client.xrevrange(key, "+", "-", count=self.max_events_per_poll)
        except Exception as exc:
            logger.debug(f"xrevrange {key} failed: {exc}")
            return

        sem = self._semaphores.setdefault(
            tenant_id,
            asyncio.Semaphore(self.max_concurrent_per_tenant),
        )
        for entry in entries:
            # entry: (id, fields) where fields is a dict of bytes
            entry_id_bytes, fields = entry
            entry_id = entry_id_bytes.decode() if isinstance(entry_id_bytes, bytes) else str(entry_id_bytes)
            if entry_id in seen:
                continue
            # Add to the dedup set; mirror into the bounded
            # deque so we can evict the oldest entry from the
            # set when the deque is full. The deque's
            # ``maxlen`` automatically pops the oldest on the
            # next append, so we synchronise by dropping the
            # matching entry from the set whenever the deque
            # reaches its cap.
            seen.add(entry_id)
            self._seen.append(entry_id)
            if len(self._seen) >= self._seen.maxlen:
                oldest = self._seen.popleft()
                self._seen_set.discard(oldest)
            data = fields.get(b"data") if isinstance(fields, dict) else None
            if data is None:
                continue
            data_str = data.decode() if isinstance(data, bytes) else str(data)
            try:
                event_dict = json.loads(data_str)
            except (ValueError, TypeError):
                continue

            # Build a minimal TelemetryEvent from the dict for the
            # judge. We don't reconstruct the full dataclass — the
            # judges only need payload + event_type + trace_id. The
            # class is defined at module level to avoid recreating it
            # on every event in the hot path.
            event = _LightEvent()
            for f in _LightEvent.__slots__:
                setattr(event, f, event_dict.get(f))

            judges = registry.for_event(event)
            if not judges:
                continue

            async with sem:
                try:
                    await runner.run_for_event(event, judges, trace_id=trace_id)  # type: ignore[arg-type]
                except Exception as exc:
                    logger.debug(f"runner.run_for_event failed: {exc}")
