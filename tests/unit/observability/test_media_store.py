"""Tests for the MediaStore (Phase 7.2a — media blob storage).

These tests focus on the path-safety and dedup logic that runs in
isolation. The integration with settings is exercised separately
via the API route tests.
"""

import asyncio
import os
import sys
import tempfile

import pytest

sys.path.insert(0, "src")

from eden.observability.media_store import (
    MediaStore,
    MediaBlob,
    _safe_tenant,
)


# We construct a MediaStore directly with a config that doesn't
# require reading from the global settings — the global settings may
# be frozen by pydantic v2 in the test runner.
def _local_store(tmpdir: str) -> MediaStore:
    store = MediaStore.__new__(MediaStore)
    store.backend = "local"
    store._local_root = tmpdir
    os.makedirs(tmpdir, exist_ok=True)
    return store


@pytest.mark.asyncio
async def test_put_and_get_roundtrip():
    with tempfile.TemporaryDirectory() as tmp:
        store = _local_store(tmp)
        data = b"PNG fake bytes for testing"
        blob = await store.put(
            tenant_id="t1", event_id="e1",
            media_type="image_input", content_type="image/png",
            data=data, metadata={"role": "user"},
        )
        assert blob.blob_id
        assert blob.sha256
        assert blob.size_bytes == len(data)
        assert blob.storage_uri.startswith("local://")
        out = await store.get(blob)
        assert out == data


@pytest.mark.asyncio
async def test_dedup_within_tenant():
    with tempfile.TemporaryDirectory() as tmp:
        store = _local_store(tmp)
        data = b"identical bytes"
        b1 = await store.put(
            tenant_id="t1", event_id="e1", media_type="image_input",
            content_type="image/png", data=data,
        )
        b2 = await store.put(
            tenant_id="t1", event_id="e2", media_type="image_input",
            content_type="image/png", data=data,
        )
        # Same SHA-256, same path
        assert b1.sha256 == b2.sha256
        assert b1.storage_uri == b2.storage_uri
        # But distinct blob_ids (each put returns a new UUID)
        assert b1.blob_id != b2.blob_id
        # Only one file on disk
        rel = b1.storage_uri[len("local://"):]
        full_path = os.path.join(tmp, rel)
        assert os.path.exists(full_path)


@pytest.mark.asyncio
async def test_cross_tenant_separation():
    with tempfile.TemporaryDirectory() as tmp:
        store = _local_store(tmp)
        data = b"shared bytes"
        b1 = await store.put(
            tenant_id="alice", event_id="e1", media_type="image_input",
            content_type="image/png", data=data,
        )
        b2 = await store.put(
            tenant_id="bob", event_id="e1", media_type="image_input",
            content_type="image/png", data=data,
        )
        # Different paths because of different tenant prefixes
        assert b1.storage_uri != b2.storage_uri
        assert "alice" in b1.storage_uri
        assert "bob" in b2.storage_uri


def test_safe_tenant_strips_traversal():
    """A tenant_id like '../etc/passwd' must be sanitized so a
    malformed value can't escape the storage root."""
    sanitized = _safe_tenant("../etc/passwd")
    assert "/" not in sanitized
    assert ".." not in sanitized
    # Sanity: legitimate tenant IDs are preserved (alnum + - + _)
    assert _safe_tenant("tenant-1") == "tenant-1"
    # Dots are not in the allowlist — they get replaced.
    assert _safe_tenant("acme.corp_42") == "acme_corp_42"
