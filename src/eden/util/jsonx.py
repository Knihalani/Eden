"""Fast JSON helpers backed by orjson.

Hot-path dumps (Postgres JSONB, Redis cache, SSE publish) should use
this module instead of ``json.dumps`` / ``json.loads``. Falls back to
the stdlib ``json`` module when orjson is unavailable (tests / slim
installs).

**The two branches must produce the same bytes.** Whether orjson happens to be
installed is an environment detail; it must not change what Eden stores or
returns. The naive fallback diverged in three ways, each a real defect:

* ``datetime`` went through ``default=str``, giving ``"2020-01-02 03:04:05"``
  with a space where orjson emits RFC 3339 ``"2020-01-02T03:04:05"``. Any
  consumer parsing timestamps saw a different format depending on the install.
* Non-finite floats were emitted as bare ``NaN`` / ``Infinity``, which are
  **not valid JSON** — a strict client parser rejects the whole document.
  orjson emits ``null``.
* A dict keyed by anything stdlib does not handle natively (a ``UUID``, say)
  raised ``TypeError`` and became a 500, where orjson stringifies the key.

The fallback now matches orjson on all three. ``tests/unit/util/
test_jsonx_divergence.py`` runs the same corpus through both branches and
fails if they ever drift apart again.

Two divergences are deliberate and remain, both pinned by tests:

* Integers outside the signed 64-bit range raise ``TypeError`` under orjson
  but serialize under stdlib.
* A lone surrogate raises under orjson and fails at ``.encode()`` under
  stdlib.

Matching either would mean walking every payload on the hot path to find a
value that cannot arrive through JSON in the first place, and both failures
are loud rather than silent.
"""

from __future__ import annotations

import datetime as _dt
import math
from typing import Any

__all__ = ["dumps", "dumps_bytes", "loads"]

_DATE_TYPES = (_dt.datetime, _dt.date, _dt.time)


def _stringify_default(obj: Any) -> Any:
    """Match orjson's native handling, then fall back to ``str``.

    orjson serializes datetimes itself and never consults ``default`` for
    them; stdlib does, so the conversion has to live here for the two to
    agree.
    """
    if isinstance(obj, _DATE_TYPES):
        return obj.isoformat()
    return str(obj)


try:
    import orjson

    _OPTS = orjson.OPT_NON_STR_KEYS

    def dumps(obj: Any, *, default: Any = str) -> str:
        """Serialize ``obj`` to a compact UTF-8 JSON string."""
        # orjson ships no stubs, so the call is typed Any; bind it to bytes
        # rather than leaking that into the public signature.
        raw: bytes = orjson.dumps(obj, default=default, option=_OPTS)
        return raw.decode("utf-8")

    def dumps_bytes(obj: Any, *, default: Any = str) -> bytes:
        """Serialize ``obj`` to compact UTF-8 JSON bytes."""
        raw: bytes = orjson.dumps(obj, default=default, option=_OPTS)
        return raw

    def loads(data: str | bytes) -> Any:
        """Deserialize JSON from ``str`` or ``bytes``."""
        if isinstance(data, str):
            data = data.encode("utf-8")
        return orjson.loads(data)

except ImportError:  # pragma: no cover - stdlib fallback
    import json

    def _sanitize(obj: Any) -> Any:
        """Coerce the values stdlib cannot encode the way orjson does.

        Only reached after the fast path has already failed, so the cost of
        walking the structure is paid solely by payloads that need it.
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
                    if not isinstance(key, str):
                        key = str(key)
                out[key] = _sanitize(v)
            return out
        if isinstance(obj, (list, tuple)):
            return [_sanitize(v) for v in obj]
        return obj

    def _wrap_default(default: Any) -> Any:
        if default is str:
            return _stringify_default

        def _d(obj: Any) -> Any:
            if isinstance(obj, _DATE_TYPES):
                return obj.isoformat()
            return default(obj)

        return _d

    def dumps(obj: Any, *, default: Any = str) -> str:
        """Serialize ``obj`` to a compact UTF-8 JSON string."""
        d = _wrap_default(default)
        try:
            # allow_nan=False turns the silent invalid-JSON case into a
            # ValueError we can correct, rather than shipping ``NaN`` to a
            # client that will reject the entire response.
            return json.dumps(
                obj,
                default=d,
                separators=(",", ":"),
                allow_nan=False,
                # stdlib escapes non-ASCII to \uXXXX by default; orjson always
                # emits UTF-8. Left alone, the same Chinese or accented string
                # is stored as different bytes — and roughly six times larger —
                # depending on which backend is installed.
                ensure_ascii=False,
            )
        except (ValueError, TypeError):
            return json.dumps(
                _sanitize(obj),
                default=d,
                separators=(",", ":"),
                allow_nan=False,
                ensure_ascii=False,
            )

    def dumps_bytes(obj: Any, *, default: Any = str) -> bytes:
        """Serialize ``obj`` to compact UTF-8 JSON bytes."""
        return dumps(obj, default=default).encode("utf-8")

    def loads(data: str | bytes) -> Any:
        """Deserialize JSON from ``str`` or ``bytes``."""
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        return json.loads(data)
