"""Shared row → bytes serialisation for cold-archive S3 writers.

Phase 4 (storage) of the Eden Observability overhaul: cold-archive
writers (:mod:`eden.data_platform.bronze_sink`,
:mod:`eden.data_platform.retention`) prefer Parquet with zstd
compression when ``pyarrow`` is importable, and fall back to
newline-delimited JSON (NDJSON) when it is not — mirroring the
existing ``parquet``/``jsonl`` shim in :mod:`eden.exports.runner`.

Parquet+zstd is both smaller (columnar + a real compression codec vs.
raw JSON text) and directly queryable by tools like DuckDB/Athena
without a deserialise pass; NDJSON needs zero extra dependencies and
is human-inspectable, which is why it stays as the fallback rather
than being dropped.

Usage::

    from eden.storage.cold_archive import serialize_rows

    payload = serialize_rows(rows)
    key = f"{prefix}/{ts.isoformat()}.{payload.file_extension}"
    s3.put_object(Bucket=bucket, Key=key, Body=payload.body,
                   ContentType=payload.content_type)
"""

from __future__ import annotations

import io
import json
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ArchivePayload:
    """Serialised bytes for one cold-archive object plus how to label it."""

    body: bytes
    format: str  # "parquet" | "ndjson"
    file_extension: str  # "parquet" | "ndjson"
    content_type: str


def _normalize_cell(value: Any) -> Any:
    """Coerce one row value into something ``pyarrow.Table.from_pylist``
    can type consistently across every row in the batch.

    Nested ``dict``/``list`` values (JSONB columns, ``metadata`` blobs)
    are flattened to their JSON string form — Parquet needs a single
    type per column, and a raw Python dict/list column would either
    require an explicit (and row-batch-specific) nested schema or fail
    on the first row whose shape differs from the first row seen.
    Scalars (str/int/float/bool/None/datetime) pass through unchanged
    since pyarrow infers those natively, including timezone-aware
    datetimes.
    """
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str, separators=(",", ":"))
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    # datetime, UUID, Decimal, etc. — pyarrow handles datetime natively;
    # everything else (UUID, Decimal, ...) is safest as its str form.
    from datetime import date, datetime

    if isinstance(value, (datetime, date)):
        return value
    return str(value)


def _rows_to_parquet_zstd(rows: list[dict]) -> bytes | None:
    """Best-effort Parquet+zstd serialisation. Returns ``None`` (never
    raises) if ``pyarrow`` is not installed or the batch fails to
    convert — callers must fall back to NDJSON in either case.
    """
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        return None

    try:
        normalized = [
            {k: _normalize_cell(v) for k, v in dict(r).items()} for r in rows
        ]
        table = pa.Table.from_pylist(normalized) if normalized else pa.table({})
        sink = io.BytesIO()
        pq.write_table(table, sink, compression="zstd")
        return sink.getvalue()
    except Exception as exc:
        logger.warning(f"cold_archive: Parquet serialisation failed, falling back to NDJSON: {exc}")
        return None


def _rows_to_ndjson(rows: list[dict]) -> bytes:
    """Newline-delimited JSON fallback — no extra dependencies."""
    return ("\n".join(json.dumps(dict(r), default=str) for r in rows)).encode("utf-8")


def serialize_rows(rows: list[dict]) -> ArchivePayload:
    """Serialise ``rows`` for cold storage, preferring Parquet+zstd.

    ``rows`` may be plain ``dict`` or any mapping-like row object
    (e.g. an ``asyncpg.Record``) — both branches call ``dict(r)``.
    """
    parquet_bytes = _rows_to_parquet_zstd(rows)
    if parquet_bytes is not None:
        return ArchivePayload(
            body=parquet_bytes,
            format="parquet",
            file_extension="parquet",
            content_type="application/vnd.apache.parquet",
        )
    return ArchivePayload(
        body=_rows_to_ndjson(rows),
        format="ndjson",
        file_extension="ndjson",
        content_type="application/x-ndjson",
    )


def pyarrow_available() -> bool:
    """Cheap capability probe for logging/tests — does not cache the
    import (importing pyarrow twice is cheap after the first call
    since Python caches modules in ``sys.modules``)."""
    try:
        import pyarrow  # noqa: F401
    except ImportError:
        return False
    return True
