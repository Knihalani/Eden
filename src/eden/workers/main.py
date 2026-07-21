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

NF manifest runs this as ``python -m eden.workers.main`` on the
``eden-worker`` job. ``SKIP_MIGRATIONS=1`` is set — the API
service owns the alembic migration at boot.

Lifecycle
---------
* Receive SIGTERM (NF graceful drain) → set the stop event →
  the loops drain their in-flight tasks and exit cleanly.
* On any unhandled exception inside a loop the loop logs at ERROR
  and restarts with a 5s backoff — a transient Postgres blip
  doesn't kill the worker.

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

logger = logging.getLogger("eden.workers.main")

# Backoff before restarting a crashed supervised loop (matches
# the module docstring promise).
_RESTART_BACKOFF_SECONDS = 5.0


async def _supervise(
    name: str,
    factory: Callable[[asyncio.Event], Awaitable[None]],
    stop: asyncio.Event,
    *,
    backoff: float = _RESTART_BACKOFF_SECONDS,
) -> None:
    """Run ``factory(stop)`` until stop is set; restart on crash.

    Without supervision a single unhandled exception in
    ``run_if_leader`` (or its imports) permanently kills the
    hosted loop while the worker process stays alive — NF sees
    a healthy container with no work happening.
    """
    while not stop.is_set():
        try:
            await factory(stop)
            # Normal exit (stop set or factory returned) — do not restart.
            return
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if stop.is_set():
                return
            logger.error(
                "worker: %s crashed: %s; restarting in %.0fs",
                name,
                exc,
                backoff,
                exc_info=True,
            )
            try:
                await asyncio.wait_for(stop.wait(), timeout=backoff)
            except TimeoutError:
                continue


async def _start_sidecar_workers() -> None:
    """Start quality (+ optional evolution) owned by this process.

    The API sets ``EDEN_RUN_BACKGROUND_WORKERS=0`` so these never start
    in-process there. ``eden-worker`` is the dedicated host; without this
    call ``/health`` on the API correctly reports the flags false and the
    quality pipeline never runs in production.
    """
    try:
        from eden.observability.quality_pipeline.worker import start_worker

        await start_worker()
        logger.info("worker: quality_pipeline started")
    except Exception as exc:
        logger.warning("worker: quality_pipeline skipped: %s", exc)

    try:
        from eden.agents.evolution.loop import start_evolution_loop

        await start_evolution_loop()
        logger.info("worker: evolution_loop start attempted")
    except Exception as exc:
        logger.warning("worker: evolution_loop skipped: %s", exc)


async def _stop_sidecar_workers() -> None:
    """Drain quality + evolution sidecars started by this process."""
    try:
        from eden.agents.evolution.loop import stop_evolution_loop

        await stop_evolution_loop()
    except Exception as exc:
        logger.warning("worker: evolution_loop stop failed: %s", exc)

    try:
        from eden.observability.quality_pipeline.worker import stop_worker

        await stop_worker()
    except Exception as exc:
        logger.warning("worker: quality_pipeline stop failed: %s", exc)


async def _run_forever() -> None:
    """Instantiate every hosted loop and wait for SIGTERM.

    Long-running tasks share the worker's event loop:

    1. Insights detector — leader-gated poll of ``judge_scores``.
    2. Webhook drain — leader-gated 30s delivery cadence.
    3. Quality pipeline sidecar + optional evolution loop (process-local).
    """
    loops: list[tuple[str, asyncio.Task]] = []
    stop = asyncio.Event()

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

    # 3. Quality + evolution — hosted here because the API disables
    # in-process background workers (see northflank.yml eden-api).
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
        interval=60.0,
        stop=stop,
    )


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

    await run_if_leader("webhook_drain", _tick, interval=30.0, stop=stop)


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
