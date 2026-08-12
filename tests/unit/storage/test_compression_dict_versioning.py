"""Dict-id versioning: archived dictionaries still decompress old frames."""

from __future__ import annotations

import json
from pathlib import Path

from eden.storage import compression
from eden.storage.compression import (
    compress_jsonb,
    decompress_jsonb,
    invalidate_caches,
    train_dictionary,
)
from eden.storage.zstd_registry import set_dicts_dir


def test_archived_dict_still_decompresses(tmp_path: Path) -> None:
    # Build a mini catalog with write dict id=10, then "retrain" to id=11
    # while archiving the old bytes — frames from id=10 must still round-trip.
    dicts = tmp_path / "zstd_dicts"
    archive = dicts / "archive"
    dicts.mkdir()
    archive.mkdir()

    samples = [
        json.dumps({"messages": [{"role": "user", "content": f"hello {i} " * 20}]}).encode()
        for i in range(200)
    ]
    old = train_dictionary(samples, dict_size=4096, dict_id=10)
    new = train_dictionary(samples, dict_size=4096, dict_id=11)
    (dicts / "request_body.bin").write_bytes(new)
    (archive / "request_body_v10.bin").write_bytes(old)
    # Minimal other dicts so registry loads
    for name, did in (("general", 1), ("response_body", 3), ("structured", 4)):
        (dicts / f"{name}.bin").write_bytes(
            train_dictionary(samples[:120], dict_size=2048, dict_id=did)
        )
    (dicts / "catalog.json").write_text(
        json.dumps(
            {
                "version": 2,
                "write": {
                    "request_body": "request_body",
                    "_default": "general",
                    "response_body": "response_body",
                    "reasoning": "response_body",
                    "tool_calls_full": "structured",
                    "tool_results": "structured",
                    "payload": "structured",
                    "metrics": "structured",
                    "attributes": "structured",
                },
                "dicts": {
                    "general": {"file": "general.bin", "dict_id": 1},
                    "request_body": {"file": "request_body.bin", "dict_id": 11},
                    "response_body": {"file": "response_body.bin", "dict_id": 3},
                    "structured": {"file": "structured.bin", "dict_id": 4},
                },
            }
        )
    )

    set_dicts_dir(dicts)
    invalidate_caches()

    # Simulate a frame written under the archived dict (id=10).
    import zstandard as zstd

    old_z = zstd.ZstdCompressionDict(old)
    frame = zstd.ZstdCompressor(dict_data=old_z, level=5).compress(samples[0])
    assert zstd.get_frame_parameters(frame).dict_id == 10
    assert decompress_jsonb(frame) == json.loads(samples[0])

    # New writes use id=11
    payload = {"messages": [{"role": "user", "content": "fresh " * 30}]}
    stored = compress_jsonb(payload, column="request_body")
    assert stored.startswith(compression.ZSTD_MAGIC)
    assert zstd.get_frame_parameters(stored).dict_id == 11
    assert decompress_jsonb(stored) == payload

    set_dicts_dir(None)
    invalidate_caches()
