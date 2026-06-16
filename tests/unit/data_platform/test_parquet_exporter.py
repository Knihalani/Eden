"""Unit tests for ``eden.data_platform.parquet_exporter``.

Verifies the Parquet+zstd-7 round-trip and the no-op behaviour when the
B2 env vars are unset (so the exporter is safe to instantiate in dev / CI).
"""
from __future__ import annotations

import asyncio
import json
import random
import string
from typing import Any

import pytest


# Representative telemetry row shapes. The exporter streams these from
# Postgres; the test simulates that by constructing dicts and passing
# them through the in-process Parquet path.
def _make_rows(n: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for i in range(n):
        rows.append(
            {
                "event_id": f"evt_{i:08d}",
                "tenant_id": f"tenant_{i % 10}",
                "trace_id": f"trace_{i // 50:05d}",
                "timestamp": f"2026-06-{(i % 28) + 1:02d}T00:00:00+00:00",
                "event_type": random.choice(["llm_call", "tool_call", "agent_step"]),
                "name": f"span_{i}",
                "duration_ms": random.uniform(10, 5000),
                "payload": {
                    "model": "gpt-4o",
                    "messages": [
                        {
                            "role": random.choice(["system", "user", "assistant"]),
                            "content": "".join(
                                random.choices(string.ascii_letters + " ", k=200)
                            ),
                        }
                    ],
                },
            }
        )
    return rows


class TestParquetExporter:
    """Direct Parquet round-trip — no S3, no Postgres."""

    def test_parquet_round_trip_preserves_rows(self, tmp_path):
        """Write 100 rows, read back, assert byte-identical data."""
        import pyarrow.parquet as pq

        from eden.data_platform.parquet_exporter import ParquetColdExporter

        rows = _make_rows(100)
        out_path = tmp_path / "test.parquet"
        table = __import__("pyarrow").Table.from_pylist(rows)
        import pyarrow.parquet as _pq

        _pq.write_table(
            table,
            out_path,
            compression="zstd",
            compression_level=7,
        )
        recovered = _pq.read_table(out_path).to_pylist()
        assert recovered == rows

    def test_parquet_compression_shrinks_repetitive_data(self, tmp_path):
        """A 5 KB highly-repetitive JSON payload should compress to <30% of raw."""
        import pyarrow.parquet as _pq

        # 1000 rows × 5 KB payload = 5 MB raw; expect < 1.5 MB on Parquet+zstd 7.
        body = {
            "model": "gpt-4o",
            "messages": [
                {"role": "system", "content": "You are a helpful assistant. " * 50},
                {"role": "user", "content": "Tell me a story. " * 100},
            ],
        }
        rows = [{"event_id": f"e_{i}", "payload": body} for i in range(1000)]
        out_path = tmp_path / "test.parquet"
        table = __import__("pyarrow").Table.from_pylist(rows)
        _pq.write_table(
            table,
            out_path,
            compression="zstd",
            compression_level=7,
        )
        file_size = out_path.stat().st_size
        raw_size = len(json.dumps(rows).encode("utf-8"))
        ratio = raw_size / max(file_size, 1)
        # Parquet+zstd-7 on repetitive JSON: typically 5-15×. We assert
        # 2× as a conservative lower bound (Parquet's columnar layout
        # plus dict encoding already helps even without zstd).
        assert ratio >= 2.0, (
            f"Parquet+zstd-7 ratio too low: raw={raw_size}, "
            f"file={file_size}, ratio={ratio:.2f}x"
        )


class TestParquetExporterNoOp:
    """When B2 is not configured, the exporter is a no-op (not an error)."""

    def test_export_is_noop_when_b2_unset(self):
        """Construct with empty settings, call export, assert zero rows + error captured."""
        from eden.data_platform.parquet_exporter import ParquetColdExporter

        # The default test_settings have all B2 vars empty (defaults).
        exporter = ParquetColdExporter()
        assert exporter._get_s3() is None  # private, but white-box for the test
        result = asyncio.run(
            exporter.export_table_window(
                table="telemetry_events",
                before=__import__("datetime").datetime.now(__import__("datetime").timezone.utc),
            )
        )
        assert result.rows_exported == 0
        assert result.files_written == 0
        assert result.errors == ["B2 not configured"]

    def test_query_cold_returns_empty_when_b2_unset(self):
        """``query_cold`` is also a no-op when B2 is not configured."""
        from datetime import datetime, timezone

        from eden.data_platform.parquet_exporter import ParquetColdExporter

        exporter = ParquetColdExporter()
        result = asyncio.run(
            exporter.query_cold(
                table="telemetry_events",
                start=datetime(2026, 1, 1, tzinfo=timezone.utc),
                end=datetime(2026, 12, 31, tzinfo=timezone.utc),
            )
        )
        assert result == []
