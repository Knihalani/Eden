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


class OfflineQueue:
    """Append-only SQLite queue for TraceEvent payloads."""

    def __init__(self, path: Path | str | None = None, *, max_rows: int = 10_000) -> None:
        self.path = Path(path) if path else _DEFAULT_PATH
        self.max_rows = max_rows
        self._lock = threading.Lock()
        self.dropped = 0
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_format TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at REAL NOT NULL DEFAULT (strftime('%s','now'))
                )
                """
            )

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(str(self.path), timeout=5.0)

    def enqueue(self, source_format: str, payload: dict[str, Any]) -> None:
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO events (source_format, payload) VALUES (?, ?)",
                    (source_format, json.dumps(payload, default=str)),
                )
                row = conn.execute("SELECT COUNT(*) FROM events").fetchone()
                count = int(row[0]) if row else 0
                if count > self.max_rows:
                    overflow = count - self.max_rows
                    conn.execute(
                        "DELETE FROM events WHERE id IN "
                        "(SELECT id FROM events ORDER BY id ASC LIMIT ?)",
                        (overflow,),
                    )
                    self.dropped += overflow

    def drain(self, limit: int = 100) -> list[tuple[int, str, dict[str, Any]]]:
        with self._lock:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT id, source_format, payload FROM events "
                    "ORDER BY id ASC LIMIT ?",
                    (limit,),
                ).fetchall()
                out: list[tuple[int, str, dict[str, Any]]] = []
                for rid, fmt, raw in rows:
                    try:
                        out.append((int(rid), str(fmt), json.loads(raw)))
                    except Exception:  # noqa: BLE001
                        conn.execute("DELETE FROM events WHERE id = ?", (rid,))
                return out

    def ack(self, ids: list[int]) -> None:
        if not ids:
            return
        with self._lock:
            with self._connect() as conn:
                conn.executemany(
                    "DELETE FROM events WHERE id = ?",
                    [(i,) for i in ids],
                )

    def size(self) -> int:
        with self._lock:
            with self._connect() as conn:
                row = conn.execute("SELECT COUNT(*) FROM events").fetchone()
                return int(row[0]) if row else 0
