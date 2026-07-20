"""Durable offline queue — SQLite file spill when ingest is unreachable."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger("eden_sdk.offline_queue")

_DEFAULT_PATH = Path.home() / ".eden" / "offline_queue.sqlite3"
_JSON_SEPARATORS = (",", ":")


class OfflineQueue:
    """Append-only SQLite queue for TraceEvent payloads.

    Keeps a persistent connection (WAL) and an in-memory size
    counter so spill under outage does not open/COUNT on every row.
    """

    def __init__(self, path: Path | str | None = None, *, max_rows: int = 10_000) -> None:
        self.path = Path(path) if path else _DEFAULT_PATH
        self.max_rows = max_rows
        self._lock = threading.Lock()
        self.dropped = 0
        self._size = 0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path), timeout=5.0, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_format TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at REAL NOT NULL DEFAULT (strftime('%s','now'))
            )
            """
        )
        row = self._conn.execute("SELECT COUNT(*) FROM events").fetchone()
        self._size = int(row[0]) if row else 0
        self._conn.commit()

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except Exception:  # noqa: BLE001
                pass

    def enqueue(self, source_format: str, payload: dict[str, Any]) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO events (source_format, payload) VALUES (?, ?)",
                (
                    source_format,
                    json.dumps(payload, default=str, separators=_JSON_SEPARATORS),
                ),
            )
            self._size += 1
            self._trim_locked()
            self._conn.commit()

    def enqueue_many(
        self, items: list[tuple[str, dict[str, Any]]]
    ) -> None:
        """Insert many rows in one transaction (single commit).

        Used by :meth:`EdenClient._spill_offline` so a failed batch
        does not pay one fsync per event.
        """
        if not items:
            return
        with self._lock:
            rows = [
                (
                    fmt,
                    json.dumps(payload, default=str, separators=_JSON_SEPARATORS),
                )
                for fmt, payload in items
            ]
            self._conn.executemany(
                "INSERT INTO events (source_format, payload) VALUES (?, ?)",
                rows,
            )
            self._size += len(rows)
            self._trim_locked()
            self._conn.commit()

    def _trim_locked(self) -> None:
        """Drop oldest rows when over ``max_rows``. Caller holds lock."""
        if self._size <= self.max_rows:
            return
        overflow = self._size - self.max_rows
        self._conn.execute(
            "DELETE FROM events WHERE id IN "
            "(SELECT id FROM events ORDER BY id ASC LIMIT ?)",
            (overflow,),
        )
        self._size = self.max_rows
        self.dropped += overflow

    def drain(self, limit: int = 100) -> list[tuple[int, str, dict[str, Any]]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, source_format, payload FROM events "
                "ORDER BY id ASC LIMIT ?",
                (limit,),
            ).fetchall()
            out: list[tuple[int, str, dict[str, Any]]] = []
            for rid, fmt, raw in rows:
                try:
                    out.append((int(rid), str(fmt), json.loads(raw)))
                except Exception:  # noqa: BLE001
                    self._conn.execute("DELETE FROM events WHERE id = ?", (rid,))
                    self._size = max(0, self._size - 1)
            self._conn.commit()
            return out

    def ack(self, ids: list[int]) -> None:
        if not ids:
            return
        with self._lock:
            self._conn.executemany(
                "DELETE FROM events WHERE id = ?",
                [(i,) for i in ids],
            )
            self._size = max(0, self._size - len(ids))
            self._conn.commit()

    def size(self) -> int:
        with self._lock:
            return self._size
