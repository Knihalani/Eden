"""Shared crash-restart supervisor for leader-gated background loops.

``eden.workers.main`` (the dedicated ``eden-worker`` process) and
``eden.workers.background`` (the in-process API bundle, gated by
``EDEN_RUN_BACKGROUND_WORKERS``) both host leader-elected singleton
loops. Only ``workers.main`` used to wrap its loops in a
crash-restart-with-backoff supervisor; ``workers.background``'s
leader-supervisor task had no such wrapper, so an unhandled exception
there permanently killed every background loop for the process's
lifetime with no self-healing. This module gives both a single place
to get that behaviour from.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

logger = logging.getLogger(__name__)

# Backoff before restarting a crashed supervised loop.
DEFAULT_RESTART_BACKOFF_SECONDS = 5.0


async def supervise(
    name: str,
    factory: Callable[[asyncio.Event], Awaitable[None]],
    stop: asyncio.Event,
    *,
    backoff: float = DEFAULT_RESTART_BACKOFF_SECONDS,
    logger_: logging.Logger | None = None,
) -> None:
    """Run ``factory(stop)`` until stop is set; restart on crash.

    Without supervision a single unhandled exception escaping
    ``factory``'s own control flow (not routine tick failures — those
    are already caught + logged by whatever leader-gating the factory
    uses, e.g. ``eden.workers.leader.run_if_leader``) permanently kills
    the hosted loop's task while the process stays alive — infra sees
    a healthy container with no work happening.
    """
    log = logger_ or logger
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
            log.error(
                "supervisor: %s crashed: %s; restarting in %.0fs",
                name,
                exc,
                backoff,
                exc_info=True,
            )
            try:
                await asyncio.wait_for(stop.wait(), timeout=backoff)
            except TimeoutError:
                continue
