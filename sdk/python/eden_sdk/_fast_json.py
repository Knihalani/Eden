"""Fast JSON serialization for the SDK's send hot path.

Every event batch is serialized on the wire path (raw + gzip). orjson is
~6.7× faster than the stdlib on this pattern (measured 2026-08-10 on the
backend ingest path). It is an optional dependency (``pip install
eden-sdk[fast]``) so the base install stays dependency-light; without it the
stdlib fallback below produces the same bytes.

Both branches are pinned to agree by ``tests/test_fast_json.py``. The naive
fallback diverged in the past on two things — datetimes (stdlib ``default=str``
emits a space separator where orjson emits RFC 3339 ``T``) and non-finite
floats (bare ``NaN`` / ``Infinity`` tokens, which are not valid JSON, vs
orjson's ``null``) — and either divergence would ship different bytes
depending on the environment.
"""

from __future__ import annotations

import datetime as _dt
import math
from typing import Any

__all__ = ["dumps_bytes"]

_DATE_TYPES = (_dt.datetime, _dt.date, _dt.time)
_SEPARATORS = (",", ":")


def _stringify_default(obj: Any) -> Any:
    """Match orjson's native handling, then fall back to ``str``.

    orjson serializes datetimes itself and never consults ``default`` for
    them; stdlib does, so the conversion has to live here for the two to
    agree.
    """
    if isinstance(obj, _DATE_TYPES):
        return obj.isoformat()
    return str(obj)


def _sanitize(obj: Any) -> Any:
    """Coerce the values stdlib cannot encode the way orjson does.

    Only reached on the stdlib path (the fast path already succeeded or is
    absent), so the cost of walking the structure is paid solely when needed.
    """
    if isinstance(obj, float):
        # orjson emits null for NaN/±Infinity; stdlib would emit bare
        # NaN/Infinity tokens, which no strict JSON parser accepts.
        return None if not math.isfinite(obj) else obj
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if isinstance(k, str):
                key = k
            elif isinstance(k, bool):
                key = "true" if k else "false"
            elif k is None:
                key = "null"
            elif isinstance(k, (int, float)):
                key = str(k)
            else:
                key = _stringify_default(k)
            out[key] = _sanitize(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    return obj


def _dumps_stdlib(obj: Any) -> bytes:
    """Compact UTF-8 JSON bytes via the stdlib (orjson-equivalent)."""
    import json

    return json.dumps(
        _sanitize(obj),
        default=_stringify_default,
        separators=_SEPARATORS,
        # stdlib escapes non-ASCII to \uXXXX by default; orjson always emits
        # raw UTF-8. Same bytes requires disabling the escaping.
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


try:
    import orjson

    _HAVE_ORJSON = True
except ImportError:  # pragma: no cover - exercised in slim installs
    _HAVE_ORJSON = False


def _dumps_orjson(obj: Any) -> bytes:
    """Compact UTF-8 JSON bytes via orjson."""
    return orjson.dumps(obj, default=_stringify_default, option=orjson.OPT_NON_STR_KEYS)


def dumps_bytes(obj: Any) -> bytes:
    """Compact UTF-8 JSON bytes; identical output on either backend."""
    if _HAVE_ORJSON:
        try:
            return _dumps_orjson(obj)
        except TypeError:
            # orjson is stricter than stdlib on exotic values (e.g. tz-aware
            # ``datetime.time``). Never regress a customer payload to a 500 —
            # fall through to the stdlib, which stringifies anything.
            return _dumps_stdlib(obj)
    return _dumps_stdlib(obj)
