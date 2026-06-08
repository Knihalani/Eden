"""Tests for the FormatRegistry."""

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import FormatUnsupportedError
from eden.observability.ingestion.registry import (
    FormatRegistry,
    SourceDecoder,
)
from eden.observability.telemetry_collector import TelemetryEvent


class _FakeDecoder:
    """Minimal SourceDecoder for tests."""

    def __init__(self, fmt: str, events: list[TelemetryEvent] | None = None) -> None:
        self.source_format = fmt
        self._events = events or []
        self.detect_calls = 0
        self.decode_calls = 0

    def detect(self, body: bytes, content_type: str | None) -> bool:
        self.detect_calls += 1
        return True

    async def decode(self, body: bytes, attribution: Attribution) -> list[TelemetryEvent]:
        self.decode_calls += 1
        return list(self._events)


def test_register_and_known_formats():
    r = FormatRegistry()
    r.register(_FakeDecoder("foo"))
    r.register(_FakeDecoder("bar"))
    assert r.known_formats() == ["bar", "foo"]


def test_register_overwrites():
    r = FormatRegistry()
    a = _FakeDecoder("foo")
    b = _FakeDecoder("foo")
    r.register(a)
    r.register(b)
    # Second register replaces; known_formats is sorted so only one entry.
    assert r.known_formats() == ["foo"]


def test_register_requires_source_format():
    r = FormatRegistry()

    class _NoFormat:
        def detect(self, body, ct):
            return True

        async def decode(self, body, attr):
            return []

    with pytest.raises(ValueError, match="source_format"):
        r.register(_NoFormat())


def test_unregister_drops_decoder():
    r = FormatRegistry()
    r.register(_FakeDecoder("foo"))
    assert "foo" in r.known_formats()
    r.unregister("foo")
    assert "foo" not in r.known_formats()


def test_unregister_unknown_is_silent():
    r = FormatRegistry()
    r.unregister("nonexistent")  # should not raise


def test_decode_unknown_format_raises():
    # Synchronous check — registry has the decoder only for "foo".
    r = FormatRegistry()
    r.register(_FakeDecoder("foo"))
    assert "foo" in r.known_formats()
    assert "bar" not in r.known_formats()


@pytest.mark.asyncio
async def test_decode_unknown_format_raises_async():
    r = FormatRegistry()
    r.register(_FakeDecoder("foo"))
    attribution = Attribution(tenant_id="org_abc")
    with pytest.raises(FormatUnsupportedError):
        await r.decode("nonexistent", b"{}", attribution)


@pytest.mark.asyncio
async def test_decode_dispatches_to_registered_decoder():
    r = FormatRegistry()
    decoder = _FakeDecoder("foo", events=[TelemetryEvent(
        event_id="e1", tenant_id="t1", project_id="p1",
        trace_id="tr1", realm="production", event_type="x",
        timestamp="2024-01-01T00:00:00Z",
    )])
    r.register(decoder)
    events = await r.decode("foo", b"{}", Attribution(tenant_id="org_abc"))
    assert len(events) == 1
    assert decoder.decode_calls == 1


def test_can_detect_returns_first_match():
    r = FormatRegistry()
    a = _FakeDecoder("a")
    a.detect = lambda body, ct: True
    b = _FakeDecoder("b")
    b.detect = lambda body, ct: False
    r.register(a)
    r.register(b)
    assert r.can_detect(b"x", None) == "a"


def test_can_detect_returns_none_when_no_match():
    r = FormatRegistry()
    a = _FakeDecoder("a")
    a.detect = lambda body, ct: False
    r.register(a)
    assert r.can_detect(b"x", None) is None


def test_can_detect_handles_decoder_exceptions():
    r = FormatRegistry()
    a = _FakeDecoder("a")

    def _bad_detect(body, ct):
        raise RuntimeError("boom")

    a.detect = _bad_detect
    r.register(a)
    # Should not propagate — registry logs and continues.
    assert r.can_detect(b"x", None) is None
