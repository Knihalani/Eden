"""Ingest path remapping — avoid HTTP 415 on unsupported formats."""

from __future__ import annotations

import httpx
import pytest
import respx

import eden
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.doctor import run_doctor
from eden_sdk.ingest_format import resolve_ingest_path


@pytest.fixture(autouse=True)
def _reset(monkeypatch: pytest.MonkeyPatch) -> None:
    eden.reset_config()
    monkeypatch.delenv("EDEN_DISABLED", raising=False)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("openai", "openai"),
        ("anthropic", "anthropic"),
        ("framework", "webhook"),  # TraceEvent JSON → webhook, not OTel path
        ("webhook", "webhook"),
        ("custom", "webhook"),
        ("eden-sdk-doctor", "webhook"),
        ("vercel-ai", "webhook"),
        ("langchain", "webhook"),
        ("pydantic-ai", "webhook"),
        ("mastra", "webhook"),
        ("UNKNOWN-THING", "webhook"),
        ("", "webhook"),
    ],
)
def test_resolve_ingest_path(raw: str, expected: str) -> None:
    assert resolve_ingest_path(raw) == expected


@respx.mock
def test_remapped_formats_post_webhook_not_415() -> None:
    """Unsupported path labels must hit /ingest/webhook (200), not 415."""
    eden.configure(
        org_id="org_test",
        api_key="key_test",
        base_url="http://localhost:8000",
        flush_interval_ms=60_000,
        batch_size=50,
    )
    allowed = respx.post("http://localhost:8000/orgs/org_test/ingest/webhook").mock(
        return_value=httpx.Response(200, json={"accepted": 1})
    )
    # Any hit on a legacy unsupported path would be a regression.
    for bad in ("custom", "vercel-ai", "langchain", "pydantic-ai", "eden-sdk-doctor"):
        respx.post(f"http://localhost:8000/orgs/org_test/ingest/{bad}").mock(
            return_value=httpx.Response(415, json={"detail": "unsupported"})
        )

    client = get_default_client()
    for fmt in ("custom", "vercel-ai", "langchain", "pydantic-ai", "eden-sdk-doctor"):
        client.enqueue(
            TraceEvent(
                payload={
                    "event_id": f"e_{fmt}",
                    "event_type": "agent.run",
                    "source_format": fmt,
                },
                source_format=fmt,
            )
        )
    client.flush(timeout=3.0)
    assert allowed.call_count >= 1
    assert client.failed == 0
    assert client.sent >= 1


@respx.mock
def test_doctor_marks_test_event_failed_on_non_2xx() -> None:
    eden.configure(
        org_id="org_test",
        api_key="key_test",
        base_url="http://localhost:8000",
    )
    respx.get("http://localhost:8000/health").mock(
        return_value=httpx.Response(200, json={"status": "ok"})
    )
    respx.post("http://localhost:8000/orgs/org_test/ingest/webhook").mock(
        return_value=httpx.Response(415, json={"detail": "nope"})
    )
    report = run_doctor(emit_test_event=True, timeout_s=3.0)
    te = next(c for c in report.checks if c.name == "test_event")
    assert te.ok is False
    assert "2xx" in te.message


@respx.mock
def test_doctor_marks_test_event_ok_on_2xx() -> None:
    eden.configure(
        org_id="org_test",
        api_key="key_test",
        base_url="http://localhost:8000",
    )
    respx.get("http://localhost:8000/health").mock(
        return_value=httpx.Response(200, json={"status": "ok"})
    )
    respx.post("http://localhost:8000/orgs/org_test/ingest/webhook").mock(
        return_value=httpx.Response(200, json={"accepted": 1})
    )
    report = run_doctor(emit_test_event=True, timeout_s=3.0)
    te = next(c for c in report.checks if c.name == "test_event")
    assert te.ok is True
    assert "HTTP 2xx" in te.message
