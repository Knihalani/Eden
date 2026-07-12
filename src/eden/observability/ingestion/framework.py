"""Framework-span decoder.

Accepts OTel-shaped spans emitted by AI agent / app frameworks that
adopt the OpenLLMetry conventions or ship their own OTel exporters:

- Vercel AI SDK (``@vercel/ai``)
- LangChain (``langchain``, ``@langchain/core``)
- LlamaIndex (``llama-index``)
- Mastra (``@mastra/core``)
- CrewAI (``crewai``)
- Smolagents, Pydantic AI, etc. (any OTel-shaped input)

The decoder's job is to:
  1. Detect whether the body looks OTel-shaped and whether the
     ``X-Source-Framework`` header or attribute prefix identifies a
     specific framework.
  2. Route the parse to the OTel decoder (which already knows how to
     map ``gen_ai.*`` attrs + span events).
  3. Re-stamp ``source_format`` to ``"framework"`` and add a
     ``framework:<name>`` tag.

We don't re-implement OTel parsing — we delegate. New frameworks that
adopt OpenLLMetry get supported for free.
"""

from __future__ import annotations

import json
import logging

from eden.observability.ingestion.attribution import Attribution
from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)


from eden.integrations.framework_registry import (
    build_otel_header_map,
    build_otel_prefix_map,
)

# Attribute prefixes that identify a specific framework. OTel-mapped
# framework-specific attributes live under these namespaces.
_FRAMEWORK_PREFIXES: dict[str, str] = build_otel_prefix_map()

# X-Source-Framework header values → canonical name.
_FRAMEWORK_HEADER_VALUES: dict[str, str] = build_otel_header_map()


def _identify_framework(
    body: bytes,
    content_type: str | None,
    headers: dict[str, str] | None = None,
) -> str | None:
    """Return the framework name if we can identify one, else None.

    Precedence: X-Source-Framework header → attribute prefix → None.
    """
    if headers:
        forced = headers.get("x-source-framework") or headers.get(
            "X-Source-Framework"
        )
        if forced:
            val = str(forced).strip().lower()
            if val in _FRAMEWORK_HEADER_VALUES:
                return _FRAMEWORK_HEADER_VALUES[val]
            # Accept and pass through if it looks like a framework name.
            if val and " " not in val and "/" not in val:
                return val

    try:
        parsed = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None

    # Walk the resource + scope_spans for any attribute key with a known
    # framework prefix.
    rs_list = parsed.get("resourceSpans") or parsed.get("resource_spans") or []
    for rs in rs_list:
        if not isinstance(rs, dict):
            continue
        for attr in (rs.get("resource") or {}).get("attributes", []) or []:
            key = str((attr or {}).get("key", ""))
            for prefix, name in _FRAMEWORK_PREFIXES.items():
                if key.startswith(prefix):
                    return name
        for ss in rs.get("scopeSpans") or rs.get("scope_spans") or []:
            if not isinstance(ss, dict):
                continue
            scope_name = (ss.get("scope") or {}).get("name", "")
            if isinstance(scope_name, str):
                for prefix, name in _FRAMEWORK_PREFIXES.items():
                    if scope_name.lower().startswith(prefix):
                        return name
            for span in ss.get("spans") or []:
                if not isinstance(span, dict):
                    continue
                for attr in span.get("attributes", []) or []:
                    key = str((attr or {}).get("key", ""))
                    for prefix, name in _FRAMEWORK_PREFIXES.items():
                        if key.startswith(prefix):
                            return name
    return None


class FrameworkDecoder:
    """Decoder for OTel-shaped spans emitted by AI agent frameworks.

    Delegates parsing to the OTel decoder's helpers (``_decode_attributes``,
    ``_ns_to_iso``, ``_span_to_raw_dict``) so we share the OTel GenAI
    semantic-convention mapping. The framework name is added as a tag.
    """

    source_format = "framework"

    def detect(self, body: bytes, content_type: str | None) -> bool:
        # We accept anything OTel-shaped — even if we can't identify a
        # specific framework, we still want to ingest it (with framework
        # name = "unknown" or absent).
        try:
            parsed = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(parsed, dict):
            return False
        return (
            "resourceSpans" in parsed or "resource_spans" in parsed
        )

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        # Reuse OTel decoder for the heavy lifting. The framework
        # decoder exists so the route can dispatch on X-Source-Framework
        # and so we can tag the event with the framework name.
        from eden.observability.ingestion.otel import OtelDecoder

        # If the request explicitly identified a framework via header,
        # accept it; otherwise we still parse (framework = None is fine).
        try:
            events = await OtelDecoder().decode(body, attribution)
        except Exception:
            raise

        framework_name = _identify_framework(body, None, headers=None)
        if not framework_name:
            return events

        for event in events:
            event.tags = list(event.tags or [])
            event.tags.append(f"framework:{framework_name}")
            # Add to attributes for filtering.
            event.attributes = dict(event.attributes or {})
            event.attributes["framework.name"] = framework_name
            event.source_format = self.source_format
        return events
