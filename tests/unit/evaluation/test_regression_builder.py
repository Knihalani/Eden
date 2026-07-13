"""Unit tests for N01 regression builder."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from eden.evaluation.regression_builder import RegressionCaseBuilder, _issue_fingerprint


class _FakeIssue:
    def __init__(self) -> None:
        self.id = "iss-99"
        self.kind = "loop"
        self.fingerprint = "fp1"
        self.agent_id = "checkout"
        self.title = "Loop detected"
        self.triage_result = {"trace_id": "trace-a", "summary": "loop"}
        self.example_stumble_ids = []


class _FakeRepo:
    async def get_issue(self, org_id: str, issue_id: str):
        return _FakeIssue()

    async def list_stumbles(self, *args, **kwargs):
        return [SimpleNamespace(trace_id="trace-b")]


@pytest.mark.asyncio
async def test_from_issue_creates_cases(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("eden.issues.repo.IssuesRepo", lambda: _FakeRepo())
    builder = RegressionCaseBuilder()
    cases = await builder.from_issue("org-1", "iss-99", max_traces=2)
    assert len(cases) >= 1
    assert cases[0].source_issue_id == "iss-99"
    assert cases[0].auto_generated is True


def test_fingerprint_stable() -> None:
    a = _issue_fingerprint("loop", "fp1")
    b = _issue_fingerprint("loop", "fp1")
    assert a == b
