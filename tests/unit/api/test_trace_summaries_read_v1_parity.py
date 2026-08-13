"""Wave 0 / plan 1.1 verify — trace_summaries_read_v1 flag parity.

Asserts that ``GET /observability/traces`` returns an *identical*
``TraceListResponse`` payload when ``trace_summaries_read_v1=True``
(materialized path: ``trace_summaries`` table) vs ``False`` (legacy GROUP BY
on ``telemetry_events``), given equivalent mock data from a fake asyncpg
client.

No live Postgres required — the mock client routes by SQL keyword so the
real DB never needs to be present.

Coverage:
* Both code paths reach ``TraceListItem`` construction with the same values.
* The flag-toggle selects the correct path (verified via SQL keyword in
  mock routing).
* ``_trace_summaries_probe`` module-level cache is reset between calls so
  each assertion is independent.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.api.routes import observability as _obs_mod


# ---------------------------------------------------------------------------
# Shared test data — one fully-populated trace row.
# Column names match both the trace_summaries schema (migration 167) and
# the legacy telemetry_events GROUP BY alias list in list_traces().
# ---------------------------------------------------------------------------

_STARTED_AT = datetime(2026, 8, 1, 10, 0, 0, tzinfo=UTC)

_TRACE_ROW: dict[str, Any] = {
    "trace_id":        "t-par-001",
    "started_at":      _STARTED_AT,
    "realm":           "production",
    "agent_id":        "agent-par",
    "model":           "deepseek-v4-flash-0731",
    "provider":        "openrouter",
    "session_id":      "sess-par",
    "agent_session_id": "asid-par",
    "outcome":         "success",
    "error_type":      None,
    "attr_error":      None,
    "input_tokens":    200,
    "output_tokens":   100,
    "cost_usd":        0.0027,
    "span_count":      4,
    "duration_ms":     400.0,
    "tags":            ["cache_read", "agent_session_id:asid-par"],
}


class _SmartFake:
    """Fake asyncpg client routing both the materialized and legacy query paths.

    The mock does NOT inspect the full SQL; it just needs to return the right
    shape. Both paths ultimately call ``client.fetch(...)`` and the return
    value is processed identically by the ``TraceListItem`` constructor, which
    is the invariant under test.
    """

    def __init__(self) -> None:
        self.fetch_calls: list[str] = []
        self.fetchval_calls: list[str] = []

    async def fetchval(self, sql: str, *_args: Any) -> Any:
        self.fetchval_calls.append(sql)
        if "to_regclass" in sql:
            # _trace_summaries_known probe — table is present.
            return True
        # COUNT(*) query (legacy path, page < limit so not called in practice,
        # but be safe).
        return 1

    async def fetch(self, sql: str, *_args: Any) -> list[dict[str, Any]]:
        self.fetch_calls.append(sql)
        return [_TRACE_ROW]

    async def executemany(self, *_args: Any) -> None:  # pragma: no cover
        pass


def _settings(*, flag: bool) -> Any:
    """Minimal settings stub that only exposes trace_summaries_read_v1."""

    class _S:
        trace_summaries_read_v1 = flag

        def __getattr__(self, _name: str) -> Any:
            # Don't raise on any other attribute access.
            return None

    return _S()


async def _call(monkeypatch: Any, *, flag: bool) -> Any:
    """Call list_traces with the requested flag value."""
    import eden.storage.postgres as _pg

    # Reset the module-level table-probe cache between calls so each
    # invocation re-checks (avoids a cached True/False from a prior call
    # bleeding into the next).
    _obs_mod._trace_summaries_probe = None

    fake = _SmartFake()

    with (
        patch("eden.config.get_settings", return_value=_settings(flag=flag)),
        patch.object(_pg, "get_postgres_client", AsyncMock(return_value=fake)),
    ):
        return await _obs_mod.list_traces(
            org_id="org-parity",
            realm=None,
            outcome=None,
            agent_id=None,
            trace_id=None,
            trace_ids=None,
            limit=50,
            offset=0,
            days=7,
            user={"sub": "u-parity"},
        )


@pytest.mark.asyncio
async def test_flag_on_and_off_produce_identical_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both code paths must produce an identical TraceListResponse."""
    resp_off = await _call(monkeypatch, flag=False)
    resp_on = await _call(monkeypatch, flag=True)

    # Top-level shape.
    assert resp_on.total == resp_off.total, (
        f"total mismatch: flag=True gave {resp_on.total}, flag=False gave {resp_off.total}"
    )
    assert len(resp_on.traces) == len(resp_off.traces), "trace count mismatch"
    assert len(resp_on.traces) == 1, "expected exactly one trace in response"

    t_on = resp_on.traces[0]
    t_off = resp_off.traces[0]

    assert t_on.trace_id == t_off.trace_id, "trace_id mismatch"
    assert t_on.realm == t_off.realm, "realm mismatch"
    assert t_on.agent_id == t_off.agent_id, "agent_id mismatch"
    assert t_on.model == t_off.model, "model mismatch"
    assert t_on.outcome == t_off.outcome, "outcome mismatch"
    assert t_on.span_count == t_off.span_count, "span_count mismatch"
    assert t_on.input_tokens == t_off.input_tokens, "input_tokens mismatch"
    assert t_on.output_tokens == t_off.output_tokens, "output_tokens mismatch"
    assert t_on.cost_cents == t_off.cost_cents, "cost_cents mismatch"
    assert t_on.duration_ms == t_off.duration_ms, "duration_ms mismatch"
    assert sorted(t_on.tags or []) == sorted(t_off.tags or []), "tags mismatch"
    assert t_on.session_id == t_off.session_id, "session_id mismatch"
    assert t_on.agent_session_id == t_off.agent_session_id, "agent_session_id mismatch"
    assert t_on.started_at == t_off.started_at, "started_at mismatch"


@pytest.mark.asyncio
async def test_flag_on_queries_trace_summaries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the flag is True, the materialized path must be taken (queries
    trace_summaries, not telemetry_events GROUP BY)."""
    import eden.storage.postgres as _pg

    _obs_mod._trace_summaries_probe = None
    fake = _SmartFake()

    with (
        patch("eden.config.get_settings", return_value=_settings(flag=True)),
        patch.object(_pg, "get_postgres_client", AsyncMock(return_value=fake)),
    ):
        await _obs_mod.list_traces(
            org_id="org-parity",
            realm=None,
            outcome=None,
            agent_id=None,
            trace_id=None,
            trace_ids=None,
            limit=50,
            offset=0,
            days=7,
            user={"sub": "u-parity"},
        )

    # The materialized path uses trace_summaries; legacy uses telemetry_events
    # with GROUP BY. Verify the fetch SQL contains the summary table name.
    assert any("trace_summaries" in sql for sql in fake.fetch_calls), (
        "flag=True must query trace_summaries (materialized path), "
        f"but fetch was called with: {fake.fetch_calls}"
    )


@pytest.mark.asyncio
async def test_flag_off_queries_telemetry_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the flag is False, the legacy GROUP BY path must be taken."""
    import eden.storage.postgres as _pg

    _obs_mod._trace_summaries_probe = None
    fake = _SmartFake()

    with (
        patch("eden.config.get_settings", return_value=_settings(flag=False)),
        patch.object(_pg, "get_postgres_client", AsyncMock(return_value=fake)),
    ):
        await _obs_mod.list_traces(
            org_id="org-parity",
            realm=None,
            outcome=None,
            agent_id=None,
            trace_id=None,
            trace_ids=None,
            limit=50,
            offset=0,
            days=7,
            user={"sub": "u-parity"},
        )

    assert any("telemetry_events" in sql for sql in fake.fetch_calls), (
        "flag=False must query telemetry_events (legacy path), "
        f"but fetch was called with: {fake.fetch_calls}"
    )
    assert all("trace_summaries" not in sql for sql in fake.fetch_calls), (
        "flag=False must NOT query trace_summaries"
    )
