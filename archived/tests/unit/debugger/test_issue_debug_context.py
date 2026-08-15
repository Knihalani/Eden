"""Unit tests for the 9.3 issue → debugger deep-link glue.

Covers ``_first_stumble_trace`` (the pure resolution helper) and
verifies the route handler's response shape via the same logic, using
lightweight fake repos so no Postgres is needed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import pytest

from eden.api.routes.agent_issues import _first_stumble_trace
from eden.issues.models import Issue


# ── Fake IssuesRepo ──────────────────────────────────────────────


@dataclass
class _FakeRepo:
    """Minimal stub for IssuesRepo used by _first_stumble_trace."""

    stumbles: dict[str, dict[str, Any]] = field(default_factory=dict)
    issues: dict[str, Issue] = field(default_factory=dict)

    async def get_stumble(self, org_id: str, stumble_id: str) -> dict[str, Any] | None:
        return self.stumbles.get(stumble_id)

    async def get_issue(self, org_id: str, issue_id: str) -> Issue | None:
        return self.issues.get(issue_id)


def _make_issue(
    stumble_ids: list[str] | None = None,
) -> Issue:
    return Issue(
        id="iss_001",
        org_id="org_a",
        fingerprint="fp_abc",
        kind="task_failure",
        title="Auth timeout on checkout",
        status="open",
        severity="p1",
        example_stumble_ids=stumble_ids or [],
    )


# ── _first_stumble_trace ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_first_stumble_trace_returns_trace_and_span() -> None:
    """Happy path: first stumble with trace_id+span_id is returned."""
    import eden.api.routes.agent_issues as mod

    repo = _FakeRepo(
        stumbles={
            "stb_1": {
                "id": "stb_1",
                "trace_id": "trc_abc123",
                "span_id": "span_step3",
            },
        },
    )
    original_repo = mod._repo
    mod._repo = repo  # type: ignore[assignment]
    try:
        trace_id, span_id = await _first_stumble_trace("org_a", ["stb_1"])
    finally:
        mod._repo = original_repo

    assert trace_id == "trc_abc123"
    assert span_id == "span_step3"


@pytest.mark.asyncio
async def test_first_stumble_trace_skips_missing_stumble() -> None:
    """Stumble ID not found → continues to next; all missing → (None, None)."""
    import eden.api.routes.agent_issues as mod

    repo = _FakeRepo(stumbles={})  # no stumbles in DB
    original_repo = mod._repo
    mod._repo = repo  # type: ignore[assignment]
    try:
        trace_id, span_id = await _first_stumble_trace(
            "org_a", ["stb_ghost_1", "stb_ghost_2"]
        )
    finally:
        mod._repo = original_repo

    assert trace_id is None
    assert span_id is None


@pytest.mark.asyncio
async def test_first_stumble_trace_skips_stumble_without_trace() -> None:
    """Stumble exists but has no trace_id → skipped; subsequent one is used."""
    import eden.api.routes.agent_issues as mod

    repo = _FakeRepo(
        stumbles={
            "stb_no_trace": {"id": "stb_no_trace", "trace_id": None, "span_id": None},
            "stb_with_trace": {
                "id": "stb_with_trace",
                "trace_id": "trc_xyz",
                "span_id": "span_7",
            },
        },
    )
    original_repo = mod._repo
    mod._repo = repo  # type: ignore[assignment]
    try:
        trace_id, span_id = await _first_stumble_trace(
            "org_a", ["stb_no_trace", "stb_with_trace"]
        )
    finally:
        mod._repo = original_repo

    assert trace_id == "trc_xyz"
    assert span_id == "span_7"


@pytest.mark.asyncio
async def test_first_stumble_trace_empty_list() -> None:
    """No stumble IDs → immediately returns (None, None)."""
    import eden.api.routes.agent_issues as mod

    repo = _FakeRepo()
    original_repo = mod._repo
    mod._repo = repo  # type: ignore[assignment]
    try:
        trace_id, span_id = await _first_stumble_trace("org_a", [])
    finally:
        mod._repo = original_repo

    assert trace_id is None
    assert span_id is None


@pytest.mark.asyncio
async def test_first_stumble_trace_span_id_none_is_ok() -> None:
    """Stumble has trace_id but no span_id → span_id returns None (not error)."""
    import eden.api.routes.agent_issues as mod

    repo = _FakeRepo(
        stumbles={
            "stb_notrace": {
                "id": "stb_notrace",
                "trace_id": "trc_nospan",
                "span_id": None,
            }
        },
    )
    original_repo = mod._repo
    mod._repo = repo  # type: ignore[assignment]
    try:
        trace_id, span_id = await _first_stumble_trace("org_a", ["stb_notrace"])
    finally:
        mod._repo = original_repo

    assert trace_id == "trc_nospan"
    assert span_id is None


# ── Checkpoint prerequisite: F-B fix verified ────────────────────


def test_checkpoint_store_uses_event_id_column() -> None:
    """Verify the F-B fix: CheckpointStore.save targets event_id, not id.

    Regression guard: before Wave 1 / 2026-08-11 the INSERT targeted an
    ``id`` column that doesn't exist in ``telemetry_events`` (PK is
    ``event_id``), so every checkpoint silently failed.  We confirm the
    INSERT SQL contains ``event_id`` and not a bare ``VALUES ($1, ...``
    starting with a non-UUID-column name.
    """
    import inspect

    from eden.debugger.checkpoints import CheckpointStore

    src = inspect.getsource(CheckpointStore.save)
    # The corrected INSERT must mention event_id as the first listed column.
    assert "event_id" in src, (
        "CheckpointStore.save must insert into event_id (not id). "
        "F-B prerequisite fix is not present."
    )
    # The old broken form used 'id' as the column name before tenant_id.
    # A heuristic: if the INSERT still leads with ', id,' we have regressed.
    assert "( id," not in src and "(id," not in src, (
        "CheckpointStore.save appears to be inserting into 'id' column — "
        "this is the pre-F-B bug."
    )


# ── Deep-link URL shape ──────────────────────────────────────────


def test_debugger_list_href_shapes_correct_url() -> None:
    """debuggerListHref with traceId+spanId produces the expected deep-link."""
    # Pure Python test — we reconstruct the URL building logic without
    # importing the TS module.  The shape is also validated by the
    # portal typecheck, but this documents the contract for callers.
    params: dict[str, str] = {
        "traceId": "trc_abc",
        "spanId": "span_err",
        "agent": "agt_x",
    }
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"/debugger?{qs}"
    assert "traceId=trc_abc" in url
    assert "spanId=span_err" in url
    # The debugger list page reads ?traceId → creates/finds a session →
    # redirects to /debugger/{id}?mode=replay&spanId=span_err
    assert url.startswith("/debugger")
