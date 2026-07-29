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
import contextlib
import json
import logging
from typing import Any

from .registry import get_judge_registry
from .runner import JudgeRunner

logger = logging.getLogger(__name__)


def _id_key(entry_id: str) -> tuple[int, int]:
    """Order a Redis stream id (``"<ms>-<seq>"``) numerically.

    String comparison is wrong here — ``"10-0" < "9-0"`` lexicographically
    — and the cursor depends on getting this right.
    """
    ms, _, seq = str(entry_id).partition("-")
    try:
        return (int(ms), int(seq or 0))
    except ValueError:
        return (0, 0)


# Redis stream key shape — mirrors what
# ``TelemetryCollector._route_redis`` writes.
def _stream_key(tenant_id: str, trace_id: str) -> str:
    return f"telemetry:{tenant_id}:{trace_id}:events"


class RedisTailer:
    """Background worker: tail Redis telemetry stream → run judges.

    The worker enumerates ``telemetry:*:events`` keys (cheap with
    SCAN; a server with many keys would warrant a per-tenant
    subscription instead), reads the most recent entries, and runs
    the registry's judges on each new event. Scoring is best-effort.

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
    ) -> None:
        self.llm_client = llm_client
        self.max_concurrent_per_tenant = max_concurrent_per_tenant
        self.poll_interval_seconds = poll_interval_seconds
        self.max_events_per_poll = max_events_per_poll
        self._semaphores: dict[str, asyncio.Semaphore] = {}
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None
        # COST: stream key -> highest entry id already scored. Without a
        # cursor that survives the poll, every event in the newest N
        # entries was re-judged once per ``poll_interval_seconds`` for as
        # long as it stayed in the window — an LLM call per event per
        # second. Bounded so a long-lived process cannot leak one entry
        # per trace stream forever.
        self._cursors: dict[str, str] = {}

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
        if not getattr(settings, "judges_async_tailer_enabled", False):
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
        from eden.config import get_settings
        from eden.storage.redis import get_redis_client

        settings = get_settings()
        client = await get_redis_client()
        if client is None:
            return

        registry = get_judge_registry()
        runner = JudgeRunner(llm_client=self.llm_client)
        seen: set[str] = set()
        max_keys = int(getattr(settings, "judges_async_tailer_max_keys", 50))

        # Enumerate keys. SCAN avoids blocking the server.
        try:
            scanned = 0
            async for key in client.scan_iter(match="telemetry:*:events", count=200):
                if scanned >= max_keys:
                    break
                scanned += 1
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

    # Cap on tracked stream cursors. One entry per trace stream, so this
    # is the only thing standing between a long-lived tailer and an
    # unbounded dict. FIFO eviction: the oldest key seen is dropped first.
    MAX_CURSORS = 5_000

    def _remember_cursor(self, key: str, entry_id: str) -> None:
        if key not in self._cursors and len(self._cursors) >= self.MAX_CURSORS:
            self._cursors.pop(next(iter(self._cursors)), None)
        self._cursors[key] = entry_id

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
        last_id = self._cursors.get(key)
        try:
            if last_id is None:
                # First sighting of this stream: take only the newest N so
                # a long pre-existing backlog is not replayed in full.
                entries = await client.xrevrange(
                    key, "+", "-", count=self.max_events_per_poll
                )
            else:
                # Resume from the cursor. XRANGE's start is inclusive, so
                # the entry equal to the cursor is filtered out below.
                entries = await client.xrange(
                    key, last_id, "+", count=self.max_events_per_poll + 1
                )
        except Exception as exc:
            logger.debug(f"stream read {key} failed: {exc}")
            return

        sem = self._semaphores.setdefault(
            tenant_id,
            asyncio.Semaphore(self.max_concurrent_per_tenant),
        )
        high_water = last_id
        for entry in entries:
            # entry: (id, fields) where fields is a dict of bytes
            entry_id_bytes, fields = entry
            entry_id = entry_id_bytes.decode() if isinstance(entry_id_bytes, bytes) else str(entry_id_bytes)
            if last_id is not None and _id_key(entry_id) <= _id_key(last_id):
                continue
            if entry_id in seen:
                continue
            seen.add(entry_id)
            # Advance the cursor for EVERY entry we consumed, including
            # ones skipped below as malformed or judge-less — otherwise a
            # single unparseable entry would be re-read on every poll.
            if high_water is None or _id_key(entry_id) > _id_key(high_water):
                high_water = entry_id
                self._remember_cursor(key, entry_id)
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
            # judges only need payload + event_type + trace_id.
            class _LightEvent:
                __slots__ = ("event_id", "event_type", "trace_id", "span_id",
                             "payload", "attributes", "tags", "source_format",
                             "tenant_id", "agent_id", "environment_id",
                             "metrics", "duration_ms", "outcome", "name",
                             "timestamp", "realm", "project_id",
                             "agent_version", "parent_span_id")

            event = _LightEvent()
            for f in _LightEvent.__slots__:
                setattr(event, f, event_dict.get(f))

            judges = registry.for_event(event)  # type: ignore[arg-type]
            if not judges:
                continue

            async with sem:
                try:
                    await runner.run_for_event(event, judges, trace_id=trace_id)  # type: ignore[arg-type]
                except Exception as exc:
                    logger.debug(f"runner.run_for_event failed: {exc}")


# ── Lifespan helpers (N14) ──────────────────────────────────────────

_DEFAULT_TAILER: RedisTailer | None = None


async def start_judge_tailer(settings: Any | None = None) -> RedisTailer | None:
    """Start the process-wide judge Redis tailer (N14 optional path).

    No-op when ``judges_async_tailer_enabled`` is False. Idempotent.
    """
    global _DEFAULT_TAILER
    if settings is None:
        from eden.config import get_settings

        settings = get_settings()
    if not getattr(settings, "judges_async_tailer_enabled", False):
        logger.info("judge tailer: disabled by Settings")
        return None
    if _DEFAULT_TAILER is None:
        _DEFAULT_TAILER = RedisTailer()
    await _DEFAULT_TAILER.start()
    return _DEFAULT_TAILER


async def stop_judge_tailer() -> None:
    """Stop the process-wide judge Redis tailer if running."""
    global _DEFAULT_TAILER
    if _DEFAULT_TAILER is None:
        return
    await _DEFAULT_TAILER.stop()
    _DEFAULT_TAILER = None
