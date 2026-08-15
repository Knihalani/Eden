"""A bounded ``key -> expiry`` map for sparse-refresh optimisations.

Several hot paths keep a dict of "when may I next refresh the TTL for this
key", so an EXPIRE is only issued occasionally instead of on every INCR.
That works only if the key space is small. It is not: the gateway mints a
unique ``trace_id`` per request, so ``trace:{trace_id}:llm_step`` is
distinct every time. The result was the worst of both worlds — the sparse
path never hit (every key was a miss, so every request still paid the
EXPIRE) *and* the dict grew by one entry per request forever in a
long-lived API process.

:class:`BoundedExpiryCache` caps the entry count and evicts on write:
first the entries that have already expired (cheap, and usually enough),
then oldest-first if the cap is still exceeded. This mirrors the
``_numsub_cache`` policy in ``eden.api.routes.observability_stream``.
"""

from __future__ import annotations

from collections import OrderedDict

#: Matches ``_numsub_cache`` in eden.api.routes.observability_stream.
DEFAULT_MAX_ENTRIES = 4096


class BoundedExpiryCache:
    """Insertion-ordered ``str -> float`` map with a hard entry cap."""

    __slots__ = ("_data", "_max_entries")

    def __init__(self, max_entries: int = DEFAULT_MAX_ENTRIES) -> None:
        self._data: OrderedDict[str, float] = OrderedDict()
        self._max_entries = max(1, int(max_entries))

    @property
    def max_entries(self) -> int:
        return self._max_entries

    def __len__(self) -> int:
        return len(self._data)

    def __contains__(self, key: object) -> bool:
        return key in self._data

    def is_due(self, key: str, now: float) -> bool:
        """True when ``key`` is unknown or its refresh deadline has passed."""
        deadline = self._data.get(key)
        return deadline is None or now >= deadline

    def set(self, key: str, deadline: float, *, now: float) -> None:
        """Record ``key``'s next refresh deadline, evicting if needed."""
        self._data.pop(key, None)
        self._data[key] = deadline
        if len(self._data) <= self._max_entries:
            return
        # Drop everything already past its deadline first — for the
        # unique-key-per-request case this reclaims the bulk of the map.
        for stale in [k for k, exp in self._data.items() if exp <= now]:
            self._data.pop(stale, None)
        # Still over the cap (all entries live): evict oldest-first.
        while len(self._data) > self._max_entries:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()


def resolve_max_entries(settings_attr: str = "checkpoint_expire_cache_max") -> int:
    """Read the configured cap, falling back to the shared default."""
    try:
        from eden.config import get_settings

        return max(
            1,
            int(
                getattr(get_settings(), settings_attr, DEFAULT_MAX_ENTRIES)
                or DEFAULT_MAX_ENTRIES
            ),
        )
    except Exception:
        return DEFAULT_MAX_ENTRIES
