"""Parity tests for ``eden_sdk._fast_json``.

The wire bytes must not depend on whether orjson happens to be installed.
These tests run the same corpus through both branches and fail if they ever
drift apart again (mirrors the backend's ``jsonx`` divergence discipline).
"""

from __future__ import annotations

import datetime
import uuid

import pytest

from eden_sdk import _fast_json


def _corpus() -> list:
    now = datetime.datetime(2026, 8, 10, 12, 30, 45, tzinfo=datetime.timezone.utc)
    return [
        {"plain": "json", "n": 42, "f": 1.5, "ok": True, "nil": None},
        {"nested": [{"a": [1, 2, 3]}, {"b": {"c": "d"}}]},
        {"dt": now, "date": now.date(), "time": datetime.time(12, 30, 45)},
        {"uuid": uuid.uuid4()},
        {"non_finite": float("nan"), "inf": float("inf"), "neg_inf": float("-inf")},
        {"int_keys": {1: "one", 2: "two"}, "bool_keys": {True: "t", False: "f"}},
        {"unicode": "héllo wörld 🚀", "escapes": "line\nbreak\tand \"quotes\""},
        [],
        {},
        {"deep": [{"x": [{"y": [{"z": None}]}]}], "s": "a" * 500},
    ]


def test_stdlib_and_orjson_branches_agree() -> None:
    for payload in _corpus():
        stdlib = _fast_json._dumps_stdlib(payload)
        if _fast_json._HAVE_ORJSON:
            orjson = _fast_json._dumps_orjson(payload)
            assert orjson == stdlib, f"branch divergence for {payload!r}"
        # Both branches must be valid compact JSON — no separator spaces.
        assert b", " not in stdlib and b": " not in stdlib


def test_dumps_bytes_returns_compact_valid_json() -> None:
    import json

    payload = {"a": [1, 2, {"b": None}], "s": "x"}
    raw = _fast_json.dumps_bytes(payload)
    assert isinstance(raw, bytes)
    assert json.loads(raw) == payload


def test_roundtrip_of_corpus_is_lossless() -> None:
    import json

    for payload in _corpus():
        raw = _fast_json.dumps_bytes(payload)
        parsed = json.loads(raw)  # must always parse (no bare NaN tokens)
        if _fast_json._HAVE_ORJSON:
            assert parsed == json.loads(_fast_json._dumps_stdlib(payload))


@pytest.mark.skipif(not _fast_json._HAVE_ORJSON, reason="orjson not installed")
def test_non_finite_floats_become_null() -> None:
    raw = _fast_json.dumps_bytes({"x": float("nan"), "y": float("inf")})
    assert b"null" in raw
    assert b"NaN" not in raw


@pytest.mark.skipif(not _fast_json._HAVE_ORJSON, reason="orjson not installed")
def test_orjson_strictness_never_regresses_payloads() -> None:
    """Exotic values orjson rejects must fall back to the stdlib, not raise."""
    import datetime

    exotic = {
        "tz_aware_time": datetime.time(
            12, 30, 45, tzinfo=datetime.timezone(datetime.timedelta(hours=5))
        )
    }
    raw = _fast_json.dumps_bytes(exotic)  # must not raise
    assert isinstance(raw, bytes)
    # The fast path itself raises for this value; the wrapper must not.
    with pytest.raises(TypeError):
        _fast_json._dumps_orjson(exotic)
