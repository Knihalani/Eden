"""Shared helpers for the App/site-layer integration services.

Phase A1 of the Eden app/storage plan (2026-06-19). Provides:

- :func:`_get_client` — Postgres client fetcher; mirrors the
  pattern in :mod:`eden.services.user_intel._common`.
- :func:`_new_id` — prefixed id generation.
- :func:`_now_utc` — UTC ``datetime.now()``.
"""
from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


def _new_id(prefix: str) -> str:
    """Generate a prefixed UUID4 id (truncated to 32 hex chars)."""
    return f"{prefix}_{uuid.uuid4().hex[:32]}"


def _now_utc() -> datetime:
    """UTC ``datetime.now()``."""
    return datetime.now(UTC)


async def _get_client() -> Any:
    """Best-effort Postgres client. Returns ``None`` if the DB
    is unavailable; callers handle the no-op path."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("app_intel: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("app_intel: get_postgres_client failed: %s", exc)
        return None
