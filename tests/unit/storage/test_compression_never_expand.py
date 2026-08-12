"""Tests for never-expand + magic-byte decompress (compression v1.9)."""

from __future__ import annotations

import json

from eden.storage.compression import (
    ZSTD_MAGIC,
    compress_jsonb,
    compress_many,
    decompress_jsonb,
    decompress_many,
)


def test_never_expand_on_high_entropy_payload() -> None:
    """High-entropy blobs must not grow under zstd — store raw JSON instead."""
    payload = {"blob": "a1b2c3d4" * 400}  # ~3.2 KB hex-ish
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    stored = compress_jsonb(payload)
    assert len(stored) <= len(raw)
    # Either a zstd win or raw JSON; never larger.
    assert decompress_jsonb(stored) == payload


def test_compressible_payload_still_uses_zstd_frame() -> None:
    payload = {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. " * 20},
            {"role": "user", "content": "Explain PostgreSQL indexes. " * 30},
            {"role": "assistant", "content": "Indexes speed up lookups. " * 30},
        ],
    }
    stored = compress_jsonb(payload)
    assert stored.startswith(ZSTD_MAGIC)
    assert decompress_jsonb(stored) == payload


def test_magic_byte_reader_accepts_large_raw_json() -> None:
    """Never-expand can store raw JSON larger than SMALL_PAYLOAD_BYTES."""
    payload = {"ids": [f"{i:032x}" for i in range(80)]}
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    assert len(raw) >= 40
    assert not raw.startswith(ZSTD_MAGIC)
    assert decompress_jsonb(raw) == payload


def test_batch_path_matches_single_never_expand() -> None:
    payloads = [
        {"msg": "hello " * 50},
        {"blob": "".join(f"{i%16:x}" for i in range(3000))},
        {"metrics": {"latency_ms": 12.5, "tokens": 42}},
    ]
    batch = compress_many(payloads)
    singles = [compress_jsonb(p) for p in payloads]
    assert batch == singles
    assert decompress_many(batch) == payloads
