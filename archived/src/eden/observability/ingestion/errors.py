"""Exception hierarchy for the multi-format telemetry ingestion layer.

Each exception maps to a single HTTP status code at the route boundary.
The route handler in ``src/eden/api/routes/ingestion.py`` translates via
``exception_to_http_status()`` so all decoders raise a single, consistent
set of types and the route stays small.
"""

from __future__ import annotations


class IngestError(Exception):
    """Base for all ingestion-layer errors. Status defaults to 500."""

    http_status: int = 500


class FormatUnsupportedError(IngestError):
    """The source format is not in ``settings.ingestion_allowed_formats``
    or has no registered decoder."""

    http_status = 415


class SchemaInvalidError(IngestError):
    """The payload failed the decoder's schema validation. Carries the
    list of field-level problems so the client can fix them."""

    http_status = 422

    def __init__(self, message: str, *, problems: list[str] | None = None) -> None:
        super().__init__(message)
        self.problems = list(problems or [])


class PIIMaskingError(IngestError):
    """The PII masker failed on a field that must not be persisted raw.
    Distinct from a generic masker exception (which we log-and-continue)."""

    http_status = 422


class BodyTooLargeError(IngestError):
    """The request body exceeded ``settings.ingestion_max_body_bytes``."""

    http_status = 413


class AttributionError(IngestError):
    """Tenant attribution failed — no API key, no cookie, no resolved org."""

    http_status = 401


def exception_to_http_status(exc: Exception) -> int:
    """Single source of truth for error → status mapping."""
    if isinstance(exc, IngestError):
        return exc.http_status
    return 500
