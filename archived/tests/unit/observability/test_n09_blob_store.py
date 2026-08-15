"""N09 — content-addressed blob store tests."""

from __future__ import annotations

from unittest.mock import patch

from eden.observability.compression.blob_store import (
    MIN_BLOB_SIZE,
    BlobStore,
    get_blob_store,
    normalize_content,
    reset_blob_store,
)

SYSTEM_PROMPT = (
    "You are a careful coding agent. " * 40
)  # >512 bytes after normalize


def test_min_blob_size_constant() -> None:
    assert MIN_BLOB_SIZE == 512


def test_small_blobs_inline() -> None:
    store = BlobStore()
    ref = store.get_or_put("org", "tiny", content_type="other")
    assert ref.inline
    assert store.stats()["inlines"] == 1


def test_repeated_system_prompt_dedupes() -> None:
    store = BlobStore()
    r1 = store.get_or_put("org", SYSTEM_PROMPT, content_type="system_prompt")
    r2 = store.get_or_put("org", SYSTEM_PROMPT, content_type="system_prompt")
    assert not r1.inline
    assert not r2.inline
    assert r1.content_hash == r2.content_hash
    assert r2.reused
    assert store.stats()["puts"] == 1
    assert store.stats()["reuses"] == 1
    # Synthetic workload: same prompt 10× → ratio ≥3× on stored bytes vs seen
    for _ in range(8):
        store.get_or_put("org", SYSTEM_PROMPT, content_type="system_prompt")
    assert store.dedupe_ratio() >= 3.0


def test_whitespace_normalized_system_prompt() -> None:
    store = BlobStore()
    a = "  hello   world  " + (" x" * 300)
    b = "hello world" + (" x" * 300)
    r1 = store.get_or_put("org", a, content_type="system_prompt")
    r2 = store.get_or_put("org", b, content_type="system_prompt")
    assert r1.content_hash == r2.content_hash


def test_tool_schema_key_order_invariant() -> None:
    store = BlobStore()
    schema_a = {"name": "search", "parameters": {"type": "object", "z": 1, "a": 2}}
    schema_b = {"parameters": {"a": 2, "type": "object", "z": 1}, "name": "search"}
    # Pad to min size
    schema_a["description"] = "x" * 600
    schema_b["description"] = "x" * 600
    r1 = store.get_or_put("org", schema_a, content_type="tool_schema")
    r2 = store.get_or_put("org", schema_b, content_type="tool_schema")
    assert r1.content_hash == r2.content_hash
    assert r2.reused


def test_get_round_trip() -> None:
    store = BlobStore()
    ref = store.get_or_put("org", SYSTEM_PROMPT, content_type="system_prompt")
    got = store.get("org", ref.content_hash)
    assert got is not None
    assert normalize_content(SYSTEM_PROMPT, "system_prompt") == got


def test_dedupe_disabled_inlines() -> None:
    reset_blob_store()
    store = BlobStore()
    with patch.object(store, "enabled", return_value=False):
        ref = store.get_or_put("org", SYSTEM_PROMPT, content_type="system_prompt")
    assert ref.inline
    assert store.stats()["inlines"] == 1


def test_org_isolation() -> None:
    store = BlobStore()
    r1 = store.get_or_put("org-a", SYSTEM_PROMPT, content_type="system_prompt")
    r2 = store.get_or_put("org-b", SYSTEM_PROMPT, content_type="system_prompt")
    assert r1.content_hash == r2.content_hash
    assert not r2.reused  # different org namespace
    assert store.get("org-a", r1.content_hash) is not None
    assert store.get("org-b", r2.content_hash) is not None


def test_get_blob_store_singleton() -> None:
    reset_blob_store()
    assert get_blob_store() is get_blob_store()
    reset_blob_store()


def test_zstd_path_still_importable() -> None:
    """N09 sits on top of the shipped zstd compressor — must remain."""
    from eden.storage.compression import compress_jsonb, decompress_jsonb

    payload = {"messages": [{"role": "system", "content": SYSTEM_PROMPT}]}
    blob = compress_jsonb(payload)
    assert isinstance(blob, (bytes, bytearray))
    assert decompress_jsonb(blob) == payload
