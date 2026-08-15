"""``jsonx``'s two backends must produce identical bytes.

Whether ``orjson`` happens to be installed is an environment detail. It must
not change what Eden writes to Postgres JSONB, caches in Redis, publishes over
SSE, or returns to a client — but for three classes of value it did:

* ``datetime`` — orjson emits RFC 3339 ``2020-01-02T03:04:05``; the fallback
  went through ``default=str`` and emitted a space instead of the ``T``.
* non-finite floats — the fallback emitted bare ``NaN`` / ``Infinity``, which
  are **not valid JSON**, so a strict client parser rejects the entire
  document. orjson emits ``null``.
* non-string dict keys — a ``UUID`` key raised ``TypeError`` on the fallback
  (a 500) where orjson stringifies it.

The corpus below runs through both backends and asserts byte equality, so the
two can never drift apart again. This is a prerequisite for replacing the
default response class with one built on ``jsonx``: that change is only safe
while both backends agree.
"""

from __future__ import annotations

import datetime as dt
import decimal
import importlib.util
import json
import math
import sys
import uuid
from pathlib import Path
from types import ModuleType

import pytest

_JSONX = Path(__file__).resolve().parents[3] / "src" / "eden" / "util" / "jsonx.py"

_UUID = uuid.UUID("12345678-1234-5678-1234-567812345678")


def _load(name: str, *, block_orjson: bool) -> ModuleType:
    """Import a private copy of ``jsonx``, optionally with orjson hidden.

    Binding ``sys.modules["orjson"] = None`` makes ``import orjson`` raise
    ImportError, which is how the fallback branch is reached without
    uninstalling anything.
    """
    sentinel = object()
    saved = sys.modules.get("orjson", sentinel)
    if block_orjson:
        sys.modules["orjson"] = None  # type: ignore[assignment]
    try:
        spec = importlib.util.spec_from_file_location(name, _JSONX)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        if saved is sentinel:
            sys.modules.pop("orjson", None)
        else:
            sys.modules["orjson"] = saved  # type: ignore[assignment]


@pytest.fixture(scope="module")
def orjson_backend() -> ModuleType:
    pytest.importorskip("orjson")
    mod = _load("jsonx_orjson_backend", block_orjson=False)
    assert "orjson" in sys.modules, "expected the orjson branch"
    return mod


@pytest.fixture(scope="module")
def stdlib_backend() -> ModuleType:
    return _load("jsonx_stdlib_backend", block_orjson=True)


#: (id, value) — every case must serialize identically under both backends.
CORPUS: list[tuple[str, object]] = [
    ("plain", {"a": 1, "b": [1, 2, {"c": "d"}], "e": None, "f": True}),
    ("empty", {}),
    ("datetime_naive", {"v": dt.datetime(2020, 1, 2, 3, 4, 5)}),
    ("datetime_utc", {"v": dt.datetime(2020, 1, 2, 3, 4, 5, tzinfo=dt.UTC)}),
    ("datetime_micros", {"v": dt.datetime(2020, 1, 2, 3, 4, 5, 123456)}),
    ("date", {"v": dt.date(2020, 1, 2)}),
    ("time", {"v": dt.time(3, 4, 5)}),
    ("uuid", {"v": _UUID}),
    ("decimal", {"v": decimal.Decimal("1.50")}),
    ("nan", {"v": float("nan")}),
    ("inf", {"v": float("inf")}),
    ("neg_inf", {"v": float("-inf")}),
    ("nan_nested", {"a": [{"b": float("nan")}, 1.5]}),
    ("int_key", {1: "a"}),
    ("float_key", {1.5: "a"}),
    ("bool_key", {True: "a"}),
    ("none_key", {None: "a"}),
    ("uuid_key", {_UUID: "a"}),
    ("datetime_key", {dt.date(2020, 1, 2): "a"}),
    ("bytes_value", {"v": b"ab"}),
    ("unicode", {"v": "héllo → 世界"}),
    ("deep", {"a": {"b": {"c": {"d": [1, {"e": None}]}}}}),
    ("list_root", [1, "two", None, True]),
    ("float_precision", {"v": 0.1 + 0.2}),
    ("negative_zero", {"v": -0.0}),
    ("large_safe_int", {"v": 2**53}),
]


@pytest.mark.parametrize(("case", "value"), CORPUS, ids=[c for c, _ in CORPUS])
def test_backends_agree(
    orjson_backend: ModuleType, stdlib_backend: ModuleType, case: str, value: object
) -> None:
    fast = orjson_backend.dumps(value)
    slow = stdlib_backend.dumps(value)
    assert fast == slow, (
        f"jsonx backends disagree on {case!r}:\n"
        f"  orjson: {fast!r}\n"
        f"  stdlib: {slow!r}\n"
        "Whether orjson is installed must not change what Eden emits."
    )


@pytest.mark.parametrize(("case", "value"), CORPUS, ids=[c for c, _ in CORPUS])
def test_output_is_valid_json(stdlib_backend: ModuleType, case: str, value: object) -> None:
    """``NaN``/``Infinity`` are Python-isms, not JSON. Strict parsers reject them."""
    text = stdlib_backend.dumps(value)
    json.loads(text, parse_constant=_reject_constant)


def _reject_constant(name: str) -> None:
    raise AssertionError(f"emitted the non-standard JSON constant {name!r}")


@pytest.mark.parametrize(("case", "value"), CORPUS, ids=[c for c, _ in CORPUS])
def test_dumps_bytes_matches_dumps(stdlib_backend: ModuleType, case: str, value: object) -> None:
    assert stdlib_backend.dumps_bytes(value) == stdlib_backend.dumps(value).encode()


class TestSpecificSemantics:
    """Spell out the behaviours the corpus enforces, so a change is legible."""

    def test_datetime_uses_the_rfc3339_t_separator(
        self, orjson_backend: ModuleType, stdlib_backend: ModuleType
    ) -> None:
        v = {"v": dt.datetime(2020, 1, 2, 3, 4, 5)}
        assert orjson_backend.dumps(v) == '{"v":"2020-01-02T03:04:05"}'
        assert stdlib_backend.dumps(v) == '{"v":"2020-01-02T03:04:05"}'

    def test_non_finite_floats_become_null(
        self, orjson_backend: ModuleType, stdlib_backend: ModuleType
    ) -> None:
        for bad in (float("nan"), float("inf"), float("-inf")):
            assert orjson_backend.dumps({"v": bad}) == '{"v":null}'
            assert stdlib_backend.dumps({"v": bad}) == '{"v":null}'

    def test_finite_floats_are_untouched(self, stdlib_backend: ModuleType) -> None:
        """The NaN fix must not perturb ordinary numbers."""
        for good in (0.0, -0.0, 1.5, 1e308, -1e308, 0.1 + 0.2):
            out = json.loads(stdlib_backend.dumps({"v": good}))["v"]
            assert out == good and math.isfinite(out)

    def test_non_string_keys_are_stringified(
        self, orjson_backend: ModuleType, stdlib_backend: ModuleType
    ) -> None:
        v = {_UUID: "a"}
        expected = '{"12345678-1234-5678-1234-567812345678":"a"}'
        assert orjson_backend.dumps(v) == expected
        assert stdlib_backend.dumps(v) == expected

    def test_roundtrip_through_loads(
        self, orjson_backend: ModuleType, stdlib_backend: ModuleType
    ) -> None:
        payload = {"a": 1, "b": [1, 2], "c": {"d": "e"}, "f": None, "g": True}
        for backend in (orjson_backend, stdlib_backend):
            assert backend.loads(backend.dumps(payload)) == payload
            assert backend.loads(backend.dumps_bytes(payload)) == payload

    def test_custom_default_is_still_honoured(self, stdlib_backend: ModuleType) -> None:
        """Wrapping ``default`` for datetimes must not discard the caller's."""

        class Custom:
            pass

        out = stdlib_backend.dumps({"v": Custom()}, default=lambda _: "SENTINEL")
        assert out == '{"v":"SENTINEL"}'

    def test_custom_default_does_not_break_datetime_agreement(
        self, orjson_backend: ModuleType, stdlib_backend: ModuleType
    ) -> None:
        d = {"v": dt.datetime(2020, 1, 2, 3, 4, 5)}
        assert orjson_backend.dumps(d, default=lambda _: "X") == stdlib_backend.dumps(
            d, default=lambda _: "X"
        )


class TestAcceptedDivergence:
    """One difference is deliberate; pin it so it is a decision, not a surprise."""

    def test_oversized_int_raises_under_orjson_only(
        self, orjson_backend: ModuleType, stdlib_backend: ModuleType
    ) -> None:
        big = {"v": 2**64}
        with pytest.raises(TypeError):
            orjson_backend.dumps(big)
        assert stdlib_backend.dumps(big) == '{"v":18446744073709551616}'

    def test_lone_surrogate_fails_on_both_backends(
        self, orjson_backend: ModuleType, stdlib_backend: ModuleType
    ) -> None:
        """Both reject it, at different points — neither emits valid UTF-8.

        A lone surrogate is not encodable as UTF-8 at all. orjson refuses up
        front; the stdlib backend produces a ``str`` that then fails at
        ``.encode()``. Reaching either state requires a surrogate to enter
        from outside JSON (``orjson.loads`` and ``json.loads`` both reject
        them on the way in), which is why this is pinned rather than
        smoothed over with a pre-pass on the hot path.
        """
        payload = {"v": "a\ud800b"}
        with pytest.raises(TypeError):
            orjson_backend.dumps(payload)
        with pytest.raises(UnicodeEncodeError):
            stdlib_backend.dumps_bytes(payload)

    def test_control_characters_are_escaped_identically(
        self, orjson_backend: ModuleType, stdlib_backend: ModuleType
    ) -> None:
        payload = {"v": "a\x00\x1f\t\n\"\\b"}
        assert orjson_backend.dumps(payload) == stdlib_backend.dumps(payload)
