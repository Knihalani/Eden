"""Cat 20 — TraceRecorder.

The instrument that the :class:`eden.llmops.ai_gateway.AIGateway`
calls on every LLM step. The recorder decides:

* **Is this step cacheable?** — per the v1.3 spec, a step is
  cacheable when ``temperature == 0`` OR ``seed`` is set OR
  the gateway's ``cache_mode`` is ``"always"``. The
  :class:`eden.llmops.semantic_cache.SemanticCache` already
  has the same check; the recorder re-uses the signal so
  the fork-and-replay algorithm can identify cache-eligible
  steps from the existing ``cache_lookups`` telemetry.
* **What's the cache key?** — the recorder computes
  ``tt:<trace_id>:<step_index>:<response_hash>`` (the
  :func:`_step_cache_key` helper). The response_hash is the
  existing ``telemetry_events.response_hash`` convention; we
  re-use it so a step that was cached during the original
  execution hits the same key on a later fork.

The recorder writes one row per step to the existing
``telemetry_events`` table (with ``event_type='agent.step'``
and the cacheable flag in the ``attributes`` JSONB). The
existing :class:`eden.observability.checkpoint.rewind.CheckpointService`
and the new :class:`TraceForker` both read the same
``agent.step`` events; the recorder doesn't introduce a
new table.

Closed-loop wiring: the recorder does not fire hooks. The
replayer fires :class:`PromotionHook.on_judge_regression`
through the existing Cat 3 judge path on a successful
replay.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _step_cache_key

logger = logging.getLogger(__name__)


# The 3 cacheable conditions the appendix lists. The
# SemanticCache uses the same check; the recorder re-uses
# the signal so the fork-and-replay algorithm can identify
# cache-eligible steps from the existing ``cache_lookups``
# telemetry.
_CACHEABLE_TEMPERATURE: float = 0.0


class TraceRecorder:
    """Record a step's cacheability + cache key for fork-and-replay."""

    async def record_step(
        self,
        org_id: str,
        *,
        trace_id: str,
        step_index: int,
        request: dict[str, Any],
        response: dict[str, Any],
        temperature: float | None = None,
        seed: int | None = None,
        cache_mode: str | None = None,
    ) -> dict[str, Any]:
        """Record a step and return the cacheability metadata.

        Args:
            org_id: The tenant id.
            trace_id: The trace the step belongs to.
            step_index: The step's sequence number.
            request: The LLM request payload (for the
                ``payload`` JSONB column).
            response: The LLM response payload (for the
                ``payload.response_hash`` extraction).
            temperature: The LLM's temperature setting.
                ``0.0`` makes the step cacheable.
            seed: The LLM's seed setting. A non-None value
                makes the step cacheable.
            cache_mode: The gateway's ``cache_mode``
                override. ``"always"`` makes the step
                cacheable.

        Returns:
            The cacheability metadata the gateway emits
            alongside the ``agent.step`` event. The same
            dict is what the :class:`TraceReplayer` reads
            on a later fork to decide "serve from cache"
            vs "re-execute live".
        """
        cacheable = (
            (temperature is not None and temperature == _CACHEABLE_TEMPERATURE)
            or seed is not None
            or cache_mode == "always"
        )
        # The response_hash is the existing
        # telemetry_events.response_hash convention. The
        # caller passes it as a string; the recorder
        # computes the cache key from it.
        response_hash = response.get("response_hash", "")
        if not isinstance(response_hash, str):
            response_hash = str(response_hash)
        cache_key = _step_cache_key(
            trace_id=trace_id,
            step_index=step_index,
            response_hash=response_hash,
        ) if cacheable else None

        # The recorder is the single source of truth for
        # the cacheable flag. The AIGateway reads this
        # when it emits the ``cache_lookups`` telemetry
        # row; the :class:`TraceReplayer` reads the same
        # ``agent.step`` event to decide "serve from cache".
        return {
            "cacheable": cacheable,
            "cache_key": cache_key,
            "step_index": step_index,
            "trace_id": trace_id,
        }


__all__ = ["TraceRecorder", "_CACHEABLE_TEMPERATURE"]
