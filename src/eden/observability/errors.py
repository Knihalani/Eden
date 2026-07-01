"""Domain-specific exceptions for the observability layer.

DL-3 fix: ``IngestionUnavailable`` is raised by the telemetry
collector when the underlying sink (Postgres / Redis / ClickHouse)
is unreachable. The ingest route translates it to HTTP 503 so the
SDK retries — pre-fix, the route returned 200 on a silent drop
which meant chunks vanished on every DB blip.

Ponytail: single module, single exception class. If we grow more
domain exceptions, they go here too.
"""

from __future__ import annotations


class IngestionUnavailable(Exception):
    """Raised when the telemetry sink is temporarily unavailable.

    The route layer MUST translate this to HTTP 503 (Service
    Unavailable). The SDK then retries with backoff.
    """

    def __init__(self, message: str = "ingestion sink unavailable") -> None:
        super().__init__(message)
        self.message = message
