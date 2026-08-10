"""Closed-loop bus liveness probe (M2, D4) — outbox primary (N5).

    GET /internal/loop-health

Answers "is the autonomy loop actually alive?" — the F46 bus fails soft
everywhere (publish is a Postgres insert, the consumer re-drains), so
without this probe a dead queue looks identical to a quiet system.

Status semantics (N5 — the ``loop_events_outbox`` table *is* the queue,
Redis is out of the data path):

* ``dead`` — ``publish`` has failed recently (Postgres unreachable →
  events are being dropped, not even queued).
* ``degraded`` — the outbox has undrained rows (replay / consumer
  behind) or a publish failure is recent but aged out of ``dead``.
* ``ok`` — outbox empty, no recent publish failures.

``consumer_lag`` is the undrained outbox depth; ``last_event_age_s`` is
the age of the oldest undrained row (how long the queue has been
building). Auth mirrors the Prometheus ``/metrics`` endpoint: constant
time bearer check against ``metrics_bearer_token`` (the existing pattern
for non-org-scoped ops endpoints; ``/v1/internal/health/*`` relies on
the IP-allowlist middleware instead, which does not cover this path).
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, Depends

from eden.observability.metrics_endpoint import _check_metrics_auth

logger = logging.getLogger(__name__)

router = APIRouter(tags=["internal"])

#: A publish failure younger than this marks the bus ``dead``.
_RECENT_FAILURE_WINDOW_S = 300.0


async def probe_loop_health() -> dict[str, Any]:
    """Build the loop-health snapshot. Never raises."""
    from eden.closed_loop import event_bus

    now = time.time()
    outbox_depth = await event_bus.outbox_depth()
    failure_ts = event_bus.last_publish_failure_ts
    last_publish_failure_age_s = (
        max(0.0, now - failure_ts) if failure_ts else None
    )
    pending_age = await event_bus.oldest_pending_age_s()

    bus = "ok"
    if (
        last_publish_failure_age_s is not None
        and last_publish_failure_age_s < _RECENT_FAILURE_WINDOW_S
    ):
        bus = "dead"
    elif outbox_depth > 0 or last_publish_failure_age_s is not None:
        bus = "degraded"

    return {
        "bus": bus,
        "last_event_age_s": pending_age,
        "consumer_lag": outbox_depth,
        "outbox_depth": outbox_depth,
        "last_publish_failure_age_s": last_publish_failure_age_s,
    }


@router.get(
    "/internal/loop-health", dependencies=[Depends(_check_metrics_auth)]
)
async def loop_health() -> dict[str, Any]:
    return await probe_loop_health()
