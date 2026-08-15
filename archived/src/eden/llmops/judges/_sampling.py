"""Production judge sampling gate."""

from __future__ import annotations

import hashlib
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

PRODUCTION_SAMPLE_RATE = 0.012


def _is_priority_bypass(event: TelemetryEvent) -> bool:
    """Always score P0 traces and stumbles."""
    tags = getattr(event, "tags", None) or []
    for tag in tags:
        lowered = str(tag).lower()
        if lowered in ("p0", "stumble") or lowered.startswith(("p0:", "stumble:")):
            return True

    attrs = getattr(event, "attributes", None) or {}
    if isinstance(attrs, dict):
        for key in ("priority", "severity", "stumble_kind"):
            val = str(attrs.get(key, "")).lower()
            if val in ("p0", "stumble") or val.startswith("stumble"):
                return True
        if attrs.get("stumble") or attrs.get("is_stumble"):
            return True

    payload = getattr(event, "payload", None) or {}
    if isinstance(payload, dict):
        if payload.get("stumble") or payload.get("stumble_kind"):
            return True
        if str(payload.get("severity", "")).upper() == "P0":
            return True
    return False


def production_sample_matches(event: TelemetryEvent) -> bool:
    """Deterministic ~1.2% sampling with P0/stumble bypass."""
    if os.environ.get("EDEN_DISABLE_PRODUCTION_SAMPLING") == "1":
        return True
    if _is_priority_bypass(event):
        return True
    trace_id = getattr(event, "trace_id", None) or ""
    if not trace_id:
        return False
    digest = hashlib.sha256(trace_id.encode("utf-8")).digest()
    threshold = int(256 * PRODUCTION_SAMPLE_RATE)
    return digest[0] < threshold
