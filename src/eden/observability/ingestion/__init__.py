"""Eden multi-format telemetry ingestion layer (Phase 7.0).

Accepts telemetry from OTel OTLP, Helicone, Langfuse, OpenAI /
Anthropic / Bedrock / Gemini usage events, framework adapters (Vercel
AI / LangChain / LlamaIndex / Mastra / CrewAI), and a raw-JSON webhook.
All formats normalize to ``TelemetryEvent`` and flow through the
existing ``TelemetryCollector`` — no new storage, no new UI, no new
collector process.

Public surface
--------------

``FormatRegistry`` (singleton via ``get_format_registry()``) is the
dispatch layer. ``Attribution`` is the per-request context decoders
receive. ``SourceDecoder`` is the protocol every decoder implements.
``normalize_to_telemetry_event`` is the shared final step that runs
PII pre-mask and stamps tenant/format/project. ``IngestError`` and
its subclasses are the exception types decoders may raise; the route
layer maps each to a single HTTP status code.
"""

from __future__ import annotations

import logging

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import (
    AttributionError,
    BodyTooLargeError,
    FormatUnsupportedError,
    IngestError,
    PIIMaskingError,
    SchemaInvalidError,
    exception_to_http_status,
)
from eden.observability.ingestion.registry import (
    FormatRegistry,
    SourceDecoder,
    get_format_registry,
    reset_format_registry,
)

__all__ = [
    "Attribution",
    "IngestError",
    "FormatUnsupportedError",
    "SchemaInvalidError",
    "PIIMaskingError",
    "BodyTooLargeError",
    "AttributionError",
    "exception_to_http_status",
    "FormatRegistry",
    "SourceDecoder",
    "get_format_registry",
    "reset_format_registry",
    "register_default_decoders",
]


logger = logging.getLogger(__name__)


def register_default_decoders(registry: FormatRegistry) -> None:
    """Register the built-in decoder set on a registry. Idempotent —
    safe to call multiple times; existing registrations are overwritten.

    Imports are deferred to keep the cold-path cost low: only the
    decoders actually registered here are imported, and only on
    explicit ``register_default_decoders()`` call (not at module
    import).
    """
    from eden.observability.ingestion.framework import FrameworkDecoder
    from eden.observability.ingestion.helicone import HeliconeDecoder
    from eden.observability.ingestion.langfuse import LangfuseDecoder
    from eden.observability.ingestion.otel import OtelDecoder
    from eden.observability.ingestion.providers import (
        AnthropicDecoder,
        BedrockDecoder,
        GeminiDecoder,
        OpenAIDecoder,
    )
    from eden.observability.ingestion.webhook import WebhookDecoder

    registry.register(OtelDecoder())
    registry.register(HeliconeDecoder())
    registry.register(LangfuseDecoder())
    registry.register(OpenAIDecoder())
    registry.register(AnthropicDecoder())
    registry.register(BedrockDecoder())
    registry.register(GeminiDecoder())
    registry.register(FrameworkDecoder())
    registry.register(WebhookDecoder())


# Backward-compatible alias used by ``registry.get_format_registry()``.
# Defined here to avoid a circular import at module load.
def _register_defaults(registry: FormatRegistry) -> None:
    register_default_decoders(registry)
