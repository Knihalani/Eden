"""Tests for the canonical framework registry."""

from eden.integrations.framework_registry import (
    FRAMEWORK_MARKERS,
    KNOWN_FRAMEWORK_IDS,
    PYTHON_SDK_MODULES,
    build_otel_header_map,
    build_otel_prefix_map,
)


def test_onboarding_frameworks_include_mastra_and_ollama():
    assert "mastra" in FRAMEWORK_MARKERS
    assert "ollama" in FRAMEWORK_MARKERS
    assert "langchain" in FRAMEWORK_MARKERS


def test_sdk_modules_align_with_onboarding():
    for fw in ("openai", "langchain", "mastra", "ollama"):
        assert fw in PYTHON_SDK_MODULES


def test_otel_maps_include_ingest_only_frameworks():
    prefixes = build_otel_prefix_map()
    headers = build_otel_header_map()
    assert prefixes["smolagents."] == "smolagents"
    assert headers["vercel-ai"] == "vercel-ai"
    assert headers["llama-index"] == "llama-index"


def test_known_ids_include_custom():
    assert "custom" in KNOWN_FRAMEWORK_IDS
    assert "dspy" in KNOWN_FRAMEWORK_IDS
