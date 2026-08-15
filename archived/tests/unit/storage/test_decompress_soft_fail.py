"""Corrupt / wrong-dict zstd frames must not abort ``decompress_many``.

Portal ``get_trace_tree`` used to raise ``Dictionary mismatch`` from a
single bad ``*_zstd`` column and return HTTP 200 with ``steps=[]``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import zstandard as zstd

from eden.storage import compression

PAYLOAD: dict[str, Any] = {
    "messages": [{"role": "user", "content": "hello world " * 40}],
    "model": "test-model",
}


@pytest.fixture(autouse=True)
def _clean_caches():
    from eden.storage.zstd_registry import set_dicts_dir

    set_dicts_dir(Path("/nonexistent_eden_zstd_dicts_for_tests"))
    compression.invalidate_caches()
    yield
    set_dicts_dir(None)
    compression.invalidate_caches()


def _train(seed: str, tmp_path: Path, name: str) -> Path:
    samples = [
        json.dumps({"k": f"{seed}-{i}", "body": f"{seed} sample text " * 12}).encode()
        for i in range(256)
    ]
    path = tmp_path / name
    path.write_bytes(compression.train_dictionary(samples, dict_size=4096))
    return path


def test_decompress_many_returns_none_for_foreign_dict_frame(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dict_a = _train("alpha", tmp_path, "a.bin")
    dict_b = _train("beta", tmp_path, "b.bin")

    monkeypatch.setattr(compression, "DICT_PATH", dict_a)
    compression._force_legacy_dict(dict_a)
    under_a = compression.compress_jsonb(PAYLOAD)
    assert under_a is not None

    monkeypatch.setattr(compression, "DICT_PATH", dict_b)
    compression._force_legacy_dict(dict_b)

    # Pre-fix this raised ZstdError and aborted the whole batch.
    out = compression.decompress_many([under_a, None, compression.compress_jsonb(PAYLOAD)])
    assert out[0] is None
    assert out[1] is None
    assert out[2] == PAYLOAD


def test_decompress_one_does_not_raise_on_garbage() -> None:
    # Not a valid zstd frame and too large for the small-JSON fast path.
    garbage = b"\x28\xb5\x2f\xfd" + b"not-a-frame" * 20
    assert compression._decompress_one(garbage) is None


def test_raw_decompressor_still_raises_for_incompatible_dicts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Low-level API keeps raising; only the batch soft-fail path swallows."""
    dict_a = _train("alpha", tmp_path, "a.bin")
    dict_b = _train("beta", tmp_path, "b.bin")

    monkeypatch.setattr(compression, "DICT_PATH", dict_a)
    compression._force_legacy_dict(dict_a)
    under_a = compression.compress_jsonb(PAYLOAD)

    monkeypatch.setattr(compression, "DICT_PATH", dict_b)
    compression._force_legacy_dict(dict_b)
    with pytest.raises(zstd.ZstdError):
        compression._decompressor().decompress(under_a)
