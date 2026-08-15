"""Redis-backed leader election for singleton background loops.

When multiple API replicas or worker containers run the same periodic
task, only the process holding the leader lock executes work. Followers
sleep and retry acquisition on the next interval.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from eden.observability.simple_metrics import Gauge
from eden.storage.empty_cooldown import next_grid_delay
from eden.storage.redis import Lock

logger = logging.getLogger(__name__)


async def _extend_lock_periodically(
    lock: Lock,
    interval: float,
    stop: asyncio.Event,
    *,
    lost: asyncio.Event | None = None,
) -> None:
    """Background task that extends the leader lock while work runs.

    When ``lost`` is provided it is set the moment extension fails or
    the lock is confirmed lost — before this function returns — so a
    caller (``run_if_leader``) can cancel in-flight work immediately
    instead of only learning about it after the fact. Without this,
    two replicas can legitimately hold "the lock" concurrently for as
    long as the losing replica's ``work()`` call keeps running: a
    second replica re-acquires the now-expired lock and starts its own
    tick while the first replica's stale tick is still executing.
    """
    while not stop.is_set():
        await asyncio.sleep(interval)
        if stop.is_set():
            break
        try:
            extended = await lock.extend(lock.ttl)
        except Exception as exc:
            logger.warning(
                "leader: extend raised for %s: %s", lock.name, exc
            )
            if lost is not None:
                lost.set()
            break
        if not extended:
            logger.warning("leader: lost lock %s during extend", lock.name)
            if lost is not None:
                lost.set()
            break


#: Lock TTL is intentionally decoupled from the caller's tick
#: ``interval`` (which can be hours, e.g. the 3600s artifact-demotion
#: loop). A hard-crashed leader (SIGKILL, no exception path to release
#: the lock) blocks failover until the lock's TTL expires — tying that
#: TTL to a multi-hour tick interval means a healthy replica cannot
#: take over for hours. Keeping it fixed + short, renewed frequently
#: while work is in-flight, bounds the failover window to roughly one
#: renewal period regardless of how long the tick itself is.
#:
#: P0-1 (2026-08-10): both values raised 3× (TTL 60→180, renew 20→60)
#: to cut Upstash EVAL burn — every renewal is one Redis command, so
#: this is 4,320 → 1,440 cmds/day per held lock. The 3:1 TTL:renew ratio
#: is preserved (matching ``sidecars``' guard), keeping a delayed/slow
#: renewal comfortably inside the TTL.
_DEFAULT_LOCK_TTL_SECONDS = 180
_DEFAULT_LOCK_RENEW_SECONDS = 60.0

#: Hard ceiling on a single acquisition attempt. Generous next to the
#: client's own 2s socket timeout — this is not a latency budget, it is
#: the backstop for the case where that timeout does not fire at all.
_ACQUIRE_TIMEOUT_SECONDS = 15.0

#: Consecutive failed acquisitions, per lock name. ``Lock.acquire`` fails
#: closed on any Redis error — it warns and returns False — so a broken or
#: quota-exhausted Redis makes every leader-gated loop spin silently while
#: the process looks perfectly healthy. Counting the failures gives the
#: unconditional liveness heartbeat something concrete to report.
_acquire_failures: dict[str, int] = {}

#: Last exception seen from a leader-gated ``work()`` call, per lock name.
#: Acquisition succeeding and the work then throwing produces the same
#: outward evidence as never acquiring at all — no heartbeat, no progress,
#: acquire-failure count still zero — and only an ERROR line in container
#: logs distinguishes them. Recording it here lets the liveness heartbeat
#: carry the distinction out of the container.
_work_failures: dict[str, str] = {}

#: Lock names currently held via Postgres, so the renew and release paths
#: know which backend owns them. Postgres is now the primary election
#: backend; this dict tracks the common case. Redis entries are absent
#: (popped when Redis wins the fallback path).
_pg_fallback_held: dict[str, str] = {}


def leader_pg_fallback_locks() -> dict[str, str]:
    """``{lock_name: holder}`` for locks held through Postgres."""
    return dict(_pg_fallback_held)


async def _acquire_with_fallback(
    lock: Lock, lock_name: str, identity: str, ttl: int
) -> tuple[bool, str]:
    """Acquire via Postgres (primary), falling back to Redis when Postgres is unavailable.

    Returns ``(acquired, backend)``. ``backend`` is ``"postgres"``,
    ``"redis"`` or ``"none"``.

    Postgres is the primary election backend: a single Neon statement per
    tick, no Upstash command-budget impact, and proven to survive a Redis
    quota outage (2026-07-29 incident, 7.4 days down). Redis is the
    fallback for when Postgres itself is unreachable (no client, connection
    error, table ensure failed).

    When Postgres returns False (another holder has a live lease), we stay a
    follower and do NOT try Redis — the single-holder guarantee is provided
    by the DB's atomic INSERT … ON CONFLICT; consulting a second backend
    after a DB refusal would risk split-brain leadership.

    Redis fallback: mirrors the old primary logic — try acquire, check the
    holder on refusal, and stay follower only when a real peer is listed.
    Refused-with-no-holder means Redis is not accepting writes and is treated
    the same as Postgres unavailable: not contention.
    """
    from eden.storage import pg_lease

    # Primary: try Postgres first.
    pg_result = await pg_lease.acquire(lock_name, identity, ttl)
    if pg_result is True:
        _pg_fallback_held[lock_name] = identity
        return True, "postgres"
    if pg_result is False:
        # Another holder owns a live lease. Do NOT fall back to Redis — that
        # would let two processes each win on different backends (split-brain).
        return False, "none"

    # pg_result is None → Postgres is unavailable; fall back to Redis.
    logger.warning(
        "leader: %s Postgres unavailable — falling back to Redis for leader election",
        lock_name,
    )
    try:
        acquired = await asyncio.wait_for(
            lock.acquire(token=identity), timeout=_ACQUIRE_TIMEOUT_SECONDS
        )
    except TimeoutError:
        acquired = False
    except Exception as exc:
        logger.warning("leader: redis acquire %s raised: %s", lock_name, exc)
        acquired = False

    if acquired:
        _pg_fallback_held.pop(lock_name, None)
        return True, "redis"

    # Redis refused. Check whether a real peer holds it.
    holder = None
    try:
        holder = await asyncio.wait_for(lock.holder(), timeout=5.0)
    except Exception:
        holder = None
    if holder:
        return False, "none"  # genuine Redis contention; stay a follower

    # Redis also refused with no holder — both backends are unavailable.
    logger.warning(
        "leader: %s both Postgres and Redis unavailable; cannot elect leader",
        lock_name,
    )
    return False, "none"


#: ``{lock_name: [loop_iterations, work_invocations]}``. Redis reachable,
#: zero acquire failures, zero work failures and zero output is a
#: contradiction unless the loops never reach the acquire call at all —
#: these two counters are what tell those apart, and nothing else can.
_tick_counts: dict[str, list[int]] = {}


def leader_tick_counts() -> dict[str, list[int]]:
    """``{lock_name: [iterations, work_runs]}`` for the liveness heartbeat."""
    return {k: list(v) for k, v in _tick_counts.items()}


def leader_acquire_failure_count(lock_name: str | None = None) -> int:
    """Consecutive failed acquisitions for ``lock_name`` (or all locks)."""
    if lock_name is not None:
        return _acquire_failures.get(lock_name, 0)
    return sum(_acquire_failures.values())


def leader_work_failures() -> dict[str, str]:
    """Last work exception per lock name (``{}`` when all is well)."""
    return dict(_work_failures)


# ── Watermark batch coverage (OPT-28) ─────────────────────────────────────
#
# Leader-gated cron loops that pick a bounded batch via
# ``fetch_stale_candidates`` can look perfectly healthy while silently
# starving everything past ``LIMIT`` when selection regresses to an
# unordered query. Exception-based monitoring cannot see that — the tick
# succeeds, heartbeats stay green, and the excluded tail only grows.
#
# These gauges compare "entities processed in the last N days" against the
# live candidate population for each watermarked job. A shrinking ratio is
# the alertable signal that batch selection is no longer cycling.


_DEFAULT_COVERAGE_WINDOW_DAYS = 7
_COVERAGE_WARN_RATIO = 0.5


@dataclass(frozen=True)
class _WatermarkCoverageJob:
    name: str
    candidate_count_sql: str
    processed_recent_sql: str


_WATERMARK_COVERAGE_JOBS: tuple[_WatermarkCoverageJob, ...] = (
    _WatermarkCoverageJob(
        "auto_curator",
        "SELECT COUNT(*)::float FROM organizations",
        (
            "SELECT COUNT(*)::float FROM auto_curator_watermark "
            "WHERE last_processed_at > NOW() - make_interval(days => $1)"
        ),
    ),
    _WatermarkCoverageJob(
        "classifier_retrain",
        (
            "SELECT COUNT(*)::float FROM ("
            "SELECT DISTINCT org_id, signal_id FROM signal_events "
            "WHERE detected_at > NOW() - INTERVAL '7 days'"
            ") t"
        ),
        (
            "SELECT COUNT(*)::float FROM classifier_retrain_watermark "
            "WHERE last_processed_at > NOW() - make_interval(days => $1)"
        ),
    ),
    _WatermarkCoverageJob(
        "drift_baselines",
        (
            "SELECT COUNT(*)::float FROM ("
            "SELECT DISTINCT org_id, agent_id FROM agent_issues "
            "WHERE last_seen >= NOW() - INTERVAL '7 days' "
            "AND agent_id IS NOT NULL"
            ") t"
        ),
        (
            "SELECT COUNT(*)::float FROM drift_baseline_watermark "
            "WHERE last_processed_at > NOW() - make_interval(days => $1)"
        ),
    ),
    _WatermarkCoverageJob(
        "retention_archive",
        "SELECT COUNT(*)::float FROM organizations",
        (
            "SELECT COUNT(*)::float FROM retention_archive_watermark "
            "WHERE last_processed_at > NOW() - make_interval(days => $1)"
        ),
    ),
)


class _WatermarkCoverageMetrics:
    candidates_total = Gauge(
        "watermark_coverage_candidates_total",
        "Live candidate population for a watermarked batch job",
        labelnames=("job",),
    )
    processed_recent = Gauge(
        "watermark_coverage_processed_recent_total",
        "Distinct entities processed inside the coverage window",
        labelnames=("job", "window_days"),
    )
    ratio = Gauge(
        "watermark_coverage_ratio",
        "processed_recent / candidates_total for a watermarked batch job",
        labelnames=("job", "window_days"),
    )


_last_watermark_coverage: dict[str, dict[str, float]] = {}


def watermark_coverage_snapshot() -> dict[str, dict[str, float]]:
    """Last computed coverage per job — surfaced on the worker heartbeat."""
    return {job: dict(stats) for job, stats in _last_watermark_coverage.items()}


def reset_watermark_coverage() -> None:
    """Test-only: clear cached coverage snapshots."""
    _last_watermark_coverage.clear()
    _WatermarkCoverageMetrics.candidates_total.reset()
    _WatermarkCoverageMetrics.processed_recent.reset()
    _WatermarkCoverageMetrics.ratio.reset()


async def refresh_watermark_coverage(
    pg: Any,
    *,
    window_days: int = _DEFAULT_COVERAGE_WINDOW_DAYS,
) -> dict[str, dict[str, float]]:
    """Recompute coverage gauges for every registered watermarked job."""
    window_key = str(window_days)
    out: dict[str, dict[str, float]] = {}
    for job in _WATERMARK_COVERAGE_JOBS:
        try:
            total = float(await pg.fetchval(job.candidate_count_sql) or 0.0)
            recent = float(
                await pg.fetchval(job.processed_recent_sql, window_days) or 0.0
            )
        except Exception as exc:
            logger.warning(
                "leader: watermark coverage query failed for %s: %s",
                job.name,
                exc,
            )
            continue
        ratio = (recent / total) if total > 0 else 1.0
        stats = {
            "candidates_total": total,
            "processed_recent": recent,
            "ratio": ratio,
            "window_days": float(window_days),
        }
        out[job.name] = stats
        _last_watermark_coverage[job.name] = stats
        _WatermarkCoverageMetrics.candidates_total.labels(job=job.name).set(total)
        _WatermarkCoverageMetrics.processed_recent.labels(
            job=job.name, window_days=window_key
        ).set(recent)
        _WatermarkCoverageMetrics.ratio.labels(
            job=job.name, window_days=window_key
        ).set(ratio)
        if total > 0 and ratio < _COVERAGE_WARN_RATIO:
            logger.warning(
                "leader: watermark coverage low for %s: %.0f/%.0f processed "
                "in last %d days (ratio=%.3f) — batch selection may be "
                "starving candidates",
                job.name,
                recent,
                total,
                window_days,
                ratio,
            )
    return out


def record_watermark_batch(
    job: str,
    *,
    batch_size: int,
    candidate_total: int | None = None,
) -> None:
    """Record the most recent batch size for a watermarked job.

    Cheap in-process signal for the last tick; :func:`refresh_watermark_coverage`
    is the durable cross-window check against the watermark tables.
    """
    stats = _last_watermark_coverage.setdefault(job, {})
    stats["last_batch_size"] = float(batch_size)
    if candidate_total is not None:
        stats["last_candidate_total"] = float(candidate_total)


def reset_leader_failure_counts() -> None:
    """Test-only: clear the failure counters."""
    _acquire_failures.clear()
    _work_failures.clear()
    _tick_counts.clear()
    _pg_fallback_held.clear()
    reset_watermark_coverage()


async def run_if_leader(
    lock_name: str,
    work: Callable[[], Awaitable[None]],
    *,
    interval: float = 30.0,
    ttl: int | None = None,
    stop: asyncio.Event | None = None,
    align: bool = False,
) -> None:
    """Run ``work`` on each interval while holding the leader lock.

  Followers wait ``interval`` seconds between acquisition attempts.
  The lock TTL is fixed (``_DEFAULT_LOCK_TTL_SECONDS``) and decoupled
  from ``interval`` — it is renewed every ``_DEFAULT_LOCK_RENEW_SECONDS``
  while ``work()`` runs, so a slow tick does not lose leadership
  mid-run *and* a hard-crashed leader's failover window stays bounded
  to roughly one renewal period instead of scaling with ``interval``.

  Redis / acquire failures are logged and retried on the next
  interval — they must not kill the calling supervised loop.

  The moment the lock is confirmed lost (extend fails or returns
  False) the in-flight ``work()`` call is cancelled immediately —
  not just the renewal — so a second replica that legitimately
  re-acquires the now-expired lock cannot run concurrently with a
  still-running (but no-longer-leader) first replica.
    """
    lock_ttl = ttl or _DEFAULT_LOCK_TTL_SECONDS
    stop_event = stop or asyncio.Event()

    while not stop_event.is_set():
        _tick_counts.setdefault(lock_name, [0, 0])[0] += 1
        lock = Lock(lock_name, ttl=lock_ttl, prefix="eden:leader")
        # Bounded, because an unbounded acquire is a single point of
        # permanent silence for the whole background fleet (observed in
        # production 2026-07-29). Postgres is the primary; Redis is the
        # fallback only when Postgres is unreachable.
        identity = f"{socket.gethostname()}:{os.getpid()}"
        acquired, backend = await _acquire_with_fallback(
            lock, lock_name, identity, lock_ttl
        )
        if acquired and backend == "postgres":
            # Postgres is the primary backend. Skip the Redis extender below
            # (we hold no Redis lock). The Postgres lease expires after ttl
            # seconds; for short-lived work calls (< ttl) releasing at the
            # end of each tick is sufficient renewal.
            _acquire_failures.pop(lock_name, None)
            _tick_counts.setdefault(lock_name, [0, 0])[1] += 1
            try:
                await work()
            except Exception as exc:
                _work_failures[lock_name] = (
                    f"{type(exc).__name__}: {str(exc)[:180]}"
                )
                logger.error(
                    "leader: work %s failed (pg primary): %s",
                    lock_name,
                    exc,
                    exc_info=True,
                )
            else:
                _work_failures.pop(lock_name, None)
            finally:
                from eden.storage import pg_lease

                await pg_lease.release(lock_name, identity)
                _pg_fallback_held.pop(lock_name, None)
            timeout = next_grid_delay(interval) if align else interval
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=timeout)
                break
            except TimeoutError:
                continue

        if acquired:
            _acquire_failures.pop(lock_name, None)
        else:
            # Not being leader is normal for a follower replica, but Eden
            # runs a single worker — so a persistent inability to acquire
            # means Redis is refusing, not that someone else is leading.
            # Either way the count is what the liveness heartbeat reports.
            _acquire_failures[lock_name] = _acquire_failures.get(lock_name, 0) + 1

        if acquired:
            extender_stop = asyncio.Event()
            leadership_lost = asyncio.Event()
            extender = asyncio.create_task(
                _extend_lock_periodically(
                    lock,
                    _DEFAULT_LOCK_RENEW_SECONDS,
                    extender_stop,
                    lost=leadership_lost,
                ),
                name=f"leader-extend-{lock_name}",
            )
            _tick_counts.setdefault(lock_name, [0, 0])[1] += 1
            work_task = asyncio.create_task(
                work(), name=f"leader-work-{lock_name}"
            )
            lost_wait_task = asyncio.create_task(
                leadership_lost.wait(), name=f"leader-lost-wait-{lock_name}"
            )
            try:
                done, _pending = await asyncio.wait(
                    {work_task, lost_wait_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if work_task not in done:
                    # Leadership was lost mid-tick — abort the in-flight
                    # work immediately rather than let it keep running
                    # concurrently with whatever replica re-acquires the
                    # now-expired lock (split-brain).
                    logger.warning(
                        "leader: leadership lost mid-tick for %s; "
                        "cancelling in-flight work",
                        lock_name,
                    )
                    work_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await work_task
                else:
                    try:
                        exc = work_task.exception()
                    except asyncio.CancelledError:
                        exc = None
                    if exc is not None:
                        _work_failures[lock_name] = (
                            f"{type(exc).__name__}: {str(exc)[:180]}"
                        )
                        logger.error(
                            "leader: work %s failed: %s",
                            lock_name,
                            exc,
                            exc_info=exc,
                        )
                    else:
                        _work_failures.pop(lock_name, None)
            except asyncio.CancelledError:
                work_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await work_task
                raise
            finally:
                if not lost_wait_task.done():
                    lost_wait_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await lost_wait_task
                extender_stop.set()
                extender.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await extender
                try:
                    await lock.release()
                except Exception as exc:
                    logger.warning(
                        "leader: release %s failed: %s", lock_name, exc
                    )
        else:
            logger.debug(
                "leader: not leader for %s; sleeping %.0fs",
                lock_name,
                interval,
            )

        try:
            # ``align`` is for loops that hit Postgres unconditionally on
            # every tick. Left to its own phase, such a loop lands wherever
            # the process happened to start and can split the fleet's
            # DB-quiet window in half -- enough to hold Neon above its
            # suspend timeout even though the interval itself clears it.
            timeout = next_grid_delay(interval) if align else interval
            await asyncio.wait_for(stop_event.wait(), timeout=timeout)
        except TimeoutError:
            continue
