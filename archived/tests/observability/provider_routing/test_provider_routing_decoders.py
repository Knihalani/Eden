"""FEAT-138 — provider-routing ingestion decoder tests."""

from __future__ import annotations

import pytest

_TID = "00000000-0000-0000-0000-000000000033"
_SID = "00000000-0000-0000-0000-000000000034"


class TestLiteLLMDecoder:
    def test_decode_success_callback(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_litellm_payload,
        )

        payload = {
            "model": "gpt-4o-mini-2024-07-18",
            "custom_llm_provider": "openai",
            "response_time": 0.32,
            "status": "success",
            "metadata": {
                "trace_id": _TID,
                "span_id": _SID,
                "sequence_index": 0,
            },
        }
        decoded = decode_litellm_payload(payload)
        assert decoded["ignored"] is False
        assert decoded["router"] == "litellm"
        assert decoded["attempted_provider"] == "openai"
        assert decoded["attempted_model"] == "gpt-4o-mini-2024-07-18"
        assert decoded["decision"] == "success"
        assert decoded["latency_ms"] == 320
        assert decoded["failure_reason"] is None

    def test_decode_fallback_with_error(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_litellm_payload,
        )

        payload = {
            "model": "claude-3-5-sonnet-latest",
            "custom_llm_provider": "anthropic",
            "status": "failure",
            "error_str": "rate_limited",
            "fallback_key": "backup",
            "num_retries": 1,
            "metadata": {
                "trace_id": _TID,
                "span_id": _SID,
                "sequence_index": 1,
                "fallback_used": True,
            },
        }
        decoded = decode_litellm_payload(payload)
        assert decoded["ignored"] is False
        assert decoded["decision"] == "fallback"
        assert decoded["failure_reason"] == "rate_limited"
        assert decoded["sequence_index"] == 1

    def test_decode_missing_trace_context_is_ignored(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_litellm_payload,
        )

        decoded = decode_litellm_payload(
            {"model": "gpt-4o-mini", "custom_llm_provider": "openai"},
        )
        assert decoded["ignored"] is True


class TestPortkeyDecoder:
    def test_decode_response_headers(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_portkey_payload,
        )

        payload = {"model": "gpt-4o-mini-2024-07-18", "status": "success"}
        headers = {
            "x-portkey-provider": "openai",
            "x-portkey-model": "gpt-4o-mini-2024-07-18",
            "x-portkey-trace-id": _TID,
            "x-portkey-span-id": _SID,
            "x-portkey-retry-attempt-count": "0",
            "x-portkey-response-status": "success",
        }
        decoded = decode_portkey_payload(payload, headers=headers)
        assert decoded["ignored"] is False
        assert decoded["router"] == "portkey"
        assert decoded["attempted_provider"] == "openai"
        assert decoded["decision"] == "success"

    def test_decode_fallback_from_option_index(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_portkey_payload,
        )

        payload = {
            "model": "claude-3-5-sonnet-latest",
            "status": "success",
            "latency_ms": 450,
            "trace_id": _TID,
            "span_id": _SID,
            "sequence_index": 2,
        }
        headers = {
            "x-portkey-provider": "anthropic",
            "x-portkey-last-used-option-index": "2",
            "x-portkey-response-status": "fallback",
        }
        decoded = decode_portkey_payload(payload, headers=headers)
        assert decoded["ignored"] is False
        assert decoded["decision"] == "fallback"
        assert decoded["latency_ms"] == 450
        assert decoded["sequence_index"] == 2

    def test_decode_span_attributes(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_portkey_payload,
        )

        decoded = decode_portkey_payload(
            {},
            attributes={
                "portkey": {
                    "provider": "google",
                    "model": "gemini-1.5-pro",
                    "trace_id": _TID,
                    "span_id": _SID,
                    "latency_ms": 210,
                },
                "provider_routing": {"decision": "success", "sequence_index": 0},
            },
        )
        assert decoded["ignored"] is False
        assert decoded["attempted_provider"] == "google"
        assert decoded["latency_ms"] == 210


class TestOpenRouterDecoder:
    def test_decode_success_response(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_openrouter_payload,
        )

        payload = {
            "model": "anthropic/claude-3.5-sonnet",
            "provider": "Anthropic",
            "trace_id": _TID,
            "span_id": _SID,
            "latency_ms": 512,
            "route": {"type": "primary", "sequence_index": 0},
        }
        decoded = decode_openrouter_payload(payload)
        assert decoded["ignored"] is False
        assert decoded["router"] == "openrouter"
        assert decoded["attempted_provider"] == "Anthropic"
        assert decoded["decision"] == "success"
        assert decoded["latency_ms"] == 512

    def test_decode_failover_response(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_openrouter_payload,
        )

        payload = {
            "model": "openai/gpt-4o-mini",
            "provider": "OpenAI",
            "trace_id": _TID,
            "span_id": _SID,
            "route": {
                "type": "fallback",
                "sequence_index": 1,
                "retry_count": 1,
            },
        }
        decoded = decode_openrouter_payload(payload)
        assert decoded["ignored"] is False
        assert decoded["decision"] == "fallback"
        assert decoded["sequence_index"] == 1

    def test_decode_error_response(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_openrouter_payload,
        )

        payload = {
            "model": "anthropic/claude-3.5-sonnet",
            "provider": "Anthropic",
            "trace_id": _TID,
            "span_id": _SID,
            "error": {"message": "upstream timeout"},
        }
        decoded = decode_openrouter_payload(payload)
        assert decoded["ignored"] is False
        assert decoded["decision"] == "abort"
        assert decoded["failure_reason"] == "upstream timeout"


class TestDecoderDispatch:
    def test_detect_router_portkey(self):
        from eden.services.observability.provider_routing_decoders import detect_router

        assert detect_router({}, headers={"x-portkey-provider": "openai"}) == "portkey"

    def test_decode_provider_routing_payload_auto(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_provider_routing_payload,
        )

        decoded = decode_provider_routing_payload(
            "auto",
            {
                "custom_llm_provider": "openai",
                "model": "gpt-4o-mini",
                "metadata": {"trace_id": _TID, "span_id": _SID},
            },
        )
        assert decoded["ignored"] is False
        assert decoded["router"] == "litellm"

    def test_decode_provider_routing_payload_unknown_auto_is_ignored(self):
        from eden.services.observability.provider_routing_decoders import (
            decode_provider_routing_payload,
        )

        decoded = decode_provider_routing_payload("auto", {"foo": "bar"})
        assert decoded["ignored"] is True
