"""``compress_many`` / ``decompress_many`` only dispatch items with work to do.

Both used to hand every input to the thread pool, including the ones the
worker returns ``None`` for without touching zstd. A no-op dispatch still
costs a future, a queue hop and a GIL handoff — measured at ~6.4 us per item.
``_route_postgres`` compresses eight fields per event and a typical event
leaves most of them empty, so on an all-empty batch of eight the filter is
**98.6x** (51.5 -> 0.52 us); it falls to **1.02x** when every field is
populated, so it never costs anything.

The risk the filter introduces is not performance, it is *divergence*: the
skip predicate and the worker's own early return are two encodings of the same
rule, and if they drift apart the filter changes results instead of just
skipping dispatch. The first test below is the one that matters — it asserts
the two agree over a corpus that deliberately includes the awkward cases
(``0``, ``False``, ``""``, ``b""``, ``{}`` vs ``{"a": None}``) rather than
trusting them to stay aligned by inspection.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.storage import compression
from eden.storage.compression import (
    _compress_one,
    _is_trivial,
    compress_many,
    decompress_many,
)

# Includes every value whose truthiness and whose "is this empty" answer
# might reasonably be confused.
CORPUS: list[Any] = [
    None,
    {},
    [],
    0,
    0.0,
    False,
    "",
    "x",
    b"",
    {"a": None},
    {"a": 1},
    [0],
    [None],
    {"nested": {"deep": [1, 2, 3]}},
    "a" * 5000,
    {"big": ["v" * 200 for _ in range(60)]},
]


def test_the_skip_predicate_agrees_with_the_worker() -> None:
    """``_is_trivial(v)`` must be true exactly when ``_compress_one(v)`` is a
    no-op returning ``None``.

    If the predicate is broader than the worker's guard, real payloads are
    silently dropped to NULL. If it is narrower, nothing breaks but the
    optimisation stops applying. The first failure mode is data loss, so it is
    asserted directly rather than inferred from the batch results.
    """
    for value in CORPUS:
        worker_said_nothing_to_do = _compress_one(value) is None
        assert _is_trivial(value) == worker_said_nothing_to_do, (
            f"disagreement on {value!r}: _is_trivial={_is_trivial(value)} but "
            f"_compress_one returned "
            f"{'None' if worker_said_nothing_to_do else 'bytes'}. A predicate "
            "broader than the worker's guard silently drops payloads to NULL."
        )


def test_compress_many_output_is_unchanged_by_the_filter() -> None:
    """Same outputs, same order, same length — element by element."""
    filtered = compress_many(CORPUS)
    expected = [_compress_one(v) for v in CORPUS]
    assert filtered == expected
    assert len(filtered) == len(CORPUS)


def test_order_is_preserved_when_only_some_items_are_dispatched() -> None:
    """The filter reindexes; an off-by-one would put a payload on the wrong
    column, which is worse than a slow path."""
    payload = {"marker": "unique-value-42"}
    batch = [None, payload, {}, payload, [], None, payload]
    out = compress_many(batch)
    assert [o is None for o in out] == [
        True,
        False,
        True,
        False,
        True,
        True,
        False,
    ], f"non-None outputs landed at the wrong indices: {out!r}"
    # And each dispatched slot round-trips to the value that was at that index.
    for i in (1, 3, 6):
        assert compression.decompress_jsonb(out[i]) == payload


@pytest.mark.parametrize(
    "batch",
    [
        [],
        [None],
        [None] * 8,
        [{}, [], None],
    ],
    ids=["empty", "one-none", "all-empty", "mixed-empties"],
)
def test_batches_with_no_work_still_return_one_output_per_input(
    batch: list[Any],
) -> None:
    out = compress_many(batch)
    assert len(out) == len(batch)
    assert all(o is None for o in out)


def test_decompress_many_round_trips_a_sparse_batch() -> None:
    values = [{"a": 1}, None, {"b": [1, 2, 3]}, None, "x" * 4000]
    compressed = compress_many(values)
    assert decompress_many(compressed) == values


def test_decompress_many_preserves_positions() -> None:
    compressed = compress_many([None, {"k": "v"}, None])
    out = decompress_many(compressed)
    assert out == [None, {"k": "v"}, None]


@pytest.mark.parametrize(
    "batch",
    [[], [None], [b""], [None, b"", None]],
    ids=["empty", "none", "empty-bytes", "mixed"],
)
def test_decompress_batches_with_no_work(batch: list[Any]) -> None:
    out = decompress_many(batch)
    assert len(out) == len(batch)
    assert all(o is None for o in out)


def test_a_falsy_but_real_payload_is_not_skipped() -> None:
    """``0`` and ``False`` are falsy but are real values that must round-trip.

    ``_compress_one`` only treats ``None`` / ``{}`` / ``[]`` as empty, so a
    filter written as ``if not v`` rather than ``_is_trivial(v)`` would turn
    a stored ``0`` into NULL.
    """
    for value in (0, 0.0, False, "", b""):
        out = compress_many([value])
        assert out[0] is not None, (
            f"{value!r} was skipped as if it were empty; it is a real value "
            "and must be stored"
        )
    # Round-trip only the JSON-native ones. ``b""`` has no JSON
    # representation, so ``default=str`` stringifies it to ``"b''"`` -- lossy,
    # but that predates this change and is not what this test is about.
    for value in (0, 0.0, False, ""):
        out = compress_many([value])
        assert compression.decompress_jsonb(out[0]) == value
