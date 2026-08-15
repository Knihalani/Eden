"""Custom Properties service (Cat 1).

Helicone-style "custom properties": arbitrary key-value pairs
attached to a trace so the user can filter and group in
dashboards. Eden already supports a ``tags`` JSONB column on
``telemetry_events``; this service exposes a typed CRUD layer
on top so the front-end can present a key-value editor.

The ``tags`` column is shared with the existing
observability surface (Helicone / Langfuse ingestion also
populates it), so we merge rather than overwrite — the
custom properties are a *view* of the tags that came from
the SDK, not a separate store.

Limits (enforced):

* Per-org quota: max :data:`MAX_KEYS_PER_TRACE` keys per
  trace, max :data:`MAX_VALUE_CHARS` chars per value.
* Key names: non-empty, max :data:`MAX_KEY_CHARS` chars.

See ``docs/observability-gap/01-trace-replay.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.observability._trace_common import (
    error_envelope,
    fetch_trace_tags,
    merge_trace_tags,
    ok_envelope,
)

logger = logging.getLogger(__name__)


#: Per-trace key cap. Picked to match Helicone's per-request
#: metadata key limit.
MAX_KEYS_PER_TRACE: int = 64

#: Max chars per key. Aligned with the DB column size for
#: an index-friendly representation.
MAX_KEY_CHARS: int = 64

#: Max chars per value. 256 chars is enough for an env name
#: / region / cohort label — anything longer is almost
#: certainly a misformed payload.
MAX_VALUE_CHARS: int = 256


class CustomPropertiesService:
    """Typed CRUD for custom metadata on traces."""

    name = "custom_properties"

    async def set(
        self,
        org_id: str,
        *,
        trace_id: str,
        properties: dict[str, Any],
    ) -> dict[str, Any]:
        """Upsert custom properties on a trace.

        Merges ``properties`` into the existing ``tags`` on
        the trace's events. Existing keys are overwritten;
        new keys are added; keys not in ``properties`` are
        left alone.

        Validates:

        * ``properties`` is a dict
        * All keys are non-empty strings <=
          :data:`MAX_KEY_CHARS` chars
        * All values are strings <=
          :data:`MAX_VALUE_CHARS` chars
        * Total key count after merge doesn't exceed
          :data:`MAX_KEYS_PER_TRACE`

        Returns ``{set: [{key, value}]}`` on success, or an
        error envelope with ``code: invalid_input`` /
        ``code: quota_exceeded`` on validation failure.
        """
        if not isinstance(properties, dict):
            return error_envelope(
                self.name,
                "properties must be a dict[str, str]",
                code="invalid_input",
            )
        if not properties:
            return error_envelope(
                self.name,
                "properties must not be empty",
                code="invalid_input",
            )

        # Normalise: cast keys/values to str, trim whitespace.
        cleaned: dict[str, str] = {}
        for raw_k, raw_v in properties.items():
            k = str(raw_k).strip()
            v = "" if raw_v is None else str(raw_v)
            if not k:
                return error_envelope(
                    self.name,
                    "property keys must be non-empty",
                    code="invalid_input",
                )
            if len(k) > MAX_KEY_CHARS:
                return error_envelope(
                    self.name,
                    f"key {k[:16]!r} exceeds {MAX_KEY_CHARS} chars",
                    code="invalid_input",
                )
            if len(v) > MAX_VALUE_CHARS:
                return error_envelope(
                    self.name,
                    f"value for {k!r} exceeds {MAX_VALUE_CHARS} chars",
                    code="invalid_input",
                )
            cleaned[k] = v

        existing = await fetch_trace_tags(org_id, trace_id)
        merged = {**existing, **cleaned}
        if len(merged) > MAX_KEYS_PER_TRACE:
            return error_envelope(
                self.name,
                f"quota exceeded: max {MAX_KEYS_PER_TRACE} keys per trace "
                f"(would be {len(merged)})",
                code="quota_exceeded",
            )

        ok = await merge_trace_tags(org_id, trace_id, cleaned)
        if not ok:
            return error_envelope(
                self.name,
                "could not persist custom properties",
                code="unavailable",
            )

        return ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "set": [{"key": k, "value": v} for k, v in cleaned.items()],
                "total_keys": len(merged),
            },
        )

    async def list(
        self,
        org_id: str,
        *,
        trace_id: str,
    ) -> dict[str, Any]:
        """Return the custom properties for a trace.

        Reads the merged ``tags`` from the trace's first
        event. Returns ``{properties: {key: value}}``;
        empty dict if the trace has no events yet.
        """
        tags = await fetch_trace_tags(org_id, trace_id)
        return ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "properties": tags,
                "key_count": len(tags),
            },
        )
