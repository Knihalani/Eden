"""Canonical JSON hashing for content-addressed deduplication.

Mirrors Laminar's May 2026 blog-post algorithm ("How Laminar compresses
agent traces by 20x"):

  - Hash every message via canonical JSON (sort_keys=True,
    ensure_ascii=False, separators=(",", ":")).
  - 64-char hex SHA-256 returned (we use the full digest for collision
    safety; Laminar's blog describes 32-byte, which we match — 64 hex
    chars = 32 bytes).
  - Two messages hash the same iff they are byte-identical under the
    canonical form.

The canonical form is the single invariant that makes ``trace_messages``
dedup correct across every consumer:

  - ingest (Python ``json.dumps`` here)
  - read (Python ``json.loads`` here)
  - any future consumer (TypeScript SDK, Go SDK, etc.) — as long as
    they implement the same canonicalization rules.

Field order is normalized via ``sort_keys=True``. Unicode is preserved
via ``ensure_ascii=False`` so a payload that contains "café" round-trips
identically. Whitespace inside string VALUES is preserved (json.dumps
emits "', '" by default with default separators; we keep that).
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
from typing import Any

# Single source of truth for the canonical form. Match Laminar's spec:
#   - sort_keys=True      → field order invariant across consumers
#   - ensure_ascii=False  → Unicode preserved (Laminar's blog explicitly
#                           does NOT escape non-ASCII)
#   - separators=(",", ":") → minimal whitespace; canonicaljson-style.
#                             Avoids the default ``", "`` and ``": "``
#                             that ``json.dumps`` uses, which would
#                             differ across Python versions on whitespace
#                             rules.
_CANONICAL_OPTS: dict[str, Any] = {
    "sort_keys": True,
    "ensure_ascii": False,
    "separators": (",", ":"),
}


def canonical_hash(msg: Any) -> str:
    """Return the 64-char hex SHA-256 of ``msg`` under canonical JSON form.

    Two messages are byte-identical under the canonical form iff they
    hash to the same value. This is the dedup key used in
    ``trace_messages``.

    Examples:
        >>> canonical_hash({"role": "user", "content": "hi"})
        '...'  # deterministic
        >>> canonical_hash({"content": "hi", "role": "user"})  # same dict
        '...'  # same hash as above (sort_keys normalizes order)
        >>> canonical_hash({"role": "user", "content": "hi"})
        >>> canonical_hash({"role": "user", "content": "bye"})
        # different hash (content differs)
    """
    canonical = json.dumps(msg, default=_json_default, **_CANONICAL_OPTS)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def canonical_bytes(msg: Any) -> bytes:
    """Return the canonical-JSON byte form of ``msg``.

    Useful for tests and for callers that want to inspect the canonical
    form directly (e.g. debugging "why did these two payloads hash
    differently?").
    """
    return json.dumps(msg, default=_json_default, **_CANONICAL_OPTS).encode("utf-8")


def _json_default(obj: Any) -> Any:
    """Handle types ``json.dumps`` can't serialize natively.

    Order of preference:
      1. ``datetime`` / ``date`` → ISO 8601 string (timezone-aware if set)
      2. ``bytes`` / ``bytearray`` → hex string (LLM SDKs sometimes embed
         raw bytes in payloads)
      3. fallback → ``str(obj)`` so we never crash on a weird object

    Keeping this list minimal and explicit is intentional — every entry
    is a place where a hash could silently differ between two callers.
    Adding a new type here is a hash-compat change for any consumer that
    also handles that type.
    """
    if isinstance(obj, (_dt.datetime, _dt.date)):
        return obj.isoformat()
    if isinstance(obj, (bytes, bytearray)):
        return obj.hex()
    return str(obj)
