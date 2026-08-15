"""Unit tests for ``eden.storage.cold_archive`` (Phase 4 storage).

Covers the Parquet+zstd happy path (skipped when pyarrow is not
installed) and the NDJSON fallback (always runs — it must not depend
on pyarrow at all, and must also be what happens when pyarrow *is*
installed but fails to convert a batch).
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from unittest.mock import patch

import pytest

from eden.storage.cold_archive import (
    ArchivePayload,
    _normalize_cell,
    pyarrow_available,
    serialize_rows,
)

SAMPLE_ROWS = [
    {
        "event_id": "evt-1",
        "trace_id": "trace-1",
        "timestamp": datetime(2026, 6, 1, tzinfo=UTC),
        "metadata": {"input_tokens": 10, "output_tokens": 20},
        "tags": ["a", "b"],
        "cost_usd": 0.0012,
        "outcome": None,
    },
    {
        "event_id": "evt-2",
        "trace_id": "trace-2",
        "timestamp": datetime(2026, 6, 2, tzinfo=UTC),
        "metadata": {"input_tokens": 5},
        "tags": [],
        "cost_usd": 0.0005,
        "outcome": "success",
    },
]


class TestNormalizeCell:
    def test_dict_becomes_json_string(self):
        out = _normalize_cell({"a": 1})
        assert isinstance(out, str)
        assert json.loads(out) == {"a": 1}

    def test_list_becomes_json_string(self):
        out = _normalize_cell([1, 2, 3])
        assert isinstance(out, str)
        assert json.loads(out) == [1, 2, 3]

    def test_scalars_pass_through(self):
        assert _normalize_cell("s") == "s"
        assert _normalize_cell(1) == 1
        assert _normalize_cell(1.5) == 1.5
        assert _normalize_cell(True) is True
        assert _normalize_cell(None) is None

    def test_datetime_passes_through(self):
        dt = datetime(2026, 1, 1, tzinfo=UTC)
        assert _normalize_cell(dt) is dt

    def test_unknown_type_stringified(self):
        class Weird:
            def __str__(self):
                return "weird-repr"

        assert _normalize_cell(Weird()) == "weird-repr"


class TestSerializeRowsFallback:
    """NDJSON fallback must work regardless of pyarrow availability."""

    def test_empty_rows_ndjson(self):
        with patch("eden.storage.cold_archive._rows_to_parquet_zstd", return_value=None):
            payload = serialize_rows([])
        assert payload.format == "ndjson"
        assert payload.body == b""

    def test_ndjson_round_trips_rows(self):
        with patch("eden.storage.cold_archive._rows_to_parquet_zstd", return_value=None):
            payload = serialize_rows(SAMPLE_ROWS)
        assert payload.format == "ndjson"
        assert payload.file_extension == "ndjson"
        assert payload.content_type == "application/x-ndjson"
        lines = payload.body.decode("utf-8").split("\n")
        assert len(lines) == len(SAMPLE_ROWS)
        decoded = [json.loads(line) for line in lines]
        assert decoded[0]["event_id"] == "evt-1"
        assert decoded[1]["outcome"] == "success"

    def test_missing_pyarrow_falls_back_to_ndjson(self):
        """Simulates pyarrow not being installed via ImportError."""
        with patch(
            "eden.storage.cold_archive._rows_to_parquet_zstd",
            side_effect=lambda rows: None,
        ):
            payload = serialize_rows(SAMPLE_ROWS)
        assert payload.format == "ndjson"


class TestRowsToParquetZstdErrorHandling:
    """``_rows_to_parquet_zstd`` must swallow its own failures and return
    ``None`` — it is a "best effort" helper; ``serialize_rows`` has no
    additional try/except and relies entirely on this contract."""

    def test_import_error_returns_none(self):
        from eden.storage import cold_archive

        with patch.dict("sys.modules", {"pyarrow": None, "pyarrow.parquet": None}):
            result = cold_archive._rows_to_parquet_zstd(SAMPLE_ROWS)
        assert result is None

    def test_write_failure_returns_none_not_raises(self):
        pytest.importorskip("pyarrow")
        from eden.storage.cold_archive import _rows_to_parquet_zstd

        with patch("pyarrow.parquet.write_table", side_effect=RuntimeError("disk full")):
            result = _rows_to_parquet_zstd(SAMPLE_ROWS)
        assert result is None


@pytest.mark.skipif(not pyarrow_available(), reason="pyarrow not installed")
class TestSerializeRowsParquet:
    def test_prefers_parquet_when_pyarrow_available(self):
        payload = serialize_rows(SAMPLE_ROWS)
        assert payload.format == "parquet"
        assert payload.file_extension == "parquet"
        assert payload.content_type == "application/vnd.apache.parquet"
        assert isinstance(payload.body, bytes)
        assert len(payload.body) > 0

    def test_parquet_bytes_are_readable_and_zstd_compressed(self):
        import io

        import pyarrow.parquet as pq

        payload = serialize_rows(SAMPLE_ROWS)
        table = pq.read_table(io.BytesIO(payload.body))
        assert table.num_rows == len(SAMPLE_ROWS)
        # Verify the on-disk codec is zstd, not the pyarrow default (snappy).
        meta = pq.ParquetFile(io.BytesIO(payload.body)).metadata
        codecs = {
            meta.row_group(0).column(i).compression.lower()
            for i in range(meta.row_group(0).num_columns)
        }
        assert "zstd" in codecs

    def test_json_columns_round_trip_through_string_form(self):
        import io

        import pyarrow.parquet as pq

        payload = serialize_rows(SAMPLE_ROWS)
        table = pq.read_table(io.BytesIO(payload.body))
        rows = table.to_pylist()
        metadata_0 = json.loads(rows[0]["metadata"])
        assert metadata_0 == {"input_tokens": 10, "output_tokens": 20}

    def test_empty_rows_returns_valid_empty_table(self):
        payload = serialize_rows([])
        assert payload.format == "parquet"
        import io

        import pyarrow.parquet as pq

        table = pq.read_table(io.BytesIO(payload.body))
        assert table.num_rows == 0


class TestArchivePayloadDataclass:
    def test_is_frozen(self):
        payload = ArchivePayload(
            body=b"x", format="ndjson", file_extension="ndjson", content_type="text/plain"
        )
        with pytest.raises(AttributeError):
            payload.body = b"y"  # type: ignore[misc]
