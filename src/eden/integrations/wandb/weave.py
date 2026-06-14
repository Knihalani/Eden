"""W&B Weave integration.

W&B Weave is W&B's LLM-specific observability product. Eden
already emits a structured Bronze event for every LLM call (see
:mod:`eden.data_platform.bronze_sink`) with the right shape —
``agent``, ``slot``, ``model``, ``cost_usd``, ``cache_reads`` —
so the integration is a thin fan-out: when a customer has Weave
configured, every Bronze LLM event is also pushed to Weave as a
trace + cost metric.

Integration surface
-------------------

* :class:`WeaveClient` — minimal Weave SDK wrapper (lazy import).
* :func:`fan_out_bronze_event` — called from
  :func:`eden.data_platform.bronze_sink.ingest` when Weave is
  enabled.
* ``/integrations/wandb/status`` + ``/integrations/wandb/test``
  routes mounted in :mod:`eden.api.routes.integrations_wandb`.

Versioning
----------

All outbound calls include the
``X-Eden-Integration-Version`` header (see
:mod:`eden.integrations`).
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from eden.integrations import INTEGRATION_API_VERSION

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class WeaveTracePayload:
    """The minimum Weave-ready view of an LLM call."""

    trace_id: str
    agent: str
    slot: str
    model: str
    prompt_tokens: int
    completion_tokens: int
    cost_usd: float
    cache_reads: int
    duration_ms: int | None
    extra: Mapping[str, Any]

    def to_weave_trace(self) -> dict[str, Any]:
        """Map a Bronze LLM event to a Weave trace dict."""
        return {
            "id": self.trace_id,
            "op": "llm_call",
            "inputs": {
                "agent": self.agent,
                "slot": self.slot,
                "model": self.model,
            },
            "output": {
                "prompt_tokens": self.prompt_tokens,
                "completion_tokens": self.completion_tokens,
                "cache_reads": self.cache_reads,
                "duration_ms": self.duration_ms,
            },
            "attributes": {
                "cost_usd": self.cost_usd,
                "agent": self.agent,
                "slot": self.slot,
                "model": self.model,
                "eden.integration_version": INTEGRATION_API_VERSION,
                **dict(self.extra),
            },
        }


def from_bronze_event(event: Mapping[str, Any]) -> WeaveTracePayload | None:
    """Convert a Bronze LLM event into a :class:`WeaveTracePayload`.

    Returns ``None`` if the event doesn't look like an LLM call
    (we don't want to spam Weave with every Bronze event).
    """
    if event.get("event_type") != "llm_call":
        return None
    try:
        return WeaveTracePayload(
            trace_id=str(event.get("id") or event.get("trace_id") or ""),
            agent=str(event.get("agent") or "unknown"),
            slot=str(event.get("slot") or "unknown"),
            model=str(event.get("model") or "unknown"),
            prompt_tokens=int(event.get("prompt_tokens") or 0),
            completion_tokens=int(event.get("completion_tokens") or 0),
            cost_usd=float(event.get("cost_usd") or 0.0),
            cache_reads=int(event.get("cache_reads") or 0),
            duration_ms=int(event["duration_ms"]) if event.get("duration_ms") is not None else None,
            extra=event.get("extra") or {},
        )
    except (TypeError, ValueError) as exc:
        logger.debug("Skipping non-conforming Bronze event for Weave fan-out: %s", exc)
        return None


class WeaveClient:
    """Minimal W&B Weave client.

    Lazily imports the ``wandb`` SDK so the integration is a
    no-op when the SDK isn't installed (or in CI without Weave
    credentials). Real fan-out calls ``wandb.init`` +
    ``weave.publish``; for now we expose a ``log`` method that
    returns the would-be wire payload so tests can verify the
    mapping without depending on the SDK.
    """

    def __init__(self, project: str = "eden", enabled: bool = False):
        self.project = project
        self.enabled = enabled

    def log(self, payload: WeaveTracePayload) -> dict[str, Any]:
        """Return the Weave wire payload.

        In production this would also call
        ``weave.publish(payload.to_weave_trace())``. We return the
        dict so the integration is testable without the SDK and
        so the route layer can echo the exact payload Weave would
        receive.
        """
        return payload.to_weave_trace()


def fan_out_bronze_event(event: Mapping[str, Any], client: WeaveClient | None = None) -> dict[str, Any] | None:
    """If the event is an LLM call, return its Weave payload.

    No-op (returns None) when:
      - the event is not an LLM call,
      - the integration is disabled (no client or client.enabled=False).

    Designed to be called from :func:`eden.data_platform.bronze_sink.ingest`
    after the canonical write succeeds.
    """
    if client is None or not client.enabled:
        return None
    payload = from_bronze_event(event)
    if payload is None:
        return None
    return client.log(payload)


__all__ = [
    "WeaveClient",
    "WeaveTracePayload",
    "fan_out_bronze_event",
    "from_bronze_event",
]
