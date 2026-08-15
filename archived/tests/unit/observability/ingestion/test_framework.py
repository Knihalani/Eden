"""Tests for the framework decoder."""

import json

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.framework import (
    FrameworkDecoder,
    _identify_framework,
)


def _otel_span_with_attrs(attrs: list[tuple[str, str]]) -> bytes:
    span = {
        "traceId": "abc",
        "spanId": "def",
        "name": "framework-call",
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": [
            {"key": k, "value": {"stringValue": v}} for k, v in attrs
        ],
    }
    return json.dumps({
        "resourceSpans": [{
            "resource": {"attributes": []},
            "scopeSpans": [{"scope": {"name": "x"}, "spans": [span]}]
        }]
    }).encode()


# ── _identify_framework ──────────────────────────────────────────


def test_identify_vercel_ai_prefix():
    body = _otel_span_with_attrs([("vercel.ai.prompt", "Hi")])
    assert _identify_framework(body, None) == "vercel-ai"


def test_identify_langchain_prefix():
    body = _otel_span_with_attrs([("langchain.chain.name", "qa")])
    assert _identify_framework(body, None) == "langchain"


def test_identify_llama_index_prefix():
    body = _otel_span_with_attrs([("llama_index.query", "search")])
    assert _identify_framework(body, None) == "llama-index"


def test_identify_mastra_prefix():
    body = _otel_span_with_attrs([("mastra.agent.id", "agent_1")])
    assert _identify_framework(body, None) == "mastra"


def test_identify_crewai_prefix():
    body = _otel_span_with_attrs([("crewai.crew.name", "research")])
    assert _identify_framework(body, None) == "crewai"


def test_identify_unknown_prefix_returns_none():
    body = _otel_span_with_attrs([("custom.framework.foo", "bar")])
    assert _identify_framework(body, None) is None


def test_identify_via_header():
    body = json.dumps({"resourceSpans": []}).encode()
    headers = {"x-source-framework": "langchain"}
    assert _identify_framework(body, None, headers) == "langchain"


def test_identify_via_header_alternate_case():
    body = json.dumps({"resourceSpans": []}).encode()
    headers = {"X-Source-Framework": "LlamaIndex"}
    assert _identify_framework(body, None, headers) == "llama-index"


# ── FrameworkDecoder ─────────────────────────────────────────────


def test_framework_detect_otel_shape():
    body = _otel_span_with_attrs([("gen_ai.request.model", "gpt-4o")])
    assert FrameworkDecoder().detect(body, None) is True


def test_framework_detect_negative():
    assert FrameworkDecoder().detect(b'{"foo": "bar"}', None) is False
    assert FrameworkDecoder().detect(b"not json", None) is False


@pytest.mark.asyncio
async def test_framework_decode_stamps_framework_name():
    body = _otel_span_with_attrs([("langchain.chain.name", "qa")])
    events = await FrameworkDecoder().decode(
        body,
        Attribution(tenant_id="org_abc", source_format="framework"),
    )
    assert len(events) == 1
    assert events[0].source_format == "framework"
    assert "framework:langchain" in events[0].tags
    assert events[0].attributes["framework.name"] == "langchain"


@pytest.mark.asyncio
async def test_framework_decode_unknown_framework_uses_otel_name():
    """If no framework prefix matches, the event still ingests as 'framework'."""
    body = _otel_span_with_attrs([("gen_ai.request.model", "gpt-4o")])
    events = await FrameworkDecoder().decode(
        body,
        Attribution(tenant_id="org_abc", source_format="framework"),
    )
    assert len(events) == 1
    # No framework name tag because we couldn't identify one.
    assert not any(t.startswith("framework:") for t in events[0].tags)
