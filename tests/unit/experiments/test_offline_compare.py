"""Unit tests for F51 offline experiment runner (FEAT-12 real scoring)."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest

from eden.experiments.compare import aggregate_grades, build_case_grade_row, grade_datapoint
from eden.prompts.registry import PlaygroundResult


def test_grade_improvement() -> None:
    grade, delta = grade_datapoint({"score": 0.5}, {"score": 0.8})
    assert grade == "improvement"
    assert delta > 0


def test_grade_regression() -> None:
    grade, _ = grade_datapoint({"score": 0.9}, {"score": 0.4})
    assert grade == "regression"


def test_aggregate() -> None:
    counts = aggregate_grades(["improvement", "improvement", "regression", "tie"])
    assert counts["improvement"] == 2
    assert counts["regression"] == 1


def test_build_case_grade_row_improvement() -> None:
    row = build_case_grade_row("c1", baseline_score=0.5, current_score=0.9)
    assert row["metric"] == "case:c1"
    assert row["verdict"] == "improvement"
    assert row["delta"] == pytest.approx(0.4)


def test_build_case_grade_row_skipped_when_unscored() -> None:
    row = build_case_grade_row("c2", baseline_score=0.5, current_score=None)
    assert row["verdict"] == "skipped"
    assert row["current"] is None


def _llm_result(prompt_dict: dict[str, Any], *, user: str | None = None) -> PlaygroundResult:
    text = user or str(prompt_dict.get("user") or "")
    return PlaygroundResult(
        template_name="",
        template_version=0,
        model=str(prompt_dict.get("model") or "t1"),
        response=f"echo:{text}",
        latency_ms=1.0,
        prompt_tokens=1,
        completion_tokens=1,
        cost_usd=0.002,
        created_at="2026-08-01T00:00:00+00:00",
    )


def _tasks() -> list[dict[str, Any]]:
    return [
        {
            "id": "task_a",
            "label": "Control",
            "system": "",
            "user": "{{user}}",
            "model": "t1",
            "tools": [],
        },
        {
            "id": "task_b",
            "label": "Treatment",
            "system": "",
            "user": "{{user}}",
            "model": "t2",
            "tools": [],
        },
    ]


class FakeOfflinePg:
    """Minimal Postgres stub for OfflineExperimentRunner.run()."""

    def __init__(
        self,
        *,
        org_id: str,
        experiment_id: str,
        dataset_id: str,
        config: dict[str, Any],
        items: list[dict[str, Any]],
    ) -> None:
        self.org_id = org_id
        self.experiment_id = experiment_id
        self.dataset_id = dataset_id
        self.config = config
        self.items = items
        self.datapoints: list[dict[str, Any]] = []
        self.status = "pending"
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        self.calls.append(("fetchrow", args))
        if "offline_experiments" in sql and "WHERE org_id" in sql:
            return {
                "id": self.experiment_id,
                "org_id": self.org_id,
                "dataset_id": self.dataset_id,
                "config": self.config,
                "baseline_experiment_id": None,
                "dataset_snapshot_id": None,
                "source_issue_id": None,
                "status": self.status,
            }
        return None

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        self.calls.append(("fetch", args))
        if "dataset_items" in sql:
            return self.items
        if "experiment_datapoints" in sql:
            return self.datapoints
        return []

    async def execute(self, sql: str, *args: Any) -> None:
        self.calls.append(("execute", args))
        if "UPDATE offline_experiments" in sql and "status = 'completed'" in sql:
            self.status = "completed"
        if "INSERT INTO experiment_datapoints" in sql:
            self.datapoints.append(
                {
                    "row_id": args[2],
                    "control_output": args[4],
                    "treatment_output": args[5],
                    "grade": args[6],
                    "score_delta": args[7],
                }
            )


@pytest.mark.asyncio
async def test_run_row_uses_real_scoring_not_heuristic_stub() -> None:
    from eden.experiments.offline_runner import OfflineExperimentRunner

    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        return _llm_result(prompt_dict)

    runner = OfflineExperimentRunner(llm_handler=handler)
    config = {
        "org_id": "org_f12",
        "tasks": _tasks(),
        "scorers": [{"type": "exact_match"}],
    }
    out = await runner._run_row(
        {"input": "hello", "expected_output": "echo:hello"},
        config,
    )
    assert out["method"] != "heuristic_stub"
    assert out["method"] == "llm"
    assert out["synthetic"] is False
    assert out["score"] == 1.0
    assert out["output"] == "echo:hello"
    assert out["scores"][0]["name"] == "exact_match"


@pytest.mark.asyncio
async def test_run_invokes_run_scorers_for_control_and_treatment() -> None:
    from eden.experiments.offline_runner import OfflineExperimentRunner

    scorer_calls: list[tuple[str, str | None]] = []

    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        return _llm_result(prompt_dict)

    def _mock_scorers(
        specs: list[dict[str, Any]],
        output: str = "",
        expected: str | None = None,
        **kwargs: Any,
    ) -> list[dict[str, Any]]:
        scorer_calls.append((output, expected))
        return [{"name": "exact_match", "score": 1.0}]

    with patch("eden.experiments.offline_runner.run_scorers") as mock_scorers:
        mock_scorers.side_effect = _mock_scorers

        org_id = "org_f12"
        exp_id = "exp-1"
        ds_id = "ds-1"
        config = {"tasks": _tasks(), "scorers": [{"type": "exact_match"}]}
        pg = FakeOfflinePg(
            org_id=org_id,
            experiment_id=exp_id,
            dataset_id=ds_id,
            config=config,
            items=[
                {
                    "id": "row-1",
                    "input": "hi",
                    "expected_output": "echo:hi",
                    "payload": None,
                }
            ],
        )
        runner = OfflineExperimentRunner(pg=pg, llm_handler=handler)
        result = await runner.run(org_id, exp_id)

    assert result["method"] != "heuristic_stub"
    assert result["synthetic"] is False
    assert mock_scorers.call_count == 2
    assert scorer_calls == [("echo:hi", "echo:hi"), ("echo:hi", "echo:hi")]


@pytest.mark.asyncio
async def test_run_uses_stored_baseline_output_without_llm_for_control() -> None:
    from eden.experiments.offline_runner import OfflineExperimentRunner

    llm_calls = 0

    async def handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        nonlocal llm_calls
        llm_calls += 1
        return _llm_result(prompt_dict)

    org_id = "org_f12"
    exp_id = "exp-2"
    ds_id = "ds-2"
    config = {"tasks": _tasks(), "scorers": [{"type": "exact_match"}]}
    pg = FakeOfflinePg(
        org_id=org_id,
        experiment_id=exp_id,
        dataset_id=ds_id,
        config=config,
        items=[
            {
                "id": "row-1",
                "input": "hi",
                "expected_output": "echo:hi",
                "payload": json.dumps({"baseline_output": "echo:hi"}),
            }
        ],
    )
    runner = OfflineExperimentRunner(pg=pg, llm_handler=handler)
    result = await runner.run(org_id, exp_id)

    assert llm_calls == 1
    assert result["method"] != "heuristic_stub"
    control = json.loads(pg.datapoints[0]["control_output"])
    assert control["method"] == "stored_baseline"
    assert control["synthetic"] is False
    assert control["output"] == "echo:hi"


@pytest.mark.asyncio
async def test_offline_llm_handler_marks_synthetic_fallback() -> None:
    from eden.experiments.offline_runner import OfflineExperimentRunner

    async def offline_handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        return PlaygroundResult(
            template_name="",
            template_version=0,
            model="t1+offline:forced",
            response="[offline:forced:hi]",
            latency_ms=0.5,
            prompt_tokens=1,
            completion_tokens=1,
            cost_usd=0.0,
            created_at="2026-08-01T00:00:00+00:00",
        )

    runner = OfflineExperimentRunner(llm_handler=offline_handler)
    out = await runner._run_row(
        {"input": "hi", "expected_output": ""},
        {"org_id": "org", "tasks": _tasks(), "scorers": []},
    )
    assert out["synthetic"] is True
    assert out["method"] == "offline_fallback"
    assert out["method"] != "heuristic_stub"


@pytest.mark.asyncio
async def test_promote_experiment_config_includes_tasks_and_scorers() -> None:
    from eden.playground.service import PlaygroundService

    svc = PlaygroundService(memory_only=True)
    config = {
        "dataset_id": "ds-promote",
        "tasks": _tasks(),
        "scorers": [{"type": "exact_match"}, {"type": "contains"}],
        "params": {"temperature": 0.2},
        "concurrency": 4,
    }
    pg = await svc.create("org_promote", name="pg", config=config)

    created: dict[str, Any] = {}

    async def fake_create(
        _self: Any,
        org_id: str,
        *,
        name: str,
        dataset_id: str,
        config: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> Any:
        created.update(
            org_id=org_id,
            name=name,
            dataset_id=dataset_id,
            config=config or {},
            kwargs=kwargs,
        )
        from eden.experiments.offline_runner import OfflineExperiment

        return OfflineExperiment(
            id="exp-promoted",
            org_id=org_id,
            name=name,
            dataset_id=dataset_id,
            dataset_snapshot_id=None,
            config=config or {},
            baseline_experiment_id=None,
            source_issue_id=None,
            status="pending",
        )

    with patch(
        "eden.experiments.offline_runner.OfflineExperimentRunner.create",
        new=fake_create,
    ):
        out = await svc.promote_experiment("org_promote", pg.id)

    assert out["experiment"]["id"] == "exp-promoted"
    promoted_cfg = created["config"]
    assert promoted_cfg["tasks"] == config["tasks"]
    assert promoted_cfg["scorers"] == config["scorers"]
    assert promoted_cfg["params"] == config["params"]
    assert promoted_cfg["concurrency"] == config["concurrency"]
    assert promoted_cfg["source_playground_id"] == pg.id
