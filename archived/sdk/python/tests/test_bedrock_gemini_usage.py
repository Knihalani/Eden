"""Focused unit tests for the Bedrock + Gemini token/usage extraction
helpers (parity with the openai/anthropic instrumentations' billing
fields — see ``_tokens.extract_usage``).
"""

from __future__ import annotations

from types import SimpleNamespace

from eden_sdk.instrumentations.bedrock import (
    _extract_bedrock_total_tokens,
    _extract_bedrock_usage,
)
from eden_sdk.instrumentations.gemini import (
    _extract_gemini_total_tokens,
    _extract_gemini_usage,
)

# ── Bedrock ─────────────────────────────────────────────────────────


def test_bedrock_converse_top_level_usage():
    response = {
        "output": {"message": {"role": "assistant", "content": []}},
        "usage": {"inputTokens": 120, "outputTokens": 45, "totalTokens": 165},
        "stopReason": "end_turn",
    }
    out = _extract_bedrock_usage(response)
    assert out == {
        "input_tokens": 120,
        "output_tokens": 45,
        "cache_read_tokens": None,
        "cache_creation_tokens": None,
    }
    assert _extract_bedrock_total_tokens(response) == 165


def test_bedrock_converse_cache_read_and_write_fields():
    response = {
        "usage": {
            "inputTokens": 10,
            "outputTokens": 5,
            "cacheReadInputTokens": 200,
            "cacheWriteInputTokens": 50,
        }
    }
    out = _extract_bedrock_usage(response)
    assert out["cache_read_tokens"] == 200
    assert out["cache_creation_tokens"] == 50


def test_bedrock_invoke_model_anthropic_body_shape():
    response = {
        "body": {"usage": {"input_tokens": 30, "output_tokens": 12}},
        "contentType": "application/json",
    }
    out = _extract_bedrock_usage(response)
    assert out["input_tokens"] == 30
    assert out["output_tokens"] == 12


def test_bedrock_invoke_model_titan_body_shape():
    response = {
        "body": {
            "inputTextTokenCount": 88,
            "results": [{"tokenCount": 33, "outputText": "hi"}],
        }
    }
    out = _extract_bedrock_usage(response)
    assert out["input_tokens"] == 88
    assert out["output_tokens"] == 33


def test_bedrock_invoke_model_llama_body_shape():
    response = {"body": {"prompt_token_count": 14, "generation_token_count": 7}}
    out = _extract_bedrock_usage(response)
    assert out["input_tokens"] == 14
    assert out["output_tokens"] == 7


def test_bedrock_missing_or_garbage_response_returns_all_none():
    empty = {
        "input_tokens": None,
        "output_tokens": None,
        "cache_read_tokens": None,
        "cache_creation_tokens": None,
    }
    assert _extract_bedrock_usage(None) == empty
    assert _extract_bedrock_usage({}) == empty
    assert _extract_bedrock_usage({"body": "not a dict"}) == empty
    assert _extract_bedrock_total_tokens(None) is None
    assert _extract_bedrock_total_tokens({}) is None


# ── Gemini ────────────────────────────────────────────────────────


def test_gemini_dict_usage_metadata_camelcase():
    resp = {
        "candidates": [],
        "usageMetadata": {
            "promptTokenCount": 60,
            "candidatesTokenCount": 25,
            "totalTokenCount": 85,
        },
    }
    out = _extract_gemini_usage(resp)
    assert out == {
        "input_tokens": 60,
        "output_tokens": 25,
        "cache_read_tokens": None,
        "cache_creation_tokens": None,
    }
    assert _extract_gemini_total_tokens(resp) == 85


def test_gemini_sdk_object_usage_metadata_snake_case():
    """The legacy ``google-generativeai`` SDK returns
    ``GenerateContentResponse.usage_metadata`` as an attribute-bearing
    object with snake_case fields, not a dict."""
    usage_metadata = SimpleNamespace(
        prompt_token_count=11,
        candidates_token_count=4,
        total_token_count=15,
    )
    resp = SimpleNamespace(text="hi", usage_metadata=usage_metadata)
    out = _extract_gemini_usage(resp)
    assert out["input_tokens"] == 11
    assert out["output_tokens"] == 4
    assert _extract_gemini_total_tokens(resp) == 15


def test_gemini_cached_content_token_count_maps_to_cache_read():
    resp = {
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 20,
            "cachedContentTokenCount": 40,
        }
    }
    out = _extract_gemini_usage(resp)
    assert out["cache_read_tokens"] == 40


def test_gemini_missing_usage_metadata_returns_all_none():
    empty = {
        "input_tokens": None,
        "output_tokens": None,
        "cache_read_tokens": None,
        "cache_creation_tokens": None,
    }
    assert _extract_gemini_usage({}) == empty
    assert _extract_gemini_usage(None) == empty
    assert _extract_gemini_total_tokens({}) is None
    assert _extract_gemini_total_tokens(None) is None
