"""The JSON codec inside the zstd columns: orjson to write, stdlib to read.

``_to_json_bytes`` moved from ``json.dumps(...).encode()`` to
``jsonx.dumps_bytes`` -- 3.42x on a span-metadata dict (5.669 -> 1.657 us) and
5.09x on three chat messages (4.271 -> 0.839 us), byte-identical output, and as
a side benefit it stops writing bare ``NaN``/``Infinity`` (a Python-ism, not
JSON) into the ``*_zstd`` columns.

The two asymmetries that come with it are the point of this file. Both are
decisions with a cost if reversed, and neither is visible from reading the
happy path:

* **The writer keeps a stdlib fallback.** orjson raises on integers >= 2**64
  where stdlib serialises them. This is a persistence path fed by
  user-supplied ``metadata``, so an unguarded raise turns a storable event
  into a dropped one.
* **The reader stays on stdlib.** ``orjson.loads`` rejects the bare ``NaN``
  that ``json.dumps`` used to emit, so switching it would make historical rows
  undecodable. ``json.loads`` reads both encodings; orjson reads only one.
"""

from __future__ import annotations

import json
import math
from typing import Any

import pytest

from eden.storage import compression
from eden.storage.compression import (
    SMALL_PAYLOAD_BYTES,
    _from_json_bytes,
    _to_json_bytes,
    compress_jsonb,
    decompress_jsonb,
)


class TestWriter:
    @pytest.mark.parametrize(
        "payload",
        [
            {"model": "claude", "usage": {"in": 10, "out": 20}},
            [1, 2, 3, {"a": "b"}],
            {"empty_str": "", "zero": 0, "false": False, "null": None},
        ],
        ids=["dict", "list", "falsy-values"],
    )
    def test_ascii_output_matches_the_stdlib_encoding_it_replaced(
        self, payload: Any
    ) -> None:
        """Byte-identical for ASCII payloads, which is most of them.

        Scoped to ASCII deliberately: see the non-ASCII test below for the one
        difference, which I initially missed by only measuring ASCII.
        """
        assert _to_json_bytes(payload) == json.dumps(
            payload, default=str, separators=(",", ":")
        ).encode("utf-8"), f"encoding diverged for {payload!r}"

    @pytest.mark.parametrize(
        "text",
        ["ünïcødé ✓", "こんにちは、世界。" * 8, "🎉🚀✨" * 40, "café naïve über" * 30],
        ids=["accented", "japanese", "emoji", "mixed"],
    )
    def test_non_ascii_is_raw_utf8_and_smaller(self, text: str) -> None:
        """The one intentional encoding difference, and it is a win.

        ``json.dumps`` defaults to ``ensure_ascii=True``, escaping every
        non-ASCII character as ``\\uXXXX`` -- up to 6 bytes for what UTF-8
        stores in 2-4. orjson emits raw UTF-8: same decoded value, 1.65x-2.69x
        fewer bytes before zstd. Pinned so that a future switch back to
        ``ensure_ascii`` output shows up as a regression rather than as a
        quietly larger table.
        """
        payload = {"msg": text}
        new = _to_json_bytes(payload)
        old = json.dumps(payload, default=str, separators=(",", ":")).encode()

        assert json.loads(new) == json.loads(old) == payload, (
            "the two encodings do not decode to the same value"
        )
        assert b"\\u" not in new, f"non-ASCII was escaped rather than encoded: {new[:80]!r}"
        assert len(new) < len(old), (
            f"expected raw UTF-8 to be smaller than escaped: {len(new)} vs {len(old)}"
        )

    def test_an_oversized_int_falls_back_instead_of_raising(self) -> None:
        """orjson raises ``TypeError: Integer exceeds 64-bit range``.

        User ``metadata`` is arbitrary JSON, so this is reachable from the
        outside. Unguarded, the event is dropped rather than stored -- and
        because the ingest path is fail-soft, dropped quietly.
        """
        payload = {"huge": 2**64, "also": 2**200, "normal": 42}
        raw = _to_json_bytes(payload)
        assert json.loads(raw) == payload, (
            "an integer beyond orjson's range was not preserved; the stdlib "
            "fallback in _to_json_bytes is missing or unreachable"
        )

    def test_an_oversized_int_round_trips_through_the_real_column_path(
        self,
    ) -> None:
        """The fallback has to hold through compress/decompress, not just the
        helper -- that is the path an ingested event actually takes."""
        payload = {"token_id": 2**70, "note": "x" * 200}
        assert decompress_jsonb(compress_jsonb(payload)) == payload

    def test_non_finite_floats_are_written_as_valid_json(self) -> None:
        """stdlib emitted bare ``NaN`` / ``Infinity``, which no strict parser
        accepts -- it was being persisted into the zstd columns."""
        raw = _to_json_bytes({"a": float("nan"), "b": float("inf")})
        assert b"NaN" not in raw and b"Infinity" not in raw, (
            f"invalid JSON written: {raw!r}"
        )
        # Valid enough for a strict parser.
        import orjson

        assert orjson.loads(raw) == {"a": None, "b": None}

    def test_finite_floats_are_untouched(self) -> None:
        payload = {"cost": 0.004128, "latency": 1832.44, "neg": -0.5}
        assert decompress_jsonb(compress_jsonb(payload)) == payload


class TestReader:
    def test_a_legacy_nan_frame_is_still_decodable(self) -> None:
        """The reason the reader must stay on stdlib.

        Frames already in ``*_zstd`` columns were written by ``json.dumps``,
        which emits bare ``NaN``. ``orjson.loads`` raises ``JSONDecodeError:
        unexpected character`` on those, so switching the reader would make
        historical rows unreadable -- with no migration available, because the
        rows cannot be decoded to be rewritten.
        """
        legacy = json.dumps({"score": float("nan"), "ok": 1}).encode("utf-8")
        assert b"NaN" in legacy, "the fixture is not actually a legacy frame"

        decoded = _from_json_bytes(legacy)
        assert math.isnan(decoded["score"])
        assert decoded["ok"] == 1

    def test_a_legacy_nan_frame_survives_the_stored_read_path(self) -> None:
        """Small payloads are stored uncompressed, so a legacy frame is
        literally these bytes in the column -- exercise the public reader."""
        legacy = json.dumps({"score": float("inf")}).encode("utf-8")
        assert len(legacy) < SMALL_PAYLOAD_BYTES, "fixture must take the raw path"
        decoded = decompress_jsonb(legacy)
        assert decoded == {"score": float("inf")}

    def test_the_reader_also_accepts_the_new_encoding(self) -> None:
        """It has to read both -- that is why stdlib is the only valid choice
        here, rather than a nostalgic one."""
        assert _from_json_bytes(_to_json_bytes({"a": float("nan")})) == {"a": None}

    @pytest.mark.parametrize(
        "payload",
        [
            {},
            [],
            {"a": 1},
            [1, 2, 3],
            {"s": "x" * 10_000},
            {"deep": {"deep": {"deep": [1, {"x": None}]}}},
        ],
        ids=["empty-dict", "empty-list", "dict", "list", "big", "nested"],
    )
    def test_round_trip(self, payload: Any) -> None:
        assert decompress_jsonb(compress_jsonb(payload)) == payload


def test_the_batch_path_uses_the_same_codec() -> None:
    """``compress_many`` and ``compress_jsonb`` must not diverge on encoding."""
    payload = {"huge": 2**80, "text": "y" * 300}
    via_batch = compression.compress_many([payload])[0]
    via_single = compression.compress_jsonb(payload)
    assert via_batch == via_single
    assert compression.decompress_many([via_batch]) == [payload]
