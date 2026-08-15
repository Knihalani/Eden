"""Cat 22 — Per-step evaluation scores (v1.4).

The v1.4 ship extends :class:`TelemetryEvent` with a
``step_index`` and a ``step_judges`` field (stored inside
``telemetry_events.attributes`` JSONB — the v1.4 ship uses
JSONB to avoid a destructive migration; a future v1.4.1
hardens them into dedicated columns). After Cat 3
:class:`~eden.llmops.judges.runner.JudgeRunner` scores an
event, :func:`stamp_event_judge_scores` maps the returned
``JudgeScore`` rows onto ``step_judges`` (keyed by
``step_index``) and persists them via
:class:`StepJudgeStamper`. The Cat 2 RCA clusterer + the
new Cat 22 path-depth metrics read the stamped values.

Public surface:

* :func:`stamp_event_judge_scores` — automatic loop wired
  from :meth:`~eden.llmops.judges.runner.JudgeRunner.run_for_event`.
* :meth:`StepJudgeStamper.stamp` — write the step index +
  judge scores onto a span's attributes dict (also used by
  the HTTP stamp route for manual overrides).
* :meth:`StepJudgeStamper.get_step_judges` — read the step
  judges for a given ``(org_id, trace_id, step_index)``
  tuple.
* :meth:`StepJudgeStamper.get_trace_steps` — list every
  step in a trace, in step-index order, with the judge
  scores.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from ._common import (
    _ok_envelope,
    enrich_step_attributes,
    extract_step_index,
    extract_step_judges,
)

if TYPE_CHECKING:
    from eden.llmops.judges.base import JudgeScore

logger = logging.getLogger(__name__)


def resolve_step_index(event: Any, *, fallback: int = 0) -> int:
    """Best-effort ``step_index`` extraction from a telemetry event.

    Prefers the Cat 22 ``apm.step_index`` attribute, then legacy
    ``attributes.step_index`` / ``payload.step_index`` shapes used
    by gateways and time-travel recorders.
    """
    attrs = getattr(event, "attributes", None)
    if isinstance(attrs, dict):
        idx = extract_step_index(attrs)
        if idx is not None:
            return idx
        raw = attrs.get("step_index")
        if raw is not None:
            try:
                return int(raw)
            except (TypeError, ValueError):
                pass

    payload = getattr(event, "payload", None)
    if isinstance(payload, dict):
        raw = payload.get("step_index")
        if isinstance(raw, int):
            return raw
        if isinstance(raw, str) and raw.isdigit():
            return int(raw)
        try:
            return int(raw)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            pass
    return fallback


def scores_to_step_judges(scores: Iterable[Any]) -> dict[str, float]:
    """Map a JudgeRunner result batch to ``{judge_name: score}``."""
    out: dict[str, float] = {}
    for score in scores:
        if score is None:
            continue
        name = getattr(score, "judge_name", None)
        if not isinstance(name, str) or not name:
            continue
        try:
            out[name] = float(score.score)
        except (TypeError, ValueError, AttributeError):
            continue
    return out


async def persist_step_judge_attributes(
    org_id: str,
    *,
    trace_id: str,
    attributes: dict[str, Any],
    span_id: str | None = None,
    event_id: str | None = None,
) -> bool:
    """Merge stamped attributes onto one ``telemetry_events`` row.

    Best-effort: returns ``False`` when Postgres is unavailable or
    no row matches ``(tenant_id, trace_id, span_id|event_id)``.
    """
    if not org_id or not trace_id or not isinstance(attributes, dict):
        return False
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return False
    try:
        client = await get_postgres_client()
    except Exception:
        client = None
    if client is None:
        return False

    patch = json.dumps(attributes, ensure_ascii=False)
    try:
        if span_id:
            result = await client.execute(
                """
                UPDATE telemetry_events
                SET attributes = COALESCE(attributes, '{}'::jsonb) || $4::jsonb
                WHERE tenant_id = $1
                  AND trace_id = $2
                  AND span_id = $3
                """,
                org_id,
                trace_id,
                span_id,
                patch,
            )
            if result and getattr(result, "rowcount", 0) > 0:
                return True
        if event_id:
            result = await client.execute(
                """
                UPDATE telemetry_events
                SET attributes = COALESCE(attributes, '{}'::jsonb) || $4::jsonb
                WHERE tenant_id = $1
                  AND trace_id = $2
                  AND event_id = $3
                """,
                org_id,
                trace_id,
                event_id,
                patch,
            )
            return bool(result and getattr(result, "rowcount", 0) > 0)
    except Exception as exc:
        logger.debug("step_judges: persist failed: %s", exc)
    return False


async def stamp_event_judge_scores(
    event: Any,
    scores: list[JudgeScore],
    *,
    stamper: StepJudgeStamper | None = None,
) -> bool:
    """Stamp JudgeRunner scores onto the event's per-step attributes.

    Called automatically from
    :meth:`~eden.llmops.judges.runner.JudgeRunner.run_for_event`
    after judges finish. Merges with any judges already stamped on
    the span and persists to ``telemetry_events.attributes``.
    """
    if not scores:
        return False

    org_id = str(getattr(event, "tenant_id", None) or "").strip()
    if not org_id:
        meta = getattr(scores[0], "metadata", None) or {}
        org_id = str(meta.get("tenant_id") or "default")

    trace_id = (
        getattr(scores[0], "trace_id", None)
        or getattr(event, "trace_id", None)
        or ""
    )
    if not isinstance(trace_id, str) or not trace_id:
        return False

    attrs = dict(getattr(event, "attributes", None) or {})
    merged_judges = {
        **extract_step_judges(attrs),
        **scores_to_step_judges(scores),
    }
    if not merged_judges:
        return False

    step_index = resolve_step_index(event)
    stamped = (stamper or StepJudgeStamper()).stamp(
        org_id,
        attributes=attrs,
        step_index=step_index,
        step_judges=merged_judges,
    )
    enriched = stamped.get("data", {}).get("attributes")
    if not isinstance(enriched, dict):
        return False

    return await persist_step_judge_attributes(
        org_id,
        trace_id=trace_id,
        attributes=enriched,
        span_id=getattr(event, "span_id", None),
        event_id=getattr(event, "event_id", None),
    )


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
