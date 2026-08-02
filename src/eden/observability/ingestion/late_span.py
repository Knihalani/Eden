"""Late-span admission policy (SOTA Wave 9).

Rejects (or marks) spans whose event timestamp is older than the
configured watermark. Default: accept with ``late_span`` attribute
when within grace; hard-reject when beyond ``late_span_max_age_seconds``.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

_late_stats: dict[str, float] = {
    "checked": 0.0,
    "accepted_late": 0.0,
    "rejected_late": 0.0,
}


def get_late_span_stats() -> dict[str, float]:
    return dict(_late_stats)


def evaluate_late_span(event: Any) -> str:
    """Return ``ok`` | ``late`` | ``reject`` for a telemetry event.

    Mutates ``event.attributes`` when accepting a late span.
    """
    _late_stats["checked"] += 1.0
    try:
        from eden.config import get_settings

        settings = get_settings()
    except Exception:
        return "ok"

    if not bool(getattr(settings, "late_span_policy_enabled", True)):
        return "ok"

    max_age = float(getattr(settings, "late_span_max_age_seconds", 86400.0) or 86400.0)
    if max_age <= 0:
        return "ok"

    ts_raw = getattr(event, "timestamp", None)
    if not ts_raw:
        return "ok"

    try:
        event_ts = datetime.fromisoformat(str(ts_raw).replace("Z", "+00:00"))
        if event_ts.tzinfo is None:
            event_ts = event_ts.replace(tzinfo=UTC)
    except ValueError:
        return "ok"

    age_s = (datetime.now(UTC) - event_ts).total_seconds()
    if age_s <= max_age:
        # Soft late: older than 1h but within max → stamp attribute.
        soft = float(getattr(settings, "late_span_soft_age_seconds", 3600.0) or 3600.0)
        if age_s > soft:
            attrs = getattr(event, "attributes", None)
            if isinstance(attrs, dict):
                attrs["late_span"] = True
                attrs["late_span_age_s"] = round(age_s, 3)
            _late_stats["accepted_late"] += 1.0
            return "late"
        return "ok"

    _late_stats["rejected_late"] += 1.0
    try:
        from eden.observability.drop_metrics import record_drop

        # Late-span hard rejects are an ingest admission decision; the
        # closest closed-vocabulary reason is quota_exceeded (age budget).
        record_drop("ingest", "quota_exceeded")
    except Exception:
        pass
    logger.debug(
        "late_span reject event_id=%s age_s=%.1f max=%.1f",
        getattr(event, "event_id", "?"),
        age_s,
        max_age,
    )
    return "reject"
