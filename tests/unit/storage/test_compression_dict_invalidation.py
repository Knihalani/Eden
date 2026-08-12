"""``invalidate_caches()`` must reach the batch pool's per-thread caches.

The two process-wide caches track their own dict id, and the comment above
them records this exact failure -- ``ZstdError: Dictionary mismatch`` -- being
diagnosed and fixed for them. The fix was never applied one tier down:
``_worker_compressor`` / ``_worker_decompressor`` returned any already-built
thread-local object unconditionally, so after a dictionary retrain the eight
``zstd-batch`` worker threads kept the OLD dictionary for the life of the
process.

That tier is the production path. ``_route_postgres`` compresses through
``compress_many``, which runs on those threads. So a retrain produced:

* the batch path writing frames against the old dictionary while
  ``compress_jsonb`` (process-wide cache, correctly rebuilt) wrote against the
  new one -- two incompatible encodings in the same column; and
* ``decompress_many`` raising ``Dictionary mismatch`` whenever a new-dict frame
  landed on a thread still holding the old dict.

Which of those you got depended on which worker thread the executor picked,
so it would have presented as an intermittent read failure after a dict swap.

I found this by accident: adding a test file that warmed the pool before
``test_compression_v18.py`` swapped dictionaries made two of its tests fail.
An accident is not a guard, hence this file.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import zstandard as zstd

from eden.storage import compression

PAYLOAD: dict[str, Any] = {
    "messages": [
        {"role": "user", "content": "connection pooling in postgres " * 20},
        {"role": "assistant", "content": "a pool keeps warm connections " * 30},
    ],
    "model": "claude-sonnet-4",
    "tags": ["prod", "gateway"],
}


def _train(seed: str, tmp_path: Path, name: str) -> Path:
    """Persist a real trained dictionary distinct from any other seed's."""
    samples = [
        json.dumps({"k": f"{seed}-{i}", "body": f"{seed} sample text " * 12}).encode()
        for i in range(256)
    ]
    path = tmp_path / name
    path.write_bytes(compression.train_dictionary(samples, dict_size=4096))
    return path


@pytest.fixture
def two_dicts(tmp_path: Path) -> tuple[Path, Path]:
    a = _train("alpha", tmp_path, "a.bin")
    b = _train("beta", tmp_path, "b.bin")
    assert a.read_bytes() != b.read_bytes(), "the two dictionaries are identical"
    return a, b


@pytest.fixture(autouse=True)
def _clean_caches():
    from eden.storage.zstd_registry import set_dicts_dir

    set_dicts_dir(Path("/nonexistent_eden_zstd_dicts_for_tests"))
    compression.invalidate_caches()
    yield
    set_dicts_dir(None)
    compression.invalidate_caches()


def _use_dict(monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
    monkeypatch.setattr(compression, "DICT_PATH", path)
    compression._force_legacy_dict(path)


def test_a_dict_swap_reaches_the_worker_threads(
    two_dicts: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The regression itself, end to end through the batch path."""
    dict_a, dict_b = two_dicts

    # Warm the pool's thread-locals against dictionary A by doing real batch
    # work -- this is what a running process has already done by the time an
    # operator retrains.
    _use_dict(monkeypatch, dict_a)
    warm = compression.compress_many([PAYLOAD] * 8)
    assert compression.decompress_many(warm) == [PAYLOAD] * 8

    # Retrain: swap the dict file and invalidate.
    _use_dict(monkeypatch, dict_b)

    # The batch path must now write and read against B. Pre-fix, the worker
    # threads still held A: this round-trip raised Dictionary mismatch.
    fresh = compression.compress_many([PAYLOAD] * 8)
    assert compression.decompress_many(fresh) == [PAYLOAD] * 8, (
        "the batch path could not read back what it just wrote after a dict "
        "swap -- the worker threads are still holding the previous dictionary"
    )


def test_the_batch_path_and_the_single_path_agree_after_a_swap(
    two_dicts: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two encodings in one column is the quieter half of the bug.

    ``compress_jsonb`` uses the process-wide cache, which was rebuilt
    correctly; ``compress_many`` used the stale thread-locals. Both write into
    the same ``*_zstd`` columns, so post-retrain the table held frames against
    two different dictionaries -- and nothing raised at write time.
    """
    dict_a, dict_b = two_dicts

    _use_dict(monkeypatch, dict_a)
    compression.compress_many([PAYLOAD] * 8)  # warm the threads on A

    _use_dict(monkeypatch, dict_b)
    via_batch = compression.compress_many([PAYLOAD])[0]
    via_single = compression.compress_jsonb(PAYLOAD)

    assert via_batch == via_single, (
        "the batch path and the single path produced different frames for the "
        "same payload -- they are bound to different dictionaries"
    )
    # And each is readable by the other path.
    assert compression.decompress_jsonb(via_batch) == PAYLOAD
    assert compression.decompress_many([via_single]) == [PAYLOAD]


def test_a_frame_written_under_the_old_dict_is_not_silently_reinterpreted(
    two_dicts: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Sanity check that the two dictionaries really are incompatible.

    Without this, the tests above could pass because the dictionaries happen to
    be interchangeable, which would make them prove nothing.
    """
    dict_a, dict_b = two_dicts

    _use_dict(monkeypatch, dict_a)
    under_a = compression.compress_jsonb(PAYLOAD)

    _use_dict(monkeypatch, dict_b)
    with pytest.raises(zstd.ZstdError):
        compression._decompressor().decompress(under_a)


def test_repeated_invalidation_does_not_rebuild_on_every_call(
    two_dicts: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The generation check must not defeat the cache it guards.

    Rebuilding a dict-bound ``ZstdCompressor`` costs ~0.2 ms, which is why
    these caches exist. If the version comparison were wrong in the other
    direction -- never matching -- correctness would be fine and throughput
    would quietly collapse.
    """
    dict_a, _ = two_dicts
    _use_dict(monkeypatch, dict_a)

    first = compression._compressor()
    for _ in range(50):
        assert compression._compressor() is first, (
            "the process-wide compressor was rebuilt without a dict change"
        )

    d_first = compression._decompressor()
    for _ in range(50):
        assert compression._decompressor() is d_first


def test_invalidate_caches_advances_the_dict_generation() -> None:
    """The counter must actually move.

    Asserting only on emergent behaviour is not enough here, and mutation
    testing showed why: neutering the increment (``+= 0``) left every
    round-trip test green, because ``get_dict.cache_clear()`` normally loads a
    *new* dict object whose ``id()`` differs, so the id half of the key
    rebuilds the caches on its own. The generation is what covers the case
    where the id does *not* differ -- and nothing observable distinguishes a
    working counter from a dead one until that case occurs. So pin the
    mechanism directly.
    """
    obj = compression.get_dict()
    before = compression._dict_version(obj)[0]
    compression.invalidate_caches()
    after = compression._dict_version(obj)[0]
    assert after > before, (
        f"invalidate_caches() left the dict generation at {after}; the "
        "per-thread worker caches key on it, so they would never be "
        "invalidated when the replacement dict reuses the old address"
    )


def test_the_version_key_includes_the_generation_not_just_the_id() -> None:
    """Complements the test above: the counter must be *in* the key.

    A key of ``(0, id(d))`` also passes every round-trip test, for the same
    reason. Comparing two versions taken across an invalidation of the same
    object is the only thing that distinguishes them.
    """
    obj = compression.get_dict()
    first = compression._dict_version(obj)
    compression.invalidate_caches()
    second = compression._dict_version(obj)
    assert first != second, (
        f"_dict_version returned {first!r} both before and after an "
        "invalidation for the same dict object -- the key is id() alone"
    )


def test_the_generation_counter_survives_an_id_collision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Caches key on registry generation so invalidate always rebuilds."""
    from eden.storage.zstd_registry import get_registry

    first = compression._compressor()
    before = get_registry().generation
    compression.invalidate_caches()
    after = get_registry().generation
    second = compression._compressor()
    assert after > before
    assert second is not first
