"""Tests for the ingestion exception hierarchy."""

import pytest

from eden.observability.ingestion.errors import (
    AttributionError,
    BodyTooLargeError,
    FormatUnsupportedError,
    IngestError,
    PIIMaskingError,
    SchemaInvalidError,
    exception_to_http_status,
)


def test_ingest_error_is_base():
    assert issubclass(FormatUnsupportedError, IngestError)
    assert issubclass(SchemaInvalidError, IngestError)
    assert issubclass(PIIMaskingError, IngestError)
    assert issubclass(BodyTooLargeError, IngestError)
    assert issubclass(AttributionError, IngestError)


def test_default_status_codes():
    assert FormatUnsupportedError.http_status == 415
    assert SchemaInvalidError.http_status == 422
    assert PIIMaskingError.http_status == 422
    assert BodyTooLargeError.http_status == 413
    assert AttributionError.http_status == 401


def test_schema_invalid_carries_problems():
    exc = SchemaInvalidError("bad", problems=["field1 missing", "field2 wrong"])
    assert exc.problems == ["field1 missing", "field2 wrong"]
    assert "bad" in str(exc)


def test_schema_invalid_problems_default_empty():
    exc = SchemaInvalidError("bad")
    assert exc.problems == []


def test_exception_to_http_status_known():
    assert exception_to_http_status(FormatUnsupportedError("x")) == 415
    assert exception_to_http_status(SchemaInvalidError("x")) == 422
    assert exception_to_http_status(BodyTooLargeError("x")) == 413


def test_exception_to_http_status_unknown():
    assert exception_to_http_status(ValueError("x")) == 500
    assert exception_to_http_status(RuntimeError("x")) == 500
