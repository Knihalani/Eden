"""Raw-JSON webhook decoder (catch-all).

The route ``POST /orgs/{org_id}/ingest/webhook`` accepts a minimal JSON
contract. Required fields:

- ``event_id`` (string; if missing, generated as ``whk_<uuid>``)
- ``trace_id`` (string; if missing, generated as ``trace_<uuid>``)
- ``event_type`` (string; required — used to categorize the event)
- ``timestamp`` (ISO 8601, epoch ms, or epoch s; required — defaults
  to now() if missing)

Optional fields (any of the canonical ``TelemetryEvent`` fields):
- ``realm`` (one of "environment" / "production", default "production")
- ``name``, ``duration_ms``, ``payload`` (object), ``metrics`` (object),
  ``attributes`` (object of string→string), ``tags`` (list of strings),
  ``outcome``, ``environment_id``, ``agent_id``, ``agent_version``,
  ``parent_span_id``, ``span_id``, ``source_format``

Strict limits:
  - Body must be ≤ ``settings.ingestion_max_body_bytes`` (1 MiB default).
    The route layer enforces this; the decoder raises ``BodyTooLargeError``
    if called directly.
  - ``attributes`` values must be strings (Pydantic validation).
"""

from __future__ import annotations

import logging

from eden.config import get_settings
from eden.observability.ingestion.json_body import loads_body
from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import (
    BodyTooLargeError,
    SchemaInvalidError,
)
from eden.observability.ingestion.normalizer import normalize_to_telemetry_event
from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


# Hard cap mirrors ``settings.ingestion_max_body_bytes``. We also enforce
# a hard ceiling here so direct calls to the decoder (e.g. from tests)
# can't bypass the limit.
_MAX_BODY_HARD_CAP = 8 * 1024 * 1024  # 8 MiB — a sanity ceiling


_REQUIRED_FIELDS = ("event_type",)


class WebhookDecoder:
    """Catch-all JSON decoder for arbitrary ingest payloads."""

    source_format = "webhook"

    def detect(self, body: bytes, content_type: str | None) -> bool:
        # The webhook decoder is the fallback — it always returns True
        # for any JSON body. Callers should prefer the more specific
        # decoders first (otel / helicone / langfuse / etc.) and only
        # use webhook when nothing else matched.
        try:
            parsed = loads_body(body)
        except (ValueError, UnicodeDecodeError):
            return False
        return isinstance(parsed, (dict, list))

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        settings = get_settings()

        # Size guard — defense in depth even though the route also checks.
        if len(body) > _MAX_BODY_HARD_CAP:
            raise BodyTooLargeError(
                f"webhook body is {len(body)} bytes (hard cap {_MAX_BODY_HARD_CAP})"
            )
        if (
            settings.ingestion_max_body_bytes
            and len(body) > settings.ingestion_max_body_bytes
        ):
            raise BodyTooLargeError(
                f"webhook body is {len(body)} bytes (limit "
                f"{settings.ingestion_max_body_bytes})"
            )

        try:
            payload = loads_body(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SchemaInvalidError(
                f"webhook body is not valid JSON: {exc}",
                problems=[f"json_decode_error: {exc}"],
            ) from exc

        if isinstance(payload, list):
            items = [p for p in payload if isinstance(p, dict)]
        elif isinstance(payload, dict):
            items = [payload]
        else:
            raise SchemaInvalidError(
                "webhook body must be a JSON object or list",
                problems=["body_shape"],
            )

        if not items:
            raise SchemaInvalidError(
                "webhook body parsed but contained no items",
                problems=["empty"],
            )

        problems: list[str] = []
        for i, item in enumerate(items):
            for field in _REQUIRED_FIELDS:
                if field not in item or item[field] in (None, ""):
                    problems.append(f"item[{i}].{field}: required")
        if problems:
            raise SchemaInvalidError(
                f"webhook body missing required fields: {problems}",
                problems=problems,
            )

        events: list[TelemetryEvent] = []
        for item in items:
            # Per-item source_format override wins; default to "webhook".
            fmt = str(item.get("source_format") or self.source_format)
            event_attribution = attribution.with_source_format(fmt)
            event = await normalize_to_telemetry_event(
                item, event_attribution
            )
            events.append(event)
        return events
