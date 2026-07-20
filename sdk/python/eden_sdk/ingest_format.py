"""Map SDK source_format labels onto backend ingest path segments.

The gateway allow-list (``settings.ingestion_allowed_formats``) is only::

    otel | helicone | langfuse | openai | anthropic | bedrock |
    gemini | framework | webhook

SDK emitters historically stamped richer labels (``custom``, ``vercel-ai``,
``pydantic-ai``, ``eden-sdk-doctor``, …). Those path segments return HTTP
415. Remap them here so the URL path is allow-listed while the event
payload may still carry the original label for portal filtering.

TraceEvent-shaped SDK payloads (event_id / event_type / …) are accepted by
the ``webhook`` decoder. The ``framework`` decoder expects OTel
``resourceSpans`` and would 4xx TraceEvent JSON — so framework aliases
also remap to ``webhook``.
"""

from __future__ import annotations

ALLOWED_INGEST_FORMATS: frozenset[str] = frozenset(
    {
        "otel",
        "helicone",
        "langfuse",
        "openai",
        "anthropic",
        "bedrock",
        "gemini",
        "framework",
        "webhook",
    }
)

# Semantic aliases → allow-listed path. Identity for already-allowed.
_INGEST_FORMAT_REMAP: dict[str, str] = {
    # Catch-all / doctor / logging / custom SDK stamps
    "custom": "webhook",
    "eden-sdk-doctor": "webhook",
    "eden-sdk-logging": "webhook",
    "eden_sdk": "webhook",
    "eden-trace-agent-ts": "webhook",
    "eden-auto-instrument-ts": "webhook",
    "eden-auto-instrument": "webhook",
    # Framework SDKs emit TraceEvent JSON, not OTel resourceSpans
    "vercel-ai": "webhook",
    "langchain": "webhook",
    "llama_index": "webhook",
    "llama-index": "webhook",
    "pydantic-ai": "webhook",
    "pydantic_ai": "webhook",
    "mastra": "webhook",
    "crewai": "webhook",
    "autogen": "webhook",
    "smolagents": "webhook",
}


def resolve_ingest_path(source_format: str) -> str:
    """Return the ``/ingest/{format}`` path segment for ``source_format``."""
    fmt = (source_format or "").strip().lower() or "webhook"
    if fmt in ALLOWED_INGEST_FORMATS:
        return fmt
    return _INGEST_FORMAT_REMAP.get(fmt, "webhook")
