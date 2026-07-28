"""Shared empty-poll cooldown helpers for Neon scale-to-zero.

Worker loops that poll Postgres on a fixed cadence (verify, insights,
EQL, webhooks) must skip PG after an empty claim so the fleet can
clear Neon's ``suspend_timeout`` (~300s). Callers set a cooldown after
zero-row results and clear it when they enqueue new work.
"""

from __future__ import annotations

import time
from typing import Callable


def make_empty_cooldown(
    *,
    default_seconds: float,
    settings_attr: str,
) -> tuple[Callable[[], bool], Callable[[], None], Callable[[], None]]:
    """Return ``(in_cooldown, mark_empty, clear)`` closures sharing state."""

    until = 0.0

    def _cooldown_s() -> float:
        try:
            from eden.config import get_settings

            return float(getattr(get_settings(), settings_attr, default_seconds) or default_seconds)
        except Exception:
            return default_seconds

    def in_cooldown() -> bool:
        return time.monotonic() < until

    def mark_empty() -> None:
        nonlocal until
        until = time.monotonic() + max(30.0, _cooldown_s())

    def clear() -> None:
        nonlocal until
        until = 0.0

    return in_cooldown, mark_empty, clear
