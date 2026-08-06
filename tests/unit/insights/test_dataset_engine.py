"""Unit tests for FEAT-75 — DatasetGenerationEngine durability via DatasetHub.

Uses a small ``FakePg`` (same pattern as ``tests/unit/test_datasets_spreadsheet.py``)
backing the ``datasets`` / ``dataset_items`` tables, so we can prove entries
round-trip through the *storage interface* DatasetHub talks to, rather than
merely moving state into a differently-named in-memory structure.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest

from eden.datasets.hub import DatasetHub
from eden.insights.dataset_engine import (
    AutoPromote,
    Dataset,
    DatasetEntry,
    DatasetGenerationEngine,
    DatasetRule,
    DatasetType,
)
from eden.insights.unified_trace_model import Outcome, Realm, UnifiedTrace

# ── Fake PG (backs `datasets` + `dataset_items`) ────────────────────────────


class FakePg:
    """In-memory stand-in for the async Postgres client DatasetHub expects.

    State lives on the ``FakePg`` instance itself (not on any ``DatasetHub``
    or ``DatasetGenerationEngine``), so handing the *same* ``FakePg`` to two
    independently-constructed ``DatasetHub``/``DatasetGenerationEngine``
    pairs simulates data surviving a process restart against a real
    Postgres.
    """

    def __init__(self) -> None:
        self.datasets: dict[str, dict[str, Any]] = {}
        self.items: list[dict[str, Any]] = []

    def _row_with_count(self, row: dict[str, Any]) -> dict[str, Any]:
        out = dict(row)
        out["row_count"] = len([i for i in self.items if i["dataset_id"] == row["id"]])
        out["column_count"] = 0
        return out

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        sql = " ".join(query.strip().lower().split())
        if sql.startswith("insert into datasets"):
            dataset_id, org_id, name, description, source_type, source_ref = args
            now = datetime.now(UTC)
            row = {
                "id": dataset_id,
                "org_id": org_id,
                "name": name,
                "description": description,
                "source_type": source_type,
                "source_ref": source_ref,
                "version": 1,
                "created_at": now,
                "updated_at": now,
            }
            self.datasets[dataset_id] = row
            return self._row_with_count(row)
        if sql.startswith("select") and "from datasets d" in sql:
            if "where d.org_id" in sql and "d.id" in sql:
                org_id, dataset_id = args
                row = self.datasets.get(dataset_id)
                if row and row["org_id"] == org_id:
                    return self._row_with_count(row)
                return None
            if "where d.id" in sql:
                dataset_id = args[0]
                row = self.datasets.get(dataset_id)
                return self._row_with_count(row) if row else None
        return None

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        sql = " ".join(query.strip().lower().split())
        if "from datasets d" in sql:
            org_id, limit = args
            rows = [self._row_with_count(r) for r in self.datasets.values() if r["org_id"] == org_id]
            return rows[:limit]
        if "from dataset_items" in sql:
            dataset_id, limit, offset = args
            rows = sorted(
                (r for r in self.items if r["dataset_id"] == dataset_id),
                key=lambda r: r["created_at"],
            )
            return rows[offset : offset + limit]
        return []

    async def execute(self, query: str, *args: Any) -> str:
        sql = " ".join(query.strip().lower().split())
        if sql.startswith("insert into dataset_items"):
            row_id, dataset_id, input_data, expected_output, payload, origin_trace_id = args
            if isinstance(payload, str):
                payload = json.loads(payload)
            self.items.append(
                {
                    "id": row_id,
                    "dataset_id": dataset_id,
                    "input": input_data,
                    "expected_output": expected_output,
                    "payload": payload or {},
                    "origin_trace_id": origin_trace_id,
                    "created_at": datetime.now(UTC),
                }
            )
            return "INSERT 0 1"
        if sql.startswith("update datasets set updated_at"):
            dataset_id = args[0]
            row = self.datasets.get(dataset_id)
            if row:
                row["version"] += 1
                row["updated_at"] = datetime.now(UTC)
            return "UPDATE 1"
        return "OK"


def _failing_prod_trace(tenant_id: str, trace_id: str = "trace-1") -> UnifiedTrace:
    """A trace that matches the always-on `production_failures` default rule."""
    return UnifiedTrace(
        trace_id=trace_id,
        tenant_id=tenant_id,
        realm=Realm.PRODUCTION,
        outcome=Outcome.FAILURE,
        agent_id="agent-x",
    )


# ── Tests ────────────────────────────────────────────────────────────────


def test_generated_dataset_survives_fresh_engine_and_hub() -> None:
    """The core FEAT-75 assertion: entries created by one
    DatasetGenerationEngine/DatasetHub pair are visible from a completely
    fresh pair pointed at the same underlying store — i.e. state lives in
    the database layer, not in either object's `__init__`."""
    shared_pg = FakePg()
    tenant_id = "org-durable"

    engine1 = DatasetGenerationEngine(hub=DatasetHub(pg=shared_pg))
    created = engine1.process_trace(_failing_prod_trace(tenant_id))
    assert len(created) == 1
    entry = created[0]
    assert entry.dataset_id  # placeholder was replaced with the real hub id

    # Fresh engine + fresh hub, no shared Python state at all — only the
    # FakePg (standing in for Postgres) is shared, simulating a restart.
    engine2 = DatasetGenerationEngine(hub=DatasetHub(pg=shared_pg))

    datasets = engine2.list_datasets(tenant_id)
    assert len(datasets) == 1
    dataset = datasets[0]
    assert isinstance(dataset, Dataset)
    assert dataset.name == "prod_failures"
    assert dataset.dataset_type == DatasetType.REGRESSION_SUITE
    assert dataset.entry_count == 1
    assert dataset.tenant_id == tenant_id

    fetched = engine2.get_dataset(entry.dataset_id)
    assert fetched is not None
    assert fetched.dataset_id == entry.dataset_id

    entries = engine2.get_entries(entry.dataset_id)
    assert len(entries) == 1
    round_tripped = entries[0]
    assert isinstance(round_tripped, DatasetEntry)
    assert round_tripped.source_trace_id == "trace-1"
    assert round_tripped.extract_rule == "production_failures"
    assert round_tripped.input_data.get("trace_id") == "trace-1"
    assert round_tripped.input_data.get("agent_id") == "agent-x"
    assert round_tripped.metadata.get("outcome") == "failure"
    assert round_tripped.lineage  # non-empty, preserved through the round trip


def test_second_entry_in_same_dataset_increments_count_after_restart() -> None:
    shared_pg = FakePg()
    tenant_id = "org-durable-2"

    engine1 = DatasetGenerationEngine(hub=DatasetHub(pg=shared_pg))
    engine1.process_trace(_failing_prod_trace(tenant_id, "trace-a"))

    # Simulate a restart before the second trace arrives.
    engine2 = DatasetGenerationEngine(hub=DatasetHub(pg=shared_pg))
    engine2.process_trace(_failing_prod_trace(tenant_id, "trace-b"))

    # A third, independent engine/hub pair reads back both entries — proves
    # the two writes landed in the same durable dataset rather than two
    # different in-memory dicts.
    engine3 = DatasetGenerationEngine(hub=DatasetHub(pg=shared_pg))
    datasets = engine3.list_datasets(tenant_id)
    assert len(datasets) == 1
    assert datasets[0].entry_count == 2

    entries = engine3.get_entries(datasets[0].dataset_id)
    trace_ids = {e.source_trace_id for e in entries}
    assert trace_ids == {"trace-a", "trace-b"}


def test_export_dataset_after_restart() -> None:
    shared_pg = FakePg()
    tenant_id = "org-export"

    engine1 = DatasetGenerationEngine(hub=DatasetHub(pg=shared_pg))
    created = engine1.process_trace(_failing_prod_trace(tenant_id))
    dataset_id = created[0].dataset_id

    engine2 = DatasetGenerationEngine(hub=DatasetHub(pg=shared_pg))
    export = engine2.export_dataset(dataset_id, format_type="jsonl")
    assert export["total_entries"] == 1
    line = json.loads(export["data"].splitlines()[0])
    assert line["source_trace_id"] == "trace-1"


def test_process_batch_groups_by_durable_dataset_id() -> None:
    shared_pg = FakePg()
    tenant_id = "org-batch"
    engine = DatasetGenerationEngine(hub=DatasetHub(pg=shared_pg))

    traces = [
        _failing_prod_trace(tenant_id, "trace-1"),
        _failing_prod_trace(tenant_id, "trace-2"),
    ]
    results = engine.process_batch(traces)
    assert len(results) == 1
    (dataset_id, entries), = results.items()
    assert len(entries) == 2
    # The key is DatasetHub's real id, not the internal placeholder format.
    assert dataset_id == entries[0].dataset_id


def test_memory_only_hub_still_functions_within_one_process() -> None:
    """Sanity check for the default (no injected pg) construction path —
    doesn't assert cross-restart durability, just that nothing breaks when
    DatasetHub falls back to its own in-memory dataset store."""
    engine = DatasetGenerationEngine(hub=DatasetHub(memory_only=True))
    created = engine.process_trace(_failing_prod_trace("org-mem"))
    assert len(created) == 1
    datasets = engine.list_datasets("org-mem")
    assert len(datasets) == 1
    assert datasets[0].name == "prod_failures"


def test_get_stats_reports_rule_matches() -> None:
    shared_pg = FakePg()
    engine = DatasetGenerationEngine(hub=DatasetHub(pg=shared_pg))
    engine.process_trace(_failing_prod_trace("org-stats"))
    stats = engine.get_stats()
    assert stats["rules"]["production_failures"]["matches"] == 1
    assert stats["rules"]["production_failures"]["promoted"] == 1
    assert stats["total_datasets"] == 1
    assert stats["total_entries"] == 1


def test_custom_rule_dataset_type_round_trips() -> None:
    shared_pg = FakePg()
    tenant_id = "org-custom-rule"
    custom_rule = DatasetRule(
        name="custom_golden",
        description="custom",
        realm=Realm.PRODUCTION,
        outcome=Outcome.SUCCESS,
        dataset_type=DatasetType.GOLDEN_PATH,
        dataset_name="custom_golden_ds",
        auto_promote=AutoPromote.ALWAYS,
    )
    engine1 = DatasetGenerationEngine(rules=[custom_rule], hub=DatasetHub(pg=shared_pg))
    trace = UnifiedTrace(
        trace_id="trace-golden",
        tenant_id=tenant_id,
        realm=Realm.PRODUCTION,
        outcome=Outcome.SUCCESS,
    )
    created = engine1.process_trace(trace)
    assert len(created) == 1

    # A fresh engine constructed with the SAME rule set (as would happen on
    # a real restart, since rules are supplied by the caller/config) still
    # resolves the right dataset_type from `source_ref`.
    engine2 = DatasetGenerationEngine(rules=[custom_rule], hub=DatasetHub(pg=shared_pg))
    datasets = engine2.list_datasets(tenant_id)
    assert len(datasets) == 1
    assert datasets[0].dataset_type == DatasetType.GOLDEN_PATH


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-v"]))
