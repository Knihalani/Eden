"""Fast JSON helpers backed by orjson.

Hot-path dumps (Postgres JSONB, Redis cache, SSE publish) should use
this module instead of ``json.dumps`` / ``json.loads``. Falls back to
the stdlib ``json`` module when orjson is unavailable (tests / slim
installs).
"""

from __future__ import annotations

from typing import Any

try:
    import orjson

    def dumps(obj: Any, *, default: Any = str) -> str:
        """Serialize ``obj`` to a compact UTF-8 JSON string."""
        option = orjson.OPT_NON_STR_KEYS
        return orjson.dumps(obj, default=default, option=option).decode("utf-8")

    def dumps_bytes(obj: Any, *, default: Any = str) -> bytes:
        """Serialize ``obj`` to compact UTF-8 JSON bytes."""
        option = orjson.OPT_NON_STR_KEYS
        return orjson.dumps(obj, default=default, option=option)

    def loads(data: str | bytes) -> Any:
        """Deserialize JSON from ``str`` or ``bytes``."""
        if isinstance(data, str):
            data = data.encode("utf-8")
        return orjson.loads(data)

except ImportError:  # pragma: no cover - stdlib fallback
    import json

    def dumps(obj: Any, *, default: Any = str) -> str:
        return json.dumps(obj, default=default, separators=(",", ":"))

    def dumps_bytes(obj: Any, *, default: Any = str) -> bytes:
        return dumps(obj, default=default).encode("utf-8")

    def loads(data: str | bytes) -> Any:
        if isinstance(data, bytes):
            data = data.decode("utf-8")
        return json.loads(data)
