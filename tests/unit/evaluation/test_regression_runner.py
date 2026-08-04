"""Unit tests for N01 regression runner (fail-closed tri-state model)."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from eden.evaluation.regression_builder import RegressionCase
from eden.evaluation.regression_runner import RegressionRunner


def _case(
    *,
    case_id: str = "c1",
    trace_id: str | None = None,
    expected: dict | None = None,
) -> RegressionCase:
    return RegressionCase(
        id=case_id,
        org_id="org-1",
        dataset_id="ds",
        source_issue_id=None,
        source_trace_id=trace_id,
        fingerprint=None,
        auto_generated=True,
        expected_data=expected or {},
    )


class _FakePg:
    """Minimal asyncpg-shaped stub."""

    def __init__(
        self,
        rows: list[dict] | None = None,
        *,
        raise_on_fetch: bool = False,
    ) -> None:
        self._rows = rows or []
        self._raise = raise_on_fetch
        self.executed: list[tuple] = []

    async def fetch(self, query: str, *args):
        if self._raise:
            raise RuntimeError("connection refused")
        return list(self._rows)

    async def fetchrow(self, query: str, *args):
        if self._raise:
            raise RuntimeError("connection refused")
        return None

    async def execute(self, query: str, *args):
        self.executed.append((query, args))
        return "INSERT 0 1"


def _stub_cases(runner: RegressionRunner, cases: list[RegressionCase]) -> None:
    async def _list(*args, **kwargs):
        return cases

    runner._builder.list_cases = _list  # type: ignore[method-assign]


def _set_policy(monkeypatch, value: str) -> None:
    from eden.config import get_settings

    monkeypatch.setattr(
        get_settings(), "regression_gate_skip_policy", value
    )


@pytest.mark.asyncio
async def test_run_suite_empty_passes() -> None:
    runner = RegressionRunner(memory_only=True)
    _stub_cases(runner, [])
    result = await runner.run_suite("org-1")
    assert result.ok
    assert result.failed == 0
    assert result.skipped == 0
    assert result.errors == 0


@pytest.mark.asyncio
async def test_evaluate_case_no_constraints_is_skipped() -> None:
    runner = RegressionRunner(memory_only=True)
    status, reason = await runner._evaluate_case(_case())
    assert status == "skipped"
    assert reason == "no_constraints"


@pytest.mark.asyncio
async def test_no_trace_case_is_skipped_not_passed(monkeypatch) -> None:
    _set_policy(monkeypatch, "allow")
    runner = RegressionRunner(memory_only=True)
    _stub_cases(
        runner,
        [_case(expected={"no_stumble_kinds": ["loop"]})],  # no trace_id
    )
    result = await runner.run_suite("org-1")
    assert result.passed == 0
    assert result.skipped == 1
    assert result.errors == 0
    assert result.ok  # skips allowed by default policy
    entry = result.cases[0]
    assert entry["status"] == "skipped"
    assert entry["reason"] == "no_trace"


@pytest.mark.asyncio
async def test_skip_policy_block_fails_gate(monkeypatch) -> None:
    _set_policy(monkeypatch, "block")
    runner = RegressionRunner(memory_only=True)
    _stub_cases(
        runner,
        [_case(expected={"no_stumble_kinds": ["loop"]})],
    )
    result = await runner.run_suite("org-1")
    assert result.skipped == 1
    assert not result.ok


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", ["allow", "block"])
async def test_telemetry_client_none_is_error(monkeypatch, policy) -> None:
    _set_policy(monkeypatch, policy)
    runner = RegressionRunner(memory_only=True)  # client resolves to None
    _stub_cases(
        runner,
        [
            _case(
                trace_id="t1",
                expected={"no_stumble_kinds": ["loop"]},
            )
        ],
    )
    result = await runner.run_suite("org-1")
    assert result.errors == 1
    assert result.passed == 0
    assert not result.ok  # error fails the gate regardless of policy
    assert result.cases[0]["status"] == "error"
    assert result.cases[0]["reason"] == "telemetry_unavailable"
    assert any(f["status"] == "error" for f in result.failures)


@pytest.mark.asyncio
async def test_query_exception_is_error() -> None:
    pg = _FakePg(raise_on_fetch=True)
    runner = RegressionRunner(pg=pg)
    _stub_cases(
        runner,
        [
            _case(
                trace_id="t1",
                expected={"no_stumble_kinds": ["loop"]},
            )
        ],
    )
    result = await runner.run_suite("org-1")
    assert result.errors == 1
    assert not result.ok
    assert result.cases[0]["reason"] == "telemetry_unavailable"


@pytest.mark.asyncio
async def test_clean_trace_still_passes() -> None:
    pg = _FakePg(rows=[{"kind": "timeout"}])
    runner = RegressionRunner(pg=pg)
    _stub_cases(
        runner,
        [
            _case(
                trace_id="t1",
                expected={"no_stumble_kinds": ["loop"]},
            )
        ],
    )
    result = await runner.run_suite("org-1")
    assert result.passed == 1
    assert result.ok


@pytest.mark.asyncio
async def test_stumble_present_fails() -> None:
    pg = _FakePg(rows=[{"kind": "loop"}])
    runner = RegressionRunner(pg=pg)
    _stub_cases(
        runner,
        [
            _case(
                trace_id="t1",
                expected={"no_stumble_kinds": ["loop"]},
            )
        ],
    )
    result = await runner.run_suite("org-1")
    assert result.failed == 1
    assert not result.ok


@pytest.mark.asyncio
async def test_canary_gate_skips_low_traffic() -> None:
    runner = RegressionRunner(memory_only=True)
    assert (
        await runner.require_pass_for_canary(
            "org-1", agent_id="a", traffic_pct=5
        )
        is None
    )


@pytest.mark.asyncio
async def test_canary_409_includes_breakdown() -> None:
    runner = RegressionRunner(memory_only=True)  # telemetry unavailable
    _stub_cases(
        runner,
        [
            _case(
                trace_id="t1",
                expected={"no_stumble_kinds": ["loop"]},
            )
        ],
    )
    with pytest.raises(HTTPException) as excinfo:
        await runner.require_pass_for_canary(
            "org-1", agent_id="a", traffic_pct=25
        )
    assert excinfo.value.status_code == 409
    detail = excinfo.value.detail
    assert detail["code"] == "regression_gate_failed"
    breakdown = detail["breakdown"]
    assert set(breakdown) >= {"passed", "failed", "skipped", "errors"}
    assert breakdown["errors"] == 1
    assert detail["run"]["errors"] == 1
    assert detail["run"]["cases"][0]["reason"] == "telemetry_unavailable"
