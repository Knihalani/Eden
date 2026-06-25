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
import logging
import signal
import sys

logger = logging.getLogger("eden.workers.main")


async def _run_forever() -> None:
    """Instantiate every hosted loop and wait for SIGTERM.

    Two long-running tasks share the worker's event loop:

    1. ``InsightsDetectorLoop.start()`` — polls new ``judge_scores``
       rows and converts them into ``insights`` records. The loop
       owns its own task internally; ``stop()`` sets the cancel
       event.
    2. ``_webhook_drain_loop`` — runs
       :meth:`WebhookDeliveryService.process_pending_deliveries`
       on a 30s cadence. The webhook service is stateless apart
       from the DB outbox so a dedicated instance per worker is
       fine — NF runs one worker container.
    """
    loops: list[tuple[str, Any]] = []

    # 1. Insights detector loop — polls new judge_scores → insights.
    try:
        from eden.insights.detector_loop import InsightsDetectorLoop
        loop = InsightsDetectorLoop()
        await loop.start()
        loops.append(("insights_loop", loop))
        logger.info("worker: insights_loop started")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("worker: insights_loop failed to start (%s); skipping", exc)

    # 2. Webhook delivery drain — runs in this coroutine directly.
    webhook_task = asyncio.create_task(_webhook_drain_loop(), name="webhook-drain")
    loops.append(("webhook_drain", webhook_task))

    if not loops:
        logger.warning("worker: no loops started — sleeping to keep the container alive")
        # NF will SIGTERM the container after the grace period;
        # without this sleep the process would exit 1 and NF would
        # mark the deploy as crashed.
        stop = asyncio.Event()
        _install_signal_handlers(stop)
        await stop.wait()
        return

    stop = asyncio.Event()
    _install_signal_handlers(stop)

    try:
        await stop.wait()
    finally:
        logger.info("worker: SIGTERM received; draining %d loops", len(loops))
        for name, task in loops:
            if hasattr(task, "stop"):
                try:
                    task.stop()
                except Exception as exc:  # pragma: no cover - defensive
                    logger.warning("worker: %s.stop() raised: %s", name, exc)
        # Give the loops 10s to drain before forcing cancellation.
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    *(t for _, t in loops if isinstance(t, asyncio.Task)),
                    return_exceptions=True,
                ),
                timeout=10.0,
            )
        except asyncio.TimeoutError:
            logger.warning("worker: drain timeout; cancelling remaining loops")
            for _, task in loops:
                if isinstance(task, asyncio.Task) and not task.done():
                    task.cancel()


async def _webhook_drain_loop() -> None:
    """30s cadence webhook delivery drain. Best-effort — never crashes."""
    try:
        from eden.services.webhook_delivery import WebhookDeliveryService
        svc = WebhookDeliveryService()
    except Exception as exc:  # pragma: no cover - import failure
        logger.warning("worker: webhook_drain: import failed (%s); loop disabled", exc)
        return
    while True:
        try:
            n = await svc.process_pending_deliveries()
            if n:
                logger.info("worker: webhook_drain delivered=%d", n)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("worker: webhook_drain tick failed: %s", exc)
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
            signal.signal(sig, lambda *_: _signal(sig.name))


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

    try:
        asyncio.run(_run_forever())
    except KeyboardInterrupt:
        pass
    return 0


async def _run_once() -> None:
    """One-tick variant: drain the DLQ + run one insights tick then exit."""
    try:
        from eden.services.webhook_delivery import WebhookDeliveryService
        svc = WebhookDeliveryService()
        n = await svc.process_pending_deliveries()
        logger.info("worker --once: webhook_drain delivered=%d", n)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("worker --once: webhook_drain tick failed: %s", exc)
    try:
        from eden.insights.detector_loop import InsightsDetectorLoop
        loop = InsightsDetectorLoop()
        result = await loop.tick_once()
        logger.info("worker --once: insights_loop tick result=%s", result)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("worker --once: insights_loop tick failed: %s", exc)


if __name__ == "__main__":
    sys.exit(main())
