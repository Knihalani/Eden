"""FEAT-167 — dataset_items.split on hub API and offline runner."""

from __future__ import annotations

import json
from typing import Any

import pytest

from eden.datasets.hub import DatasetHub


class FakeHubPg:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.datasets: dict[str, dict[str, Any]] = {}

    async def execute(self, query: str, *args: Any) -> str:
        sql = " ".join(query.strip().lower().split())
        if "insert into dataset_items" in sql:
            row_id, dataset_id, input_data, expected_output, payload, origin_trace_id, split = args
            self.items.append(
                {
                    "id": row_id,
                    "dataset_id": dataset_id,
                    "input": input_data,
                    "expected_output": expected_output,
                    "payload": payload,
                    "origin_trace_id": origin_trace_id,
                    "split": split,
                    "created_at": "2026-08-07T00:00:00+00:00",
                }
            )
            return "INSERT 0 1"
        return "OK"

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        sql = " ".join(query.strip().lower().split())
        if "from dataset_items" in sql and "where dataset_id" in sql:
            dataset_id, limit, offset, split = args
            rows = [
                r
                for r in self.items
                if r["dataset_id"] == dataset_id
                and (split is None or r.get("split") == split)
            ]
            return rows[offset : offset + limit]
        return []

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        sql = " ".join(query.strip().lower().split())
        if "from dataset_items" in sql and "where dataset_id" in sql and "and id" in sql:
            dataset_id, item_id = args
            for row in self.items:
                if row["dataset_id"] == dataset_id and row["id"] == item_id:
                    return dict(row)
        return None


@pytest.mark.asyncio
async def test_add_dataset_item_persists_split() -> None:
    pg = FakeHubPg()
    hub = DatasetHub(pg=pg, memory_only=False)
    result = await hub.add_dataset_item(
        "ds-1",
        input_data="hello",
        expected_output="world",
        split="smoke",
    )
    assert result["split"] == "smoke"
    assert len(pg.items) == 1
    assert pg.items[0]["split"] == "smoke"


@pytest.mark.asyncio
async def test_list_dataset_items_filters_by_split() -> None:
    pg = FakeHubPg()
    pg.items = [
        {
            "id": "a",
            "dataset_id": "ds-1",
            "input": "1",
            "expected_output": "",
            "payload": "{}",
            "origin_trace_id": None,
            "split": "smoke",
            "created_at": "t1",
        },
        {
            "id": "b",
            "dataset_id": "ds-1",
            "input": "2",
            "expected_output": "",
            "payload": "{}",
            "origin_trace_id": None,
            "split": "full",
            "created_at": "t2",
        },
    ]
    hub = DatasetHub(pg=pg, memory_only=False)
    smoke = await hub.list_dataset_items("ds-1", split="smoke")
    assert [r["id"] for r in smoke] == ["a"]
    all_items = await hub.list_dataset_items("ds-1")
    assert len(all_items) == 2


@pytest.mark.asyncio
async def test_offline_runner_honors_config_split_filter() -> None:
    from eden.experiments.offline_runner import OfflineExperimentRunner
    from eden.prompts.registry import PlaygroundResult

    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        user = str(prompt_dict.get("user") or "")
        return PlaygroundResult(
            template_name="",
            template_version=0,
            model="t1",
            response=f"echo:{user}",
            latency_ms=1.0,
            prompt_tokens=1,
            completion_tokens=1,
            cost_usd=0.0,
            created_at="2026-08-07T00:00:00+00:00",
        )

    class SplitPg:
        def __init__(self) -> None:
            self.items = [
                {"id": "r1", "input": "a", "expected_output": "", "payload": None, "split": "smoke"},
                {"id": "r2", "input": "b", "expected_output": "", "payload": None, "split": "full"},
            ]
            self.status = "pending"
            self.datapoints: list[Any] = []

        async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
            if "offline_experiments" in sql:
                return {
                    "id": "exp-1",
                    "org_id": "org-1",
                    "dataset_id": "ds-1",
                    "config": {"split": "smoke", "tasks": [{"user": "{{user}}", "model": "t1"}]},
                    "baseline_experiment_id": None,
                    "dataset_snapshot_id": None,
                    "source_issue_id": None,
                    "status": self.status,
                }
            return None

        async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
            if "dataset_items" in sql:
                dataset_id, split_filter = args
                assert dataset_id == "ds-1"
                assert split_filter == "smoke"
                return [self.items[0]]
            return []

        async def execute(self, sql: str, *args: Any) -> None:
            if "INSERT INTO experiment_datapoints" in sql:
                self.datapoints.append(args)

    pg = SplitPg()
    runner = OfflineExperimentRunner(pg=pg, llm_handler=handler)
    result = await runner.run("org-1", "exp-1")
    assert result["rows"] == 1
    assert len(pg.datapoints) == 1
