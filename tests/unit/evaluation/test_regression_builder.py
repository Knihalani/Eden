"""Unit tests for N01 regression builder."""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from eden.evaluation.regression_builder import (
    RegressionCase,
    RegressionCaseBuilder,
    _issue_fingerprint,
)


class _FakeDb:
    """Minimal SQL-aware asyncpg-shaped stub for ``datasets``/``dataset_items``.

    Covers exactly the queries ``RegressionCaseBuilder``/``DatasetHub``
    issue in the flow under test (FEAT-74): create-or-look-up a dataset
    by name, insert a ``dataset_items`` row honoring the
    ``(org_id, fingerprint)`` uniqueness ``153_regression_case_dataset_link``
    adds, and read cases back by fingerprint.
    """

    def __init__(self) -> None:
        self.datasets: dict[str, dict] = {}
        self.dataset_items: list[dict] = []

    async def fetch(self, query: str, *args):
        if "JOIN datasets d" in query:
            org_id, name_or_issue = args[0], args[1]
            rows = [
                self._joined(di)
                for di in self.dataset_items
                if di["org_id"] == org_id
            ]
            if "origin_issue_id = $2" in query:
                rows = [r for r in rows if r["source_issue_id"] == name_or_issue]
            elif "d.name = $2" in query and name_or_issue is not None:
                rows = [r for r in rows if r["dataset_name"] == name_or_issue]
            return rows
        if "FROM datasets d" in query:
            org_id = args[0]
            return [
                dict(d) for d in self.datasets.values() if d["org_id"] == org_id
            ]
        return []

    async def fetchrow(self, query: str, *args):
        if "INSERT INTO datasets" in query:
            dataset_id = args[0]
            row = {
                "id": dataset_id,
                "org_id": args[1],
                "name": args[2],
                "description": args[3],
                "source_type": args[4],
                "source_ref": args[5],
                "version": 1,
                "created_at": "2026-01-01T00:00:00+00:00",
                "updated_at": "2026-01-01T00:00:00+00:00",
            }
            self.datasets[dataset_id] = row
            return dict(row)
        if "FROM telemetry_events" in query:
            return None
        if "FROM dataset_items di" in query:
            org_id, fingerprint = args[0], args[1]
            for di in self.dataset_items:
                if di["org_id"] == org_id and di["fingerprint"] == fingerprint:
                    return self._joined(di)
            return None
        return None

    async def execute(self, query: str, *args):
        if "INSERT INTO dataset_items" in query:
            (
                item_id,
                dataset_id,
                input_text,
                expected_text,
                payload,
                origin_trace_id,
                origin_issue_id,
                org_id,
                fingerprint,
                auto_generated,
            ) = args
            if fingerprint is not None and any(
                di["org_id"] == org_id and di["fingerprint"] == fingerprint
                for di in self.dataset_items
            ):
                return "INSERT 0 0"  # ON CONFLICT DO NOTHING
            self.dataset_items.append(
                {
                    "id": item_id,
                    "dataset_id": dataset_id,
                    "input": input_text,
                    "expected_output": expected_text,
                    "payload": payload,
                    "origin_trace_id": origin_trace_id,
                    "origin_issue_id": origin_issue_id,
                    "org_id": org_id,
                    "fingerprint": fingerprint,
                    "auto_generated": auto_generated,
                    "created_at": "2026-01-01T00:00:00+00:00",
                }
            )
            return "INSERT 0 1"
        return "OK"

    def _joined(self, di: dict) -> dict:
        dataset = self.datasets.get(di["dataset_id"], {})
        return {
            "id": di["id"],
            "org_id": di["org_id"],
            "dataset_name": dataset.get("name"),
            "source_issue_id": di["origin_issue_id"],
            "source_trace_id": di["origin_trace_id"],
            "fingerprint": di["fingerprint"],
            "auto_generated": di["auto_generated"],
            "input": di["input"],
            "expected_output": di["expected_output"],
            "payload": di["payload"],
            "created_at": di["created_at"],
        }


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


def test_default_construction_is_not_memory_only() -> None:
    """Regression guard: production call sites construct ``RegressionCaseBuilder()``
    without passing ``pg`` explicitly (e.g. agent_issues routes, ``on_issue_resolved``).
    Prior to the fix, ``_memory_only`` was derived from ``pg is None``, which forced
    every production path into memory-only mode and silently dropped persistence to
    Postgres. ``_memory_only`` must now be an explicit opt-in, defaulting to False so
    the builder falls back to fetching a real Postgres client lazily."""
    builder = RegressionCaseBuilder()
    assert builder._memory_only is False


def test_explicit_memory_only_still_supported() -> None:
    """Tests that intentionally want memory-only mode must opt in explicitly."""
    builder = RegressionCaseBuilder(memory_only=True)
    assert builder._memory_only is True


@pytest.mark.asyncio
async def test_persist_writes_dataset_item_with_uuid_dataset_id() -> None:
    """FEAT-74: a persisted case lands in ``dataset_items`` under a
    resolvable UUID dataset — not the old free-text ``dataset_id``."""
    db = _FakeDb()
    builder = RegressionCaseBuilder(pg=db)
    case = RegressionCase(
        id=str(uuid.uuid4()),
        org_id="org-1",
        dataset_id="checkout/regressions",
        source_issue_id="iss-1",
        source_trace_id="trace-1",
        fingerprint="fp-abc",
        auto_generated=True,
        input_data={"messages": []},
        expected_data={"no_stumble_kinds": ["loop"]},
        metadata={"triage_summary": "loop"},
    )
    await builder._persist(case)

    assert len(db.dataset_items) == 1
    item = db.dataset_items[0]
    # dataset_items.dataset_id is a real UUID, resolvable back to a
    # ``datasets`` row — the whole point of FEAT-74.
    assert uuid.UUID(item["dataset_id"])
    dataset = db.datasets[item["dataset_id"]]
    assert dataset["org_id"] == "org-1"
    # The old free-text identifier survives as the dataset's name.
    assert dataset["name"] == "checkout/regressions"
    assert item["org_id"] == "org-1"
    assert item["fingerprint"] == "fp-abc"
    assert item["origin_issue_id"] == "iss-1"
    assert item["origin_trace_id"] == "trace-1"

    # A second case against the same free-text name reuses the dataset
    # instead of creating a duplicate ``datasets`` row.
    case2 = RegressionCase(
        id=str(uuid.uuid4()),
        org_id="org-1",
        dataset_id="checkout/regressions",
        source_issue_id="iss-2",
        source_trace_id="trace-2",
        fingerprint="fp-def",
        auto_generated=True,
    )
    await builder._persist(case2)
    assert len(db.datasets) == 1
    assert len(db.dataset_items) == 2


@pytest.mark.asyncio
async def test_find_by_fingerprint_dedup_via_dataset_items() -> None:
    """FEAT-74: ``_find_by_fingerprint`` dedup now reads ``dataset_items``,
    and the ``(org_id, fingerprint)`` uniqueness still blocks duplicates."""
    db = _FakeDb()
    builder = RegressionCaseBuilder(pg=db)
    first = RegressionCase(
        id=str(uuid.uuid4()),
        org_id="org-1",
        dataset_id="checkout/regressions",
        source_issue_id="iss-1",
        source_trace_id="trace-1",
        fingerprint="dup-fp",
        auto_generated=True,
        expected_data={"no_stumble_kinds": ["loop"]},
    )
    await builder._persist(first)

    # No match yet for a different fingerprint.
    assert await builder._find_by_fingerprint("org-1", "other-fp") is None

    found = await builder._find_by_fingerprint("org-1", "dup-fp")
    assert found is not None
    assert found.id == first.id
    assert found.fingerprint == "dup-fp"
    assert found.dataset_id == "checkout/regressions"
    assert found.expected_data == {"no_stumble_kinds": ["loop"]}

    # A duplicate case for the same fingerprint is a no-op at the
    # dataset_items layer (ON CONFLICT DO NOTHING on the unique index
    # from 153_regression_case_dataset_link).
    duplicate = RegressionCase(
        id=str(uuid.uuid4()),
        org_id="org-1",
        dataset_id="checkout/regressions",
        source_issue_id="iss-2",
        source_trace_id="trace-2",
        fingerprint="dup-fp",
        auto_generated=True,
    )
    await builder._persist(duplicate)
    assert len(db.dataset_items) == 1

    still_first = await builder._find_by_fingerprint("org-1", "dup-fp")
    assert still_first is not None
    assert still_first.id == first.id


@pytest.mark.asyncio
async def test_from_issue_dedup_via_dataset_items(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: calling ``from_issue`` twice for the same issue only
    creates cases once, thanks to the dataset_items-backed dedup."""
    monkeypatch.setattr("eden.issues.repo.IssuesRepo", lambda: _FakeRepo())
    db = _FakeDb()
    builder = RegressionCaseBuilder(pg=db)

    first_cases = await builder.from_issue("org-1", "iss-99", max_traces=2)
    assert len(first_cases) >= 1
    assert len(db.dataset_items) == len(first_cases)

    second_cases = await builder.from_issue("org-1", "iss-99", max_traces=2)
    # The fingerprint dedup short-circuits to the existing case.
    assert len(second_cases) == 1
    assert second_cases[0].id == first_cases[0].id
    assert len(db.dataset_items) == len(first_cases)


@pytest.mark.asyncio
async def test_persist_does_not_touch_legacy_regression_eval_cases() -> None:
    """FEAT-74: writes go only to ``dataset_items``, not ``regression_eval_cases``."""
    db = _FakeDb()
    executed_queries: list[str] = []
    original_execute = db.execute

    async def _tracking_execute(query: str, *args):
        executed_queries.append(query)
        return await original_execute(query, *args)

    db.execute = _tracking_execute  # type: ignore[method-assign]
    builder = RegressionCaseBuilder(pg=db)
    case = RegressionCase(
        id=str(uuid.uuid4()),
        org_id="org-1",
        dataset_id="checkout/regressions",
        source_issue_id="iss-1",
        source_trace_id="trace-1",
        fingerprint="fp-only-dataset-items",
        auto_generated=True,
    )
    await builder._persist(case)

    assert len(db.dataset_items) == 1
    assert any("INSERT INTO dataset_items" in q for q in executed_queries)
    assert not any("regression_eval_cases" in q for q in executed_queries)


@pytest.mark.asyncio
async def test_list_cases_reads_dataset_items_only() -> None:
    db = _FakeDb()
    builder = RegressionCaseBuilder(pg=db)
    case = RegressionCase(
        id=str(uuid.uuid4()),
        org_id="org-1",
        dataset_id="checkout/regressions",
        source_issue_id="iss-list",
        source_trace_id="trace-list",
        fingerprint="fp-list",
        auto_generated=True,
        expected_data={"no_stumble_kinds": ["loop"]},
    )
    await builder._persist(case)

    listed = await builder.list_cases("org-1", agent_id="checkout", limit=10)
    assert len(listed) == 1
    assert listed[0].id == case.id
    assert listed[0].dataset_id == "checkout/regressions"


@pytest.mark.asyncio
async def test_list_for_issue_reads_dataset_items_only() -> None:
    db = _FakeDb()
    builder = RegressionCaseBuilder(pg=db)
    case = RegressionCase(
        id=str(uuid.uuid4()),
        org_id="org-1",
        dataset_id="checkout/regressions",
        source_issue_id="iss-for-issue",
        source_trace_id="trace-for-issue",
        fingerprint="fp-for-issue",
        auto_generated=True,
    )
    await builder._persist(case)

    listed = await builder.list_for_issue("org-1", "iss-for-issue")
    assert len(listed) == 1
    assert listed[0].id == case.id
    assert listed[0].source_issue_id == "iss-for-issue"
