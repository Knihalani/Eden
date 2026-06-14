"""Cat 22 — Per-step evaluation scores (v1.4).

The v1.4 ship extends :class:`TelemetryEvent` with a
``step_index`` and a ``step_judges`` field (stored inside
``telemetry_events.attributes`` JSONB — the v1.4 ship uses
JSONB to avoid a destructive migration; a future v1.4.1
hardens them into dedicated columns). The Cat 3
``JudgeRunner`` and the per-step Cat 22 judge call into
:class:`StepJudgeStamper` to write the per-step scores; the
Cat 2 RCA clusterer + the new Cat 22 path-depth metrics
read them.

The v0 ship is **stamping only** — the actual per-step
judge_runner wiring is the v0.1 follow-up. The stamper
exposes:

* :meth:`stamp` — write the step index + judge scores onto
  a span's attributes dict (the
  :class:`TelemetryCollector` calls this when a Cat 3 judge
  has scored a step).
* :meth:`get_step_judges` — read the step judges for a
  given ``(org_id, trace_id, step_index)`` tuple.
* :meth:`get_trace_steps` — list every step in a trace, in
  step-index order, with the judge scores.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    _ok_envelope,
    enrich_step_attributes,
    extract_step_index,
    extract_step_judges,
)

logger = logging.getLogger(__name__)


class StepJudgeStamper:
    """The per-step judge stamper (Cat 22 v1.4).

    Writes step_index + step_judges into a span's
    ``attributes`` dict, and reads them back for the
    dashboards.
    """

    name = "step_judge_stamper"

    def stamp(
        self,
        org_id: str,
        *,
        attributes: dict[str, Any],
        step_index: int,
        step_judges: dict[str, float] | None = None,
    ) -> dict[str, Any]:
        """Stamp step_index + step_judges onto ``attributes``.

        Returns ``data: {"attributes": {...}, "step_index": N,
        "step_judges": {...}}``.
        """
        enriched = enrich_step_attributes(
            attributes, step_index=step_index, step_judges=step_judges
        )
        # Robust to bad step_index — fall back to 0 instead
        # of raising (the helper normalises it inside
        # ``enriched``; we mirror the value here).
        try:
            step_index_value = int(step_index)
        except (TypeError, ValueError):
            step_index_value = 0
        return _ok_envelope(
            self.name,
            {
                "attributes": enriched,
                "step_index": step_index_value,
                "step_judges": extract_step_judges(enriched),
            },
        )

    async def get_step_judges(
        self,
        org_id: str,
        *,
        trace_id: str,
        step_index: int,
    ) -> dict[str, Any]:
        """Read the step judges for a given trace + step.

        The v0 ship queries ``telemetry_events`` for the
        span with the matching ``(org_id, trace_id,
        step_index)`` and returns the step_judges dict
        (empty if no span has stamped them).
        """
        if not isinstance(trace_id, str) or not trace_id:
            return _ok_envelope(
                self.name,
                {"trace_id": trace_id, "step_index": step_index,
                 "judges": {}},
            )
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception:
            return _ok_envelope(
                self.name,
                {"trace_id": trace_id, "step_index": step_index,
                 "judges": {}},
            )
        try:
            client = await get_postgres_client()
        except Exception:
            client = None
        if client is None:
            return _ok_envelope(
                self.name,
                {"trace_id": trace_id, "step_index": step_index,
                 "judges": {}},
            )
        # ``attributes`` is JSONB; we filter with a
        # ``@>`` containment query for the step_index key.
        # This is the path the v1.4 ship uses; the v1.4.1
        # follow-up adds a generated ``(step_index)``
        # column + btree index for the hot path.
        try:
            rows = await client.fetch(
                """
                SELECT attributes
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND trace_id = $2
                  AND attributes @> jsonb_build_object(
                      'apm.step_index', to_jsonb($3::int))
                ORDER BY timestamp ASC
                LIMIT 1
                """,
                org_id, trace_id, int(step_index),
            )
        except Exception as exc:
            logger.debug("step_judges: fetch failed: %s", exc)
            rows = []
        judges: dict[str, float] = {}
        for r in rows or []:
            attrs = (r.get("attributes") if isinstance(r, dict) else None) or {}
            judges = extract_step_judges(attrs)
            break
        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "step_index": int(step_index),
                "judges": judges,
            },
        )

    async def get_trace_steps(
        self,
        org_id: str,
        *,
        trace_id: str,
    ) -> dict[str, Any]:
        """List every step in a trace (with judges if stamped).

        Returns ``data: {"trace_id": "...", "steps": [
        {"step_index": N, "judges": {...}, "name": "..."}]}``
        in step-index order.
        """
        if not isinstance(trace_id, str) or not trace_id:
            return _ok_envelope(
                self.name,
                {"trace_id": trace_id, "steps": []},
            )
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception:
            return _ok_envelope(
                self.name,
                {"trace_id": trace_id, "steps": []},
            )
        try:
            client = await get_postgres_client()
        except Exception:
            client = None
        if client is None:
            return _ok_envelope(
                self.name,
                {"trace_id": trace_id, "steps": []},
            )
        try:
            rows = await client.fetch(
                """
                SELECT attributes, name, span_id
                FROM telemetry_events
                WHERE tenant_id = $1
                  AND trace_id = $2
                  AND attributes ? 'apm.step_index'
                ORDER BY (attributes->>'apm.step_index')::int ASC
                """,
                org_id, trace_id,
            )
        except Exception as exc:
            logger.debug("step_judges: trace_steps fetch failed: %s", exc)
            rows = []
        steps: list[dict[str, Any]] = []
        for r in rows or []:
            attrs = (r.get("attributes") if isinstance(r, dict) else None) or {}
            steps.append(
                {
                    "step_index": extract_step_index(attrs),
                    "judges": extract_step_judges(attrs),
                    "name": (r.get("name") if isinstance(r, dict) else None),
                    "span_id": (r.get("span_id") if isinstance(r, dict) else None),
                }
            )
        return _ok_envelope(
            self.name,
            {"trace_id": trace_id, "steps": steps},
        )
