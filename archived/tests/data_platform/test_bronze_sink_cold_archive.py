"""Phase 4 storage: BronzeEventSink._flush_s3 prefers Parquet+zstd
(via eden.storage.cold_archive) and falls back to NDJSON.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from eden.data_platform.bronze_sink import BronzeEventSink, RawEvent


def _events() -> list[RawEvent]:
    return [
        RawEvent(
            org_id="org-1",
            event_type="llm_call",
            resource="tokens",
            quantity=100,
            unit="tokens",
            model="gpt-4o",
            cost_usd=0.01,
            metadata={"input_tokens": 80, "output_tokens": 20},
        ),
        RawEvent(
            org_id="org-1",
            event_type="llm_call",
            resource="tokens",
            quantity=50,
            unit="tokens",
            model="gpt-4o",
        ),
    ]


@pytest.mark.asyncio
async def test_flush_s3_writes_parquet_key_when_pyarrow_available():
    pytest.importorskip("pyarrow")
    sink = BronzeEventSink()
    fake_s3 = MagicMock()
    sink._s3_client = fake_s3

    with patch("eden.data_platform.bronze_sink.get_settings") as mock_settings:
        mock_settings.return_value.bronze_s3_bucket = "test-bucket"
        mock_settings.return_value.bronze_s3_prefix = "bronze/events"
        await sink._flush_s3(_events())

    fake_s3.put_object.assert_called_once()
    kwargs = fake_s3.put_object.call_args.kwargs
    assert kwargs["Bucket"] == "test-bucket"
    assert kwargs["Key"].endswith(".parquet")
    assert kwargs["ContentType"] == "application/vnd.apache.parquet"
    assert isinstance(kwargs["Body"], bytes)
    assert len(kwargs["Body"]) > 0


@pytest.mark.asyncio
async def test_flush_s3_falls_back_to_ndjson_without_pyarrow():
    sink = BronzeEventSink()
    fake_s3 = MagicMock()
    sink._s3_client = fake_s3

    with (
        patch("eden.data_platform.bronze_sink.get_settings") as mock_settings,
        patch(
            "eden.storage.cold_archive._rows_to_parquet_zstd",
            return_value=None,
        ),
    ):
        mock_settings.return_value.bronze_s3_bucket = "test-bucket"
        mock_settings.return_value.bronze_s3_prefix = "bronze/events"
        await sink._flush_s3(_events())

    fake_s3.put_object.assert_called_once()
    kwargs = fake_s3.put_object.call_args.kwargs
    assert kwargs["Key"].endswith(".ndjson")
    assert kwargs["ContentType"] == "application/x-ndjson"
    lines = kwargs["Body"].decode("utf-8").split("\n")
    assert len(lines) == 2
    decoded = [json.loads(line) for line in lines]
    assert decoded[0]["org_id"] == "org-1"


@pytest.mark.asyncio
async def test_flush_s3_swallows_errors():
    """S3 flush failures must be logged, not raised — they'd otherwise
    take down the whole background flush loop."""
    sink = BronzeEventSink()
    fake_s3 = MagicMock()
    fake_s3.put_object.side_effect = RuntimeError("network blip")
    sink._s3_client = fake_s3

    with patch("eden.data_platform.bronze_sink.get_settings") as mock_settings:
        mock_settings.return_value.bronze_s3_bucket = "test-bucket"
        mock_settings.return_value.bronze_s3_prefix = "bronze/events"
        await sink._flush_s3(_events())  # must not raise
