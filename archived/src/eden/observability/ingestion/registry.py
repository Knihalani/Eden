"""FormatRegistry — the dispatch layer between the route handler and the
per-format decoders.

Each decoder implements the ``SourceDecoder`` protocol: a ``detect``
classmethod-style body check + an async ``decode`` that turns raw bytes
into a list of ``TelemetryEvent``.

The registry is a process-wide singleton (the route layer calls
``get_format_registry()``) and ships with a sensible default set
registered. Adding a new format = register a new decoder. Removing a
format = call ``unregister``.

The registry does NOT validate that the requested format is in
``settings.ingestion_allowed_formats`` — that's the route's job (it
maps a 415 before calling ``decode``).
"""

from __future__ import annotations

import logging
from typing import Protocol, runtime_checkable

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import FormatUnsupportedError
from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


@runtime_checkable
class SourceDecoder(Protocol):
    """Contract every format decoder satisfies.

    Concrete decoders (OTel, Helicone, Langfuse, ...) live as siblings
    in this package and are registered by ``register_default_decoders``
    in ``__init__.py``.
    """

    source_format: str

    def detect(self, body: bytes, content_type: str | None) -> bool:
        """Return True if this decoder can handle ``body`` / ``content_type``."""
        ...

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        """Parse ``body`` and emit one ``TelemetryEvent`` per logical
        event in the payload. Decoders call
        ``normalize_to_telemetry_event(...)`` from ``.normalizer`` for
        the final shape; the per-format decoder only handles
        format-specific parsing and field mapping."""
        ...


class FormatRegistry:
    """Process-wide dispatch table for telemetry source formats."""

    def __init__(self) -> None:
        self._decoders: dict[str, SourceDecoder] = {}

    # ── Registration ─────────────────────────────────────────────────

    def register(self, decoder: SourceDecoder) -> None:
        """Idempotent — registering the same ``source_format`` twice
        overwrites. Use this to swap decoders in tests."""
        if not getattr(decoder, "source_format", None):
            raise ValueError("decoder must declare source_format")
        self._decoders[decoder.source_format] = decoder
        logger.debug(f"registered decoder: {decoder.source_format}")

    def unregister(self, source_format: str) -> None:
        self._decoders.pop(source_format, None)

    def known_formats(self) -> list[str]:
        return sorted(self._decoders.keys())

    # ── Dispatch ─────────────────────────────────────────────────────

    async def decode(
        self,
        source_format: str,
        body: bytes,
        attribution: Attribution,
    ) -> list[TelemetryEvent]:
        """Dispatch to the registered decoder for ``source_format``.

        Raises ``FormatUnsupportedError`` (HTTP 415) if the format is
        unknown.
        """
        decoder = self._decoders.get(source_format)
        if decoder is None:
            raise FormatUnsupportedError(
                f"source_format={source_format!r} is not registered"
            )
        return await decoder.decode(body, attribution)

    def can_detect(
        self, body: bytes, content_type: str | None
    ) -> str | None:
        """Try each decoder's ``detect`` method. Returns the first match
        or None. Order of registration matters for ambiguous bodies."""
        for fmt, decoder in self._decoders.items():
            try:
                if decoder.detect(body, content_type):
                    return fmt
            except Exception as exc:
                logger.debug(f"detector {fmt} raised: {exc}")
        return None


# ── Singleton accessor ──────────────────────────────────────────────

_registry: FormatRegistry | None = None


def get_format_registry() -> FormatRegistry:
    """Get the process-wide registry, lazily registering the default
    decoder set on first call."""
    global _registry
    if _registry is None:
        _registry = FormatRegistry()
        from eden.observability.ingestion import _register_defaults  # local to avoid cycle

        _register_defaults(_registry)
    return _registry


def reset_format_registry() -> None:
    """Drop the singleton — for tests that need a clean registry."""
    global _registry
    _registry = None
