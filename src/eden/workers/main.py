"""Background worker entrypoint (NF ``eden-worker`` service).

Long-running service that hosts the in-process background tasks
that need a dedicated event loop (the API service runs uvicorn in
the main loop; the worker runs these in a separate process so a
crash here doesn't take the API down).

Currently hosted loops:

    * :class:`eden.services.webhook_delivery.WebhookDeliveryService`
      — async webhook retry + DLQ drain
    * :class:`eden.insights.detector_loop.InsightsDetectorLoop`
      — per-tenant poll of new ``judge_scores`` rows → ``insights``
    * :func:`eden.observability.quality_pipeline.worker.start_worker`
      — async trace-quality sidecar (API keeps workers off)
    * :func:`eden.agents.evolution.loop.start_evolution_loop`
      — opt-in evolution loop when ``evolution_loop_enabled``
    * anomaly detector loop, closed-loop consumer + verify,
      trace_finalized consumer, promotion hooks
    * EQL alert-as-code watchdog (leader-gated) — replaces
      the former ``eden-cron`` ``eql_alert_watchdog`` tick
    * Artifact / nudge demotion (leader-gated) — 7d regression
      flywheel; no longer depends on eden-cron
    * Multi-tenant maintenance scheduler (leader-gated) —
      compaction, retention, Typesense TTL, curator, drift,
      MCP rollup, classifier retrain, shadow join, signals
    * Self-observability probe scan (leader-gated) — periodic
      :func:`eden.self_obs.heartbeats.probe_and_record_workers` /
      :func:`eden.self_obs.synthetics.run_golden_probes` sweep across
      every org, with an email on a new degraded/fail transition
      (see :mod:`eden.self_obs.scheduler`) — previously only ran
      on-demand from an admin route / MCP tool with no paging at all

NF manifest runs this as ``python -m eden.workers.main`` on the
``eden-worker`` job. ``SKIP_MIGRATIONS=1`` is set — the API
service owns the alembic migration at boot.

Issue → draft plan → approve → PR does **not** need cron.
Scheduled improvement sweeps stay off this process on purpose.

Lifecycle
---------
* Receive SIGTERM (NF graceful drain) → set the stop event →
  the loops drain their in-flight tasks and exit cleanly.
* Each hosted loop's tick body runs inside ``run_if_leader``
  (:mod:`eden.workers.leader`), which already catches + logs every
  ``Exception`` a tick raises and retries on the next interval — a
  transient Postgres blip inside a tick never reaches this module at
  all. ``_supervise``'s 5s-backoff crash-restart guards one layer
  further out: bugs in the leader-lock machinery itself (e.g.
  ``Lock()`` construction failing, or some other exception escaping
  ``run_if_leader``'s own control flow) that would otherwise
  permanently kill the hosted loop's task while the worker process
  stays alive and infra reports a healthy container doing no work.

CLI
---

::

    python -m eden.workers.main                    # foreground
    python -m eden.workers.main --once             # run a single tick + exit (for tests)
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import signal
import sys
from collections.abc import Awaitable, Callable

from eden.workers.supervisor import supervise as _shared_supervise

logger = logging.getLogger("eden.workers.main")

# Backoff before restarting a crashed supervised loop (matches
# the module docstring promise).
_RESTART_BACKOFF_SECONDS = 5.0

# Populated by ``_run_forever`` (this process, the dedicated
# ``eden-worker`` service) with the supervised ``asyncio.Task`` for
# each hosted loop as it's created, and cleared once ``_run_forever``
# fully drains on shutdown. Empty in any other process (e.g. the API,
# which never calls ``_run_forever``) — see ``worker_loops_running``.
_loop_tasks: dict[str, asyncio.Task[None]] = {}


def worker_loops_running() -> bool | None:
    """Liveness of *this process's* hosted supervised loop tasks.

    Returns ``None`` when this process never hosted any of the loops
    below (e.g. it's the API process, not the dedicated ``eden-worker``
    service that actually runs ``eden.self_obs.scheduler``'s scheduled
    probe tick) — callers should fall back to a different signal in
    that case rather than read this as "not running".

    Returns ``True``/``False`` reflecting whether every task this
    process actually started is still alive. Each hosted loop is
    wrapped in :func:`eden.workers.supervisor.supervise`, which
    restarts a crashed tick with backoff forever, so a task only
    completes/dies on a graceful stop request or a truly unhandled
    failure escaping the supervisor itself — this is the same
    "task exists and isn't done()" signal
    :func:`eden.workers.background.background_workers_running` uses
    for the API-hosted bundle, just scoped to the tasks this process
    (not the API) actually created.

    This intentionally does not require *leadership* of any given
    loop's Redis lock: each hosted loop elects its own leader
    independently (:func:`eden.workers.leader.run_if_leader`), so a
    given worker replica may be leader for some loops and a follower
    for others at any moment — checking "this replica currently holds
    every lock" would itself produce false degraded reports on
    perfectly healthy follower replicas. Task liveness has no such
    per-replica false negative: every replica creates every task
    regardless of which locks it wins.
    """
    if not _loop_tasks:
        return None
    return all(not task.done() for task in _loop_tasks.values())


def _leader_tick_seconds(floor: float = 30.0) -> float:
    """Redis-conserving leader lock cadence (Upstash Free)."""
    try:
        from eden.config import get_settings

        configured = float(
            getattr(get_settings(), "redis_leader_tick_seconds", 120) or 120
        )
    except Exception:
        configured = 120.0
    return max(float(floor), configured)


async def _supervise(
    name: str,
    factory: Callable[[asyncio.Event], Awaitable[None]],
    stop: asyncio.Event,
    *,
    backoff: float = _RESTART_BACKOFF_SECONDS,
) -> None:
    """Run ``factory(stop)`` until stop is set; restart on crash.

    Thin wrapper over the shared :func:`eden.workers.supervisor.supervise`
    (also used by ``eden.workers.background``) so both processes get the
    same restart-with-backoff behaviour from one place. See that
    module's docstring for exactly what this guards against — routine
    tick failures inside ``run_if_leader`` never reach here; they are
    already caught + logged one layer in.
    """
    await _shared_supervise(name, factory, stop, backoff=backoff, logger_=logger)


async def _start_sidecar_workers() -> None:
    """Start quality (+ optional evolution) and closed-loop sidecars.

    The API sets ``EDEN_RUN_BACKGROUND_WORKERS=0`` so these never start
    in-process there. ``eden-worker`` is the dedicated host; without this
    call quality / closed-loop / anomaly never run in production.
    """
    try:
        from eden.agents.evolution.loop import start_evolution_loop

        await start_evolution_loop()
        logger.info("worker: evolution_loop start attempted")
    except Exception as exc:
        logger.warning("worker: evolution_loop skipped: %s", exc)

    # Anomaly detector + closed-loop used to live only in
    # ``workers.background`` (API in-process). With background workers
    # disabled on eden-api, they must run here or they never start.
    try:
        from eden.config import get_settings

        settings = get_settings()
    except Exception as exc:
        logger.warning("worker: settings load failed: %s", exc)
        settings = None

    if settings is None or getattr(settings, "anomaly_loop_enabled", True):
        try:
            from eden.data_platform.anomaly_detector_loop import (
                start_anomaly_detector_loop,
            )

            await start_anomaly_detector_loop()
            logger.info("worker: anomaly_loop started")
        except Exception as exc:
            logger.warning("worker: anomaly_loop skipped: %s", exc)

    # quality_pipeline / trace_finalized / closed_loop (consumer +
    # verify) are duplicated between here and eden.workers.background;
    # the shared helper below is guarded by a cross-process lock so at
    # most one process hosts them regardless of env var state.
    try:
        from eden.workers.sidecars import start_quality_and_closed_loop_sidecars

        await start_quality_and_closed_loop_sidecars("worker")
    except Exception as exc:
        logger.warning("worker: quality/closed-loop sidecar bundle skipped: %s", exc)

    try:
        from eden.llmops.promotion_hooks import register_all_hooks

        register_all_hooks()
        logger.info("worker: promotion hooks registered")
    except Exception as exc:
        logger.warning("worker: promotion hooks skipped: %s", exc)


async def _stop_sidecar_workers() -> None:
    """Drain sidecars started by this process."""
    try:
        from eden.data_platform.anomaly_detector_loop import (
            stop_anomaly_detector_loop,
        )

        await stop_anomaly_detector_loop()
    except Exception as exc:
        logger.warning("worker: anomaly_loop stop failed: %s", exc)

    try:
        from eden.agents.evolution.loop import stop_evolution_loop

        await stop_evolution_loop()
    except Exception as exc:
        logger.warning("worker: evolution_loop stop failed: %s", exc)

    try:
        from eden.workers.sidecars import stop_quality_and_closed_loop_sidecars

        await stop_quality_and_closed_loop_sidecars("worker")
    except Exception as exc:
        logger.warning("worker: quality/closed-loop sidecar bundle stop failed: %s", exc)


async def _run_forever() -> None:
    """Instantiate every hosted loop and wait for SIGTERM.

    Long-running tasks share the worker's event loop:

    1. Insights detector — leader-gated poll of ``judge_scores``.
    2. Webhook drain — leader-gated 30s delivery cadence.
    3. EQL alert-as-code watchdog — leader-gated ~5 min (was cron).
    4. Artifact/nudge demotion — leader-gated hourly (was cron).
    5. Maintenance scheduler — leader-gated ~5 min (was cron).
    6. Self-observability probe scan — leader-gated ~5 min; pages on a
       new degraded/fail transition (was never scheduled at all).
    7. Quality / closed-loop / anomaly sidecars (process-local).
    """
    loops: list[tuple[str, asyncio.Task]] = []
    stop = asyncio.Event()

    # Bind this loop for cross-thread cost-ledger writes. The LLM client
    # runs its synchronous call in a worker thread and books usage from
    # inside it, where there is no loop to schedule the write onto — so
    # without this every routed call's spend is dropped. Mirrors the
    # binding in the API lifespan.
    try:
        from eden.llmops.cost_ledger import bind_event_loop

        bind_event_loop()
    except Exception as exc:  # noqa: BLE001
        logger.warning("cost ledger loop binding failed: %s", exc)

    # 1. Insights detector loop — leader-gated singleton.
    insights_task = asyncio.create_task(
        _supervise("insights_loop", _leader_insights_loop, stop),
        name="insights-loop",
    )
    loops.append(("insights_loop", insights_task))

    # 2. Webhook delivery drain — leader-gated singleton loop.
    webhook_task = asyncio.create_task(
        _supervise("webhook_drain", _leader_webhook_drain_loop, stop),
        name="webhook-drain",
    )
    loops.append(("webhook_drain", webhook_task))

    # 3. EQL alert-as-code — was eden-cron every 5m; live on worker now
    # so scheduled NL/EQL rules still fire without a cold-start job.
    eql_task = asyncio.create_task(
        _supervise("eql_alert_watchdog", _leader_eql_alert_watchdog, stop),
        name="eql-alert-watchdog",
    )
    loops.append(("eql_alert_watchdog", eql_task))

    # 4. Nudge/artifact demotion — 7d regression flywheel (was cron-only).
    demotion_task = asyncio.create_task(
        _supervise("artifact_demotion", _leader_artifact_demotion, stop),
        name="artifact-demotion",
    )
    loops.append(("artifact_demotion", demotion_task))

    # 5. Multi-tenant maintenance — compaction/retention/signals/etc.
    # Reuses cron_tick.run_maintenance_due; improvement sweeps stay off.
    maint_task = asyncio.create_task(
        _supervise("maintenance", _leader_maintenance, stop),
        name="maintenance",
    )
    loops.append(("maintenance", maint_task))

    # 6. Self-observability probe scan — leader-gated, pages on new
    # degraded/fail transitions (see eden.self_obs.scheduler).
    self_obs_task = asyncio.create_task(
        _supervise("self_obs_probes", _leader_self_obs_probes, stop),
        name="self-obs-probes",
    )
    loops.append(("self_obs_probes", self_obs_task))

    # Expose these tasks to ``worker_loops_running()`` — the liveness
    # signal ``eden.self_obs.heartbeats.probe_and_record_workers`` reads
    # when it runs in *this* process (see that module for why the old
    # API-only ``background_workers_running()`` flag was wrong here).
    _loop_tasks.update(dict(loops))

    # 0. Process liveness — deliberately NOT leader-gated.
    #
    # Every loop above elects through a Redis lock, and Lock.acquire()
    # fails closed on any Redis error: it logs a warning and returns
    # False. So when Redis is unreachable — or an Upstash daily command
    # quota is exhausted — all six loops spin quietly forever while the
    # container reports RUNNING and nothing anywhere records a problem.
    # The self-obs heartbeat could not surface it either, because that
    # heartbeat is itself written by a leader-gated loop.
    #
    # In July 2026 that combination hid a 7.4-day total outage of every
    # background loop. This tick writes one row per interval straight to
    # Postgres with no lock involved, so "worker process is gone" and
    # "worker is alive but cannot get leadership" are finally distinct.
    # One row per 10 minutes is negligible next to what it makes visible.
    liveness_task = asyncio.create_task(
        _supervise("worker_liveness", _worker_liveness_loop, stop),
        name="worker-liveness",
    )
    loops.append(("worker_liveness", liveness_task))
    _loop_tasks["worker_liveness"] = liveness_task

    # 7. Quality + closed-loop + anomaly — API disables in-process workers.
    await _start_sidecar_workers()

    if not loops:
        logger.warning("worker: no loops started — sleeping to keep the container alive")
        # NF will SIGTERM the container after the grace period;
        # without this sleep the process would exit 1 and NF would
        # mark the deploy as crashed.
        _install_signal_handlers(stop)
        await stop.wait()
        await _stop_sidecar_workers()
        return

    _install_signal_handlers(stop)

    try:
        await stop.wait()
    finally:
        logger.info("worker: SIGTERM received; draining %d loops", len(loops))
        # Give the loops 10s to drain before forcing cancellation.
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    *(t for _, t in loops),
                    return_exceptions=True,
                ),
                timeout=10.0,
            )
        except TimeoutError:
            logger.warning("worker: drain timeout; cancelling remaining loops")
            for _, task in loops:
                if not task.done():
                    task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.gather(
                    *(t for _, t in loops), return_exceptions=True
                )

        await _stop_sidecar_workers()

        # Drain in-flight webhook deliveries + release the HTTP pool.
        try:
            from eden.services.webhook_delivery import (
                get_webhook_delivery_service,
            )

            svc = get_webhook_delivery_service()
            remaining = await svc.drain(timeout=5.0)
            if remaining:
                logger.warning(
                    "worker: webhook drain left %d in-flight", remaining
                )
            await svc.aclose()
        except Exception as exc:
            logger.warning("worker: webhook shutdown failed: %s", exc)

        # Process is shutting down — revert ``worker_loops_running()``
        # to "never hosted here" (``None``) rather than leaving it
        # reporting a stale ``False`` ("hosted then died") after a
        # clean, intentional drain.
        _loop_tasks.clear()


async def _worker_liveness_loop(stop: asyncio.Event) -> None:
    """Write an unconditional ``worker_process`` heartbeat.

    No leader lock, no Redis. This is the one signal that stays true when
    leader election is broken, which is exactly the case the rest of the
    self-observability stack cannot report on.

    ``meta.leader_acquire_failures`` carries the running count of failed
    leader-lock acquisitions, so a reader can tell "worker is alive and
    leading" from "worker is alive but Redis is refusing it" without
    shelling into the container.
    """
    from eden.workers.leader import (
        leader_acquire_failure_count,
        leader_tick_counts,
        leader_work_failures,
    )

    interval = _grid_interval("self_obs_probe_interval_seconds", multiple=600.0)
    logger.info("worker: liveness loop registered (interval=%.0fs)", interval)

    while not stop.is_set():
        try:
            from eden.self_obs.heartbeats import record_heartbeat

            failures = leader_acquire_failure_count()
            # Report each loop's *actual* task state, not just its name.
            # Listing registered names was the first version of this and
            # it was nearly useless: a loop whose task had already died
            # still appeared in the list, so "all seven loops" looked
            # identical whether they were running or long dead.
            states: dict[str, str] = {}
            dead: list[str] = []
            for loop_name, task in sorted(_loop_tasks.items()):
                if not task.done():
                    # "alive" alone cannot distinguish a loop doing its job
                    # from one suspended forever on an await that will never
                    # return — and the second is what a wedged Redis call
                    # looks like from outside. The suspended frame names the
                    # exact line, which is otherwise only visible in logs we
                    # may not be able to reach.
                    where = ""
                    try:
                        # get_stack orders frames oldest → newest, so the
                        # LAST one is where the coroutine is actually
                        # suspended. Taking limit=1 gave the outermost
                        # frame instead and reported every loop as parked
                        # in _supervise — true, and useless.
                        stack = task.get_stack()
                        if stack:
                            frame = stack[-1]
                            where = (
                                f"@{frame.f_code.co_name}"
                                f":{frame.f_lineno}"
                            )
                    except Exception:
                        pass
                    states[loop_name] = f"alive{where}"
                    continue
                if task.cancelled():
                    states[loop_name] = "cancelled"
                else:
                    exc = task.exception()
                    states[loop_name] = (
                        f"dead:{type(exc).__name__}" if exc else "returned"
                    )
                dead.append(loop_name)

            # Can this process reach Redis at all? Every leader-gated loop
            # depends on it, and the worker is the one place we could not
            # answer that from outside — /health only speaks for the API
            # process. One PING per interval, hard-bounded so a wedged
            # Redis cannot take the liveness signal down with it (which is
            # precisely the failure this exists to report).
            redis_state = "unknown"
            try:
                from eden.storage.redis import get_redis_client

                client = await asyncio.wait_for(get_redis_client(), timeout=5.0)
                if client is None:
                    redis_state = "not_configured"
                else:
                    await asyncio.wait_for(client.ping(), timeout=5.0)
                    redis_state = "connected"
            except TimeoutError:
                redis_state = "timeout"
            except Exception as exc:
                redis_state = f"error:{type(exc).__name__}"

            work_failures = leader_work_failures()
            healthy = (
                failures == 0
                and not dead
                and not work_failures
                and redis_state in ("connected", "not_configured")
            )
            await record_heartbeat(
                "worker_process",
                org_id=None,
                status="healthy" if healthy else "degraded",
                meta={
                    "loops": states,
                    "leader_acquire_failures": failures,
                    "work_failures": work_failures,
                    "ticks": leader_tick_counts(),
                    "redis": redis_state,
                },
            )
            if work_failures:
                logger.error(
                    "worker: leader-gated work is failing: %s", work_failures
                )
            if redis_state not in ("connected", "not_configured"):
                logger.error(
                    "worker: Redis unreachable from this process (%s) — every "
                    "leader-gated loop will sit idle without failing.",
                    redis_state,
                )
            if failures:
                logger.error(
                    "worker: alive but leader-lock acquisition has failed %d "
                    "times — every leader-gated loop is idle. Check Redis "
                    "reachability and any provider command quota.",
                    failures,
                )
            if dead:
                logger.error(
                    "worker: loops no longer running: %s",
                    {k: states[k] for k in dead},
                )
        except Exception as exc:
            logger.warning("worker: liveness heartbeat failed: %s", exc)

        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            continue


async def _leader_insights_loop(stop: asyncio.Event) -> None:
    """Leader-gated insights detector loop."""
    from eden.workers.leader import run_if_leader

    async def _tick() -> None:
        try:
            from eden.insights.detector_loop import InsightsDetectorLoop

            loop = InsightsDetectorLoop()
            result = await loop.tick_once()
            if any(result.values()):
                logger.info("worker: insights_loop tick result=%s", result)
        except Exception as exc:
            # Surface at ERROR so ops sees it; run_if_leader also
            # catches, but this keeps the tick failure message
            # attributed to the worker loop name.
            logger.error(
                "worker: insights_loop tick failed: %s",
                exc,
                exc_info=True,
            )
            raise

    await run_if_leader(
        "insights_loop",
        _tick,
        interval=_insights_leader_interval(),
        stop=stop,
        # Shares the fleet idle grid: the tick reaches Postgres whenever
        # its empty cooldown has lapsed, so an unaligned phase would split
        # the DB-quiet window below Neon's suspend timeout.
        align=True,
    )


def _insights_leader_interval() -> float:
    default = _idle_poll_period() * 2.0
    try:
        from eden.config import get_settings

        configured = float(
            getattr(get_settings(), "insights_loop_interval_seconds", default)
            or default
        )
    except Exception:
        configured = default
    # Floor at one full grid period; anything shorter cannot land on the
    # shared boundaries and just multiplies the leader-lock command cost.
    return _leader_tick_seconds(max(_idle_poll_period(), configured))


async def _leader_eql_alert_watchdog(stop: asyncio.Event) -> None:
    """Leader-gated EQL / alert-as-code due-rule firing.

    Migrated off ``eden-cron`` so the product does not need a 5-minute
    cold-start job for scheduled detectors. Improvement sweeps are
    intentionally **not** hosted here — drafts come from identified
    issues via closed-loop / issue_patch_trigger only.
    """
    from eden.workers.leader import run_if_leader

    async def _tick() -> None:
        try:
            from eden.dsl import AlertAsCode

            result = await AlertAsCode().fire_due()
            data = (result or {}).get("data") if isinstance(result, dict) else None
            if isinstance(data, dict) and (
                data.get("n_fired") or data.get("n_errors") or data.get("n_due")
            ):
                logger.info("worker: eql_alert_watchdog result=%s", data)
        except Exception as exc:
            logger.error(
                "worker: eql_alert_watchdog tick failed: %s",
                exc,
                exc_info=True,
            )
            raise

    interval = _grid_interval("eql_watchdog_interval_seconds", multiple=2.0)
    logger.info(
        "worker: eql_alert_watchdog loop registered (interval=%.0fs)", interval
    )
    await run_if_leader(
        "eql_alert_watchdog",
        _tick,
        interval=interval,
        stop=stop,
        align=True,
    )


async def _leader_artifact_demotion(stop: asyncio.Event) -> None:
    """Leader-gated 7d nudge/artifact demotion (was eden-cron only)."""
    from eden.workers.leader import run_if_leader

    async def _tick() -> None:
        try:
            from eden.nudges.demotion_worker import ArtifactDemotionWorker

            result = await ArtifactDemotionWorker().run_once()
            if result.get("scanned") or result.get("demoted"):
                logger.info("worker: artifact_demotion result=%s", result)
        except Exception as exc:
            logger.error(
                "worker: artifact_demotion tick failed: %s",
                exc,
                exc_info=True,
            )
            raise

    interval = _grid_interval(
        "artifact_demotion_interval_seconds", multiple=6.0
    )
    logger.info(
        "worker: artifact_demotion loop registered (interval=%.0fs)", interval
    )
    await run_if_leader(
        "artifact_demotion",
        _tick,
        interval=interval,
        stop=stop,
        # ArtifactDemotionWorker.run_once() queries Postgres on every tick
        # unconditionally — no empty cooldown — so alignment is what keeps
        # it inside the shared quiet window rather than beside it.
        align=True,
    )


async def _leader_maintenance(stop: asyncio.Event) -> None:
    """Leader-gated multi-tenant maintenance (was eden-cron).

    One warm process drains due work for all orgs — no cold-start job
    and no per-user cron. Improvement sweeps stay off.
    """
    from eden.workers.leader import run_if_leader

    async def _tick() -> None:
        try:
            from eden.workers.cron_tick import run_maintenance_due

            result = await run_maintenance_due(dry_run=False)
            # Log only steps that actually ran (skip noise).
            ran = {
                k: v
                for k, v in result.items()
                if k not in ("maintenance_at", "dry_run", "improvement_sweeps")
                and not (
                    isinstance(v, dict)
                    and v.get("skipped")
                )
            }
            errors = [
                k
                for k, v in ran.items()
                if isinstance(v, dict) and v.get("errors")
            ]
            if errors:
                logger.warning("worker: maintenance errors in %s", errors)
            if ran:
                logger.info("worker: maintenance tick keys=%s", sorted(ran.keys()))
            else:
                logger.debug("worker: maintenance tick idle")
        except Exception as exc:
            logger.error(
                "worker: maintenance tick failed: %s",
                exc,
                exc_info=True,
            )
            raise

    logger.info(
        "worker: maintenance loop registered (interval=%.0fs)", _idle_poll_period()
    )
    await run_if_leader(
        "maintenance",
        _tick,
        # Was a hard-coded 300s -- exactly Neon's suspend timeout, so the
        # window could never actually elapse. Share the fleet idle period.
        interval=_idle_poll_period(),
        stop=stop,
        align=True,
    )


def _idle_poll_period() -> float:
    """Fleet-wide idle cadence; see ``eden.storage.empty_cooldown``."""
    try:
        from eden.config import get_settings

        return float(
            getattr(get_settings(), "idle_poll_period_seconds", 600.0) or 600.0
        )
    except Exception:
        return 600.0


def _grid_interval(settings_attr: str, *, multiple: float) -> float:
    """A leader-loop interval snapped to a multiple of the idle grid.

    Every loop that shares ``eden.storage.empty_cooldown``'s wall-clock
    grid has to use a period that is an exact multiple of it — otherwise
    it drifts across the boundaries and carves its own hole in the
    DB-quiet window, which is what defeats Neon's autosuspend even when
    each individual interval looks long enough.

    ``multiple`` is the intended number of grid periods; a configured
    override is rounded to the nearest whole multiple (minimum one)
    rather than used verbatim, so a well-meaning ops tweak to, say, 900s
    cannot silently take the loop back off-grid.
    """
    period = _idle_poll_period()
    default = period * max(1.0, float(multiple))
    try:
        from eden.config import get_settings

        configured = float(
            getattr(get_settings(), settings_attr, default) or default
        )
    except Exception:
        configured = default
    return period * max(1.0, round(configured / period))


async def _leader_self_obs_probes(stop: asyncio.Event) -> None:
    """Leader-gated periodic self-observability probe scan.

    ``probe_and_record_workers`` / ``run_golden_probes`` used to only
    run on-demand (admin dashboard route, MCP tool call), and even
    then a degraded/fail status only landed in a Postgres table + a
    JSON response with no page anywhere. This tick runs both probe
    sets for every org and emails org admins on a *new* degraded/fail
    transition (never on every tick while already degraded) — see
    ``eden.self_obs.scheduler.run_scheduled_probes``.
    """
    from eden.workers.leader import run_if_leader

    async def _tick() -> None:
        try:
            from eden.self_obs.scheduler import run_scheduled_probes

            result = await run_scheduled_probes()
            if result.get("degraded_orgs"):
                logger.warning(
                    "worker: self_obs_probes degraded orgs=%s",
                    result["degraded_orgs"],
                )
            else:
                logger.debug(
                    "worker: self_obs_probes tick clean (orgs=%d)",
                    result.get("orgs_scanned", 0),
                )
        except Exception as exc:
            logger.error(
                "worker: self_obs_probes tick failed: %s",
                exc,
                exc_info=True,
            )
            raise

    logger.info("worker: self_obs_probes loop registered (interval=%.0fs)", _self_obs_interval())
    await run_if_leader(
        "self_obs_probes",
        _tick,
        interval=_self_obs_interval(),
        stop=stop,
        # Probes read organizations and write heartbeats on every tick with
        # no empty-poll cooldown to hide behind, so this loop must share the
        # fleet's idle grid or it splits the DB-quiet window.
        align=True,
    )


def _self_obs_interval() -> float:
    try:
        from eden.config import get_settings

        return float(
            getattr(get_settings(), "self_obs_probe_interval_seconds", 600.0) or 600.0
        )
    except Exception:
        return 600.0


async def _leader_webhook_drain_loop(stop: asyncio.Event) -> None:
    """Leader-gated 30s cadence webhook delivery drain."""
    from eden.workers.leader import run_if_leader

    async def _tick() -> None:
        try:
            from eden.services.webhook_delivery import (
                get_webhook_delivery_service,
            )

            svc = get_webhook_delivery_service()
            n = await svc.process_pending_deliveries()
            if n:
                logger.info("worker: webhook_drain delivered=%d", n)
        except Exception as exc:
            logger.error(
                "worker: webhook_drain tick failed: %s",
                exc,
                exc_info=True,
            )
            raise

    # Webhook drain is the only one of these loops with a real latency
    # requirement, and it is the reason this interval is a single grid
    # period rather than the 2x used elsewhere. It does not rely on the
    # tick for responsiveness: enqueue paths publish a Redis signal that
    # short-circuits the empty cooldown on the draining process (see
    # eden.services.webhook_delivery), so a newly queued delivery is
    # picked up without waiting for the next boundary. The tick is only
    # the backstop for a missed signal.
    interval = _grid_interval("webhook_drain_interval_seconds", multiple=1.0)
    await run_if_leader(
        "webhook_drain", _tick, interval=interval, stop=stop, align=True
    )


async def _webhook_drain_loop() -> None:
    """30s cadence webhook delivery drain. Best-effort — never crashes.

    Legacy non-leader path retained for tests that pin the symbol;
    production uses :func:`_leader_webhook_drain_loop`.
    """
    try:
        from eden.services.webhook_delivery import (
            get_webhook_delivery_service,
        )

        svc = get_webhook_delivery_service()
    except Exception as exc:  # pragma: no cover - import failure
        logger.error(
            "worker: webhook_drain: import failed (%s); loop disabled",
            exc,
            exc_info=True,
        )
        return
    while True:
        try:
            n = await svc.process_pending_deliveries()
            if n:
                logger.info("worker: webhook_drain delivered=%d", n)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(
                "worker: webhook_drain tick failed: %s",
                exc,
                exc_info=True,
            )
        await asyncio.sleep(30)


def _install_signal_handlers(stop: asyncio.Event) -> None:
    """Wire SIGTERM + SIGINT to set the stop event for graceful drain."""
    loop = asyncio.get_event_loop()

    def _signal(name: str) -> None:
        logger.info("worker: %s received", name)
        loop.call_soon_threadsafe(stop.set)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _signal, sig.name)
        except NotImplementedError:  # pragma: no cover - Windows
            # Capture ``sig.name`` in default args so each lambda
            # closure binds the current signal name (B023).
            signal.signal(sig, lambda *_, name=sig.name: _signal(name))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--once",
        action="store_true",
        default=False,
        help="Run a single drain + exit (for tests + local dev).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.once:
        # Local-dev / test path: run the loops for one tick then exit.
        asyncio.run(_run_once())
        return 0

    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(_run_forever())
    return 0


async def _run_once() -> None:
    """One-tick variant: drain the DLQ + run one insights tick then exit."""
    try:
        from eden.services.webhook_delivery import (
            get_webhook_delivery_service,
        )

        svc = get_webhook_delivery_service()
        n = await svc.process_pending_deliveries()
        logger.info("worker --once: webhook_drain delivered=%d", n)
    except Exception as exc:
        logger.error(
            "worker --once: webhook_drain tick failed: %s",
            exc,
            exc_info=True,
        )
    try:
        from eden.insights.detector_loop import InsightsDetectorLoop

        loop = InsightsDetectorLoop()
        result = await loop.tick_once()
        logger.info("worker --once: insights_loop tick result=%s", result)
    except Exception as exc:
        logger.error(
            "worker --once: insights_loop tick failed: %s",
            exc,
            exc_info=True,
        )


if __name__ == "__main__":
    sys.exit(main())
