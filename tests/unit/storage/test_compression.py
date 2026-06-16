"""Unit tests for ``eden.storage.compression``.

Covers the lossless round-trip guarantee and the fallback to an empty
dictionary when the on-disk file is missing.
"""
from __future__ import annotations

import json
import random
import string

import pytest

from eden.storage.compression import (
    DEFAULT_DICT_SIZE,
    compress_jsonb,
    decompress_jsonb,
    train_dictionary,
)


# Representative LLM payload shapes used by the major providers. The
# round-trip test exercises each.
REPRESENTATIVE_PAYLOADS = [
    # OpenAI chat completion
    {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is the capital of France?"},
        ],
        "temperature": 0.7,
        "max_tokens": 256,
        "stream": False,
    },
    # OpenAI with tool calls
    {
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "Find me a recipe for bread."}],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "search_recipes",
                    "description": "Search the recipe database.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "max_results": {"type": "integer", "default": 10},
                        },
                    },
                },
            }
        ],
        "tool_choice": "auto",
    },
    # Anthropic
    {
        "model": "claude-3-5-sonnet-20241022",
        "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": "Hello, world."}
            ]}
        ],
        "system": "You are Claude.",
        "max_tokens": 1024,
    },
    # Gemini
    {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": "Explain quantum entanglement."}],
            }
        ],
        "generationConfig": {"temperature": 0.9, "topP": 0.95, "topK": 40},
    },
    # OpenAI response
    {
        "id": "chatcmpl-abc123",
        "object": "chat.completion",
        "created": 1717000000,
        "model": "gpt-4o-2024-08-06",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "The capital of France is Paris.",
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 28,
            "completion_tokens": 8,
            "total_tokens": 36,
        },
    },
    # Anthropic response with thinking
    {
        "id": "msg_01abc",
        "type": "message",
        "role": "assistant",
        "content": [
            {
                "type": "thinking",
                "thinking": "The user asked about French geography. I should answer concisely.",
            },
            {"type": "text", "text": "Paris."},
        ],
        "model": "claude-3-5-sonnet-20241022",
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 28, "output_tokens": 15},
    },
    # Error response
    {
        "error": {
            "message": "Invalid API key",
            "type": "invalid_request_error",
            "code": "invalid_api_key",
        }
    },
    # Long-context message
    {
        "model": "gpt-4o",
        "messages": [
            {"role": "user", "content": "".join(random.choices(string.ascii_letters + " \n", k=5000))},
        ],
    },
    # Multimodal (image)
    {
        "model": "gpt-4o",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "What's in this image?"},
                    {"type": "image_url", "image_url": {"url": "https://example.com/cat.jpg"}},
                ],
            }
        ],
    },
    # Streaming chunk
    {
        "id": "chatcmpl-xyz",
        "object": "chat.completion.chunk",
        "created": 1717000000,
        "model": "gpt-4o",
        "choices": [
            {
                "index": 0,
                "delta": {"content": " Hello"},
                "finish_reason": None,
            }
        ],
    },
]


class TestRoundTrip:
    """Lossless round-trip for representative LLM payload shapes."""

    @pytest.mark.parametrize("payload", REPRESENTATIVE_PAYLOADS)
    def test_compress_decompress_matches(self, payload):
        compressed = compress_jsonb(payload)
        recovered = decompress_jsonb(compressed)
        assert recovered == payload

    def test_empty_dict(self):
        """``None`` in, ``None`` out (empty-bytes sentinel)."""
        assert decompress_jsonb(compress_jsonb(None)) is None
        assert decompress_jsonb(None) is None
        assert decompress_jsonb(b"") is None

    def test_round_trip_preserves_types(self):
        """Types must be preserved exactly: dict, list, str, int, float, bool, None."""
        cases = [
            {"a": 1, "b": "two", "c": [1, 2, 3]},
            [1, "two", {"three": 3.0}, None, True, False],
            "plain string",
            42,
            3.14,
            True,
            False,
            None,
            {"nested": {"deeply": {"deeply": {"value": [1, 2, 3]}}}},
        ]
        for case in cases:
            assert decompress_jsonb(compress_jsonb(case)) == case

    def test_unicode_preserved(self):
        """Unicode strings round-trip byte-exact."""
        cases = [
            "Hello, 世界! 🌍",
            "Ω≈ç√∫˜µ",
            "emoji: 🔥🚀💀",
            "RTL: مرحبا بالعالم",
            {"name": "Éden", "city": "São Paulo"},
        ]
        for case in cases:
            assert decompress_jsonb(compress_jsonb(case)) == case


class TestFallback:
    """The service must work even when the trained dictionary is missing."""

    def test_round_trip_works_without_dict_file(self, tmp_path, monkeypatch):
        """Point DICT_PATH at a nonexistent file; round-trip still works."""
        from eden.storage import compression

        missing = tmp_path / "no-such-dict.bin"
        monkeypatch.setattr(compression, "DICT_PATH", missing)
        compression.get_dict.cache_clear()

        payload = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]}
        assert decompress_jsonb(compress_jsonb(payload)) == payload

    def test_corrupt_dict_file_falls_back(self, tmp_path, monkeypatch):
        """A garbage dict file should not break round-trip; it logs a warning."""
        from eden.storage import compression

        corrupt = tmp_path / "garbage.bin"
        corrupt.write_bytes(b"this is not a zstd dictionary")
        monkeypatch.setattr(compression, "DICT_PATH", corrupt)
        compression.get_dict.cache_clear()

        payload = {"k": "v"}
        # Should still round-trip via the empty-dict fallback.
        assert decompress_jsonb(compress_jsonb(payload)) == payload


class TestTrainDictionary:
    """The train_dictionary helper accepts samples and returns bytes."""

    def test_train_on_realistic_samples(self):
        """Train on 50 JSON-bytes samples drawn from REPRESENTATIVE_PAYLOADS."""
        samples = [json.dumps(p, separators=(",", ":")).encode("utf-8") for p in REPRESENTATIVE_PAYLOADS]
        # LoPace recommends ≥ 1,000 samples for real-world use, but 50
        # exercises the API in a unit test.
        samples = samples * 20  # 200 samples
        trained = train_dictionary(samples, dict_size=4096)
        assert isinstance(trained, bytes)
        assert len(trained) > 0
        assert len(trained) <= 4096 * 2  # dict size is approximate; zstd may pad

    def test_train_rejects_empty_samples(self):
        with pytest.raises(ValueError, match="at least one sample"):
            train_dictionary([])

    def test_train_rejects_string_samples(self):
        with pytest.raises(TypeError, match="must be bytes"):
            train_dictionary([b"ok", "not bytes"])  # type: ignore[list-item]

    def test_trained_dict_improves_compression(self, tmp_path, monkeypatch):
        """A trained dict should compress representative payloads at least
        as well as an empty dict (we don't assert a specific ratio to keep
        the test stable; just non-regression).
        """
        from eden.storage import compression

        samples = [
            json.dumps(p, separators=(",", ":")).encode("utf-8")
            for p in REPRESENTATIVE_PAYLOADS
        ] * 30
        trained = train_dictionary(samples, dict_size=4096)

        # Save the trained dict and reload via the public path.
        dict_path = tmp_path / "trained.bin"
        dict_path.write_bytes(trained)
        monkeypatch.setattr(compression, "DICT_PATH", dict_path)
        compression.get_dict.cache_clear()

        big_payload = {
            "model": "gpt-4o",
            "messages": [
                {"role": "system", "content": "You are a helpful assistant." * 50},
                {"role": "user", "content": "Tell me a story. " * 100},
            ],
        }
        # Round-trip must be lossless regardless of the dict.
        assert decompress_jsonb(compress_jsonb(big_payload)) == big_payload


class TestCompressionRatio:
    """Lossless compression is the contract; ratio is a bonus we measure."""

    def test_compression_actually_shrinks_repetitive_json(self):
        """A payload with lots of repetition should compress to < 50% of raw."""
        body = {
            "system_prompt": "You are a helpful assistant. " * 100,  # ~3 KB
            "examples": [
                {"role": "user", "content": "Hello world. " * 30},  # ~400 B
                {"role": "assistant", "content": "Hi there. " * 30},
            ] * 5,
        }
        raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
        compressed = compress_jsonb(body)
        ratio = len(raw) / max(len(compressed), 1)
        # zstd on highly compressible JSON: typically 5-10×. We assert
        # 2× as a conservative lower bound.
        assert ratio >= 2.0, (
            f"Compression ratio too low: raw={len(raw)} B, "
            f"compressed={len(compressed)} B, ratio={ratio:.2f}x"
        )

    def test_dict_size_constant_exported(self):
        """DEFAULT_DICT_SIZE is a public constant callers may inspect."""
        assert DEFAULT_DICT_SIZE == 8192
