"""Format detection: turn (path, content_type, body) into a format name.

The route's URL path is the primary signal
(``/orgs/{org_id}/ingest/{format}``), so most detection happens at the
routing layer. This module is the fallback for ambiguous cases:

- A generic ``/ingest/webhook`` POST that arrives with no
  ``X-Source-Format`` header and a body shape that matches one of the
  known formats (try OTel OTLP/HTTP JSON, then Helicone, then Langfuse,
  etc.).
- A POST that arrives with ``Content-Type: application/x-otel-protobuf``
  even though the path is the generic webhook.

The detector is **read-only** — it never mutates the body. Detection
is best-effort: on a miss we return ``"webhook"`` and let the webhook
decoder do the final validation.
"""

from __future__ import annotations

import logging

from eden.observability.ingestion.json_body import loads_body

logger = logging.getLogger(__name__)


# Content-type → format map. Keep small; the heavy lifting is in
# body-shape sniffing below.
_CONTENT_TYPE_MAP: dict[str, str] = {
    "application/x-otel-protobuf": "otel",
    "application/x-protobuf": "otel",
    "application/json+x-otel": "otel",
}


def detect_from_content_type(content_type: str | None) -> str | None:
    """Return a format name for a known OTLP-style content type, else None.

    Plain ``application/json`` is intentionally NOT in the map — too many
    formats use it. We fall through to body-shape sniffing for those.
    """
    if not content_type:
        return None
    ct = content_type.split(";", 1)[0].strip().lower()
    return _CONTENT_TYPE_MAP.get(ct)


def detect_from_x_source_format(headers: dict[str, str]) -> str | None:
    """``X-Source-Format`` header lets a client force a specific decoder."""
    val = headers.get("x-source-format") or headers.get("X-Source-Format")
    if val:
        return str(val).strip().lower()
    return None


def _looks_like_otel(body: bytes) -> bool:
    """Heuristic: OTLP/HTTP JSON trace export has
    ``resourceSpans`` (camelCase) or ``resource_spans`` (snake_case)
    at the top level."""
    try:
        parsed = loads_body(body)
    except (ValueError, UnicodeDecodeError):
        return False
    if not isinstance(parsed, dict):
        return False
    return "resourceSpans" in parsed or "resource_spans" in parsed


def _looks_like_helicone(body: bytes) -> bool:
    """Helicone logs carry a ``Helicone-Request-Id`` header AND a JSON
    body with at least one of: ``request_id``, ``model``, ``usage``,
    ``response_status``. Sniff the body only when the header is present
    is more reliable; this is a backstop."""
    try:
        parsed = loads_body(body)
    except (ValueError, UnicodeDecodeError):
        return False
    if not isinstance(parsed, dict):
        return False
    helicone_keys = {
        "request_id", "requestId", "model", "usage", "response_status",
        "responseStatus", "helicone_request_id", "properties",
    }
    return any(k in parsed for k in helicone_keys)


def _looks_like_langfuse(body: bytes) -> bool:
    """Langfuse batch exports carry a list of traces with ``observations``
    and ``scores`` arrays."""
    try:
        parsed = loads_body(body)
    except (ValueError, UnicodeDecodeError):
        return False
    if isinstance(parsed, list):
        return any(
            isinstance(t, dict) and ("observations" in t or "scores" in t)
            for t in parsed
        )
    if isinstance(parsed, dict):
        return (
            "batch" in parsed
            or "observations" in parsed
            or "scores" in parsed
        )
    return False


def detect_from_body(body: bytes) -> str:
    """Best-effort body-shape detection. Returns a format name, falling
    back to ``"webhook"`` on miss.
    """
    if _looks_like_otel(body):
        return "otel"
    if _looks_like_helicone(body):
        return "helicone"
    if _looks_like_langfuse(body):
        return "langfuse"
    return "webhook"


def detect_format(
    *,
    path_format: str | None,
    content_type: str | None,
    body: bytes,
    headers: dict[str, str] | None = None,
) -> str:
    """Precedence: path → X-Source-Format header → Content-Type → body
    sniff → webhook fallback.

    Args:
        path_format: The format from the URL path (``{format}`` segment).
            Most routes set this; the generic webhook endpoint does not.
        content_type: The request's ``Content-Type`` header.
        body: Raw request body (used only when path/header are
            ambiguous).
        headers: All request headers (lowercase keys expected). Used to
            read ``X-Source-Format`` when present.

    Returns:
        A format name suitable for ``FormatRegistry.decode(format, ...)``.
    """
    if path_format:
        return path_format.strip().lower()

    if headers:
        forced = detect_from_x_source_format(headers)
        if forced:
            return forced

    from_ct = detect_from_content_type(content_type)
    if from_ct:
        return from_ct

    return detect_from_body(body)
