"""Data platform services (Phase B3 / B5, 2026-06-19).

- :mod:`.archive` — :class:`ArchiveService` (Postgres → Impossible
  Cloud cold archive, 90-day window).
- :mod:`.partitions` — :class:`PartitionManager` (native Postgres
  monthly partitions: create forward, drop expired).
"""
from __future__ import annotations

from .archive import DEFAULT_COLD_AGE_DAYS, ArchiveService
from .partitions import DEFAULT_RETENTION_MONTHS, MANAGED_TABLES, PartitionManager

__all__ = [
    "ArchiveService",
    "DEFAULT_COLD_AGE_DAYS",
    "PartitionManager",
    "MANAGED_TABLES",
    "DEFAULT_RETENTION_MONTHS",
]
