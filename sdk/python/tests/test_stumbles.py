"""F28 — SDK ``eden.record_stumble()`` self-report."""

from __future__ import annotations

import httpx

import eden
from eden_sdk import stumbles


def _mock_transport(captured: list[httpx.Request]) -> httpx.MockTransport:
    def _handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "status": "ok",
                "feature": "agent_stumble_create",
                "data": {"stumble_id": "s1", "inserted": True},
            },
        )

    return httpx.MockTransport(_handler)


def test_record_stumble_dry_run_returns_payload() -> None:
    # conftest configures dry_run=True.
    result = eden.record_stumble(
        "tool returned empty result",
        trace_id="trace-xyz",
        detail={"tool": "search_kb"},
    )
    assert result is not None
    assert result["kind"] == "self_diagnostic"
    assert result["trace_id"] == "trace-xyz"
    assert result["title"] == "tool returned empty result"
    assert result["detail"] == {"tool": "search_kb"}


def test_record_stumble_posts_to_create_path() -> None:
    captured: list[httpx.Request] = []
    eden.configure(
        org_id="org-1",
        api_key="key-1",
        base_url="http://eden.test",
        dry_run=False,
        transport=_mock_transport(captured),
    )

    result = stumbles.record_stumble(
        "low confidence answer",
        kind="self_diagnostic",
        trace_id="trace-42",
        agent_id="agent-a",
        blocking=True,
    )

    assert result is not None
    assert result["data"]["stumble_id"] == "s1"
    assert len(captured) == 1
    req = captured[0]
    assert req.method == "POST"
    assert req.url.path == "/orgs/org-1/stumbles"
    assert req.headers["X-Org-Id"] == "org-1"


def test_record_stumble_unknown_kind_coerced() -> None:
    result = eden.record_stumble("weird", kind="not_a_kind", trace_id="t1")
    assert result is not None
    assert result["kind"] == "self_diagnostic"


def test_record_stumble_no_trace_id_drops() -> None:
    # No explicit trace_id and no active trace → dropped.
    result = eden.record_stumble("orphan stumble")
    assert result is None


def test_record_stumble_autofills_trace_id_from_context() -> None:
    with eden.trace(name="agent-run") as span:
        result = eden.record_stumble("mid-trace hiccup")
    assert result is not None
    assert result["trace_id"] == span.trace_id


def test_record_stumble_disabled_noop() -> None:
    eden.configure(disabled=True)
    result = eden.record_stumble("should not send", trace_id="t")
    assert result is None
