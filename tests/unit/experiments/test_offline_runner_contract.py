"""Contract tests for OfflineExperimentRunner — pin inputs→persisted-result shape,
status transitions, and error paths (W4-2 canonical-runner merge guard).

These tests are intentionally independent of the compare/grading helpers so they
catch regressions in the runner's own persistence behaviour, not in the scorers.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from eden.evaluation._base import _BaseEvalRunner
from eden.experiments.offline_runner import OfflineExperiment, OfflineExperimentRunner
from eden.prompts.registry import PlaygroundResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _result(text: str = "ok") -> PlaygroundResult:
    return PlaygroundResult(
        template_name="",
        template_version=0,
        model="t1",
        response=text,
        latency_ms=1.0,
        prompt_tokens=1,
        completion_tokens=1,
        cost_usd=0.001,
        created_at="2026-08-12T00:00:00+00:00",
    )


async def _noop_handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
    return _result()


class _MinimalPg:
    """Asyncpg stub shaped for OfflineExperimentRunner tests."""

    def __init__(
        self,
        *,
        org_id: str = "org-1",
        experiment_id: str = "exp-1",
        dataset_id: str = "ds-1",
        config: dict[str, Any] | None = None,
        items: list[dict[str, Any]] | None = None,
        raise_on_run: bool = False,
    ) -> None:
        self.org_id = org_id
        self.experiment_id = experiment_id
        self.dataset_id = dataset_id
        self.config = config or {}
        self.items = items or []
        self.raise_on_run = raise_on_run
        # Track every execute() call so tests can assert on persisted data.
        self.executes: list[tuple[str, tuple[Any, ...]]] = []
        self._status = "pending"

    async def execute(self, query: str, *args: Any) -> str:
        self.executes.append((query, args))
        if "status = 'running'" in query:
            self._status = "running"
        elif "status = 'completed'" in query:
            self._status = "completed"
        elif "status = 'failed'" in query:
            self._status = "failed"
        return "OK"

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        if "offline_experiments" in query:
            return {
                "id": self.experiment_id,
                "org_id": self.org_id,
                "name": "test-exp",
                "dataset_id": self.dataset_id,
                "dataset_snapshot_id": None,
                "config": json.dumps(self.config),
                "baseline_experiment_id": None,
                "source_issue_id": None,
                "status": self._status,
            }
        return None

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        if "dataset_items" in query:
            if self.raise_on_run:
                # Raise inside the try block so the runner sets status='failed'.
                raise RuntimeError("db error mid-run")
            return list(self.items)
        if "experiment_datapoints" in query:
            return []
        return []


# ---------------------------------------------------------------------------
# _BaseEvalRunner contract
# ---------------------------------------------------------------------------

class TestBaseEvalRunner:
    """The canonical base class is importable and has the expected interface."""

    def test_both_runners_inherit_from_base(self) -> None:
        assert issubclass(OfflineExperimentRunner, _BaseEvalRunner)
        from eden.evaluation.regression_runner import RegressionRunner

        assert issubclass(RegressionRunner, _BaseEvalRunner)

    @pytest.mark.asyncio
    async def test_memory_only_client_returns_none(self) -> None:
        runner = _BaseEvalRunner(memory_only=True)
        client = await runner._client()
        assert client is None

    @pytest.mark.asyncio
    async def test_injected_pg_is_returned_directly(self) -> None:
        sentinel = object()
        runner = _BaseEvalRunner(pg=sentinel)  # type: ignore[arg-type]
        client = await runner._client()
        assert client is sentinel


# ---------------------------------------------------------------------------
# OfflineExperimentRunner.create() contract
# ---------------------------------------------------------------------------

class TestOfflineExperimentRunnerCreate:
    @pytest.mark.asyncio
    async def test_create_without_pg_returns_pending_experiment(self) -> None:
        runner = OfflineExperimentRunner(memory_only=True, llm_handler=_noop_handler)
        exp = await runner.create(
            "org-1",
            name="my-exp",
            dataset_id="ds-abc",
            snapshot=False,
        )
        assert isinstance(exp, OfflineExperiment)
        assert exp.org_id == "org-1"
        assert exp.name == "my-exp"
        assert exp.dataset_id == "ds-abc"
        assert exp.status == "pending"
        assert exp.created_at != ""

    @pytest.mark.asyncio
    async def test_create_dict_shape_has_required_keys(self) -> None:
        runner = OfflineExperimentRunner(memory_only=True, llm_handler=_noop_handler)
        exp = await runner.create("org-1", name="n", dataset_id="d", snapshot=False)
        d = exp.to_dict()
        required = {
            "id",
            "org_id",
            "name",
            "dataset_id",
            "dataset_snapshot_id",
            "config",
            "baseline_experiment_id",
            "source_issue_id",
            "status",
            "created_at",
            "completed_at",
        }
        assert required == set(d.keys())

    @pytest.mark.asyncio
    async def test_create_with_pg_inserts_row(self) -> None:
        pg = _MinimalPg(org_id="org-2", experiment_id="e1", dataset_id="ds-2")
        runner = OfflineExperimentRunner(pg=pg, llm_handler=_noop_handler)
        exp = await runner.create(
            "org-2",
            name="pg-exp",
            dataset_id="ds-2",
            snapshot=False,
        )
        assert exp.status == "pending"
        insert_queries = [q for q, _ in pg.executes if "INSERT INTO offline_experiments" in q]
        assert len(insert_queries) == 1

    @pytest.mark.asyncio
    async def test_create_passes_source_issue_id(self) -> None:
        runner = OfflineExperimentRunner(memory_only=True, llm_handler=_noop_handler)
        exp = await runner.create(
            "org-1",
            name="n",
            dataset_id="d",
            source_issue_id="issue-99",
            snapshot=False,
        )
        assert exp.source_issue_id == "issue-99"


# ---------------------------------------------------------------------------
# OfflineExperimentRunner.run() status transitions
# ---------------------------------------------------------------------------

class TestOfflineExperimentRunnerRun:
    @pytest.mark.asyncio
    async def test_run_sets_status_completed_on_success(self) -> None:
        items = [{"id": "r1", "input": "hello", "expected_output": "world", "payload": None}]
        pg = _MinimalPg(
            config={"tasks": [], "scorers": []},
            items=items,
        )
        runner = OfflineExperimentRunner(pg=pg, llm_handler=_noop_handler)
        result = await runner.run("org-1", "exp-1")
        assert result["status"] == "completed"
        assert result["rows"] == 1
        completed_updates = [
            q for q, _ in pg.executes if "status = 'completed'" in q
        ]
        assert len(completed_updates) == 1

    @pytest.mark.asyncio
    async def test_run_sets_status_running_before_items(self) -> None:
        items = [{"id": "r1", "input": "hello", "expected_output": "", "payload": None}]
        pg = _MinimalPg(
            config={"tasks": [], "scorers": []},
            items=items,
        )
        runner = OfflineExperimentRunner(pg=pg, llm_handler=_noop_handler)
        await runner.run("org-1", "exp-1")
        queries = [q for q, _ in pg.executes]
        # 'running' update must precede the datapoint insert
        running_idx = next(i for i, q in enumerate(queries) if "status = 'running'" in q)
        insert_idx = next(
            (i for i, q in enumerate(queries) if "INSERT INTO experiment_datapoints" in q),
            len(queries),
        )
        assert running_idx < insert_idx

    @pytest.mark.asyncio
    async def test_run_sets_status_failed_on_db_error(self) -> None:
        pg = _MinimalPg(
            config={"tasks": [], "scorers": []},
            items=[{"id": "r1", "input": "hi", "expected_output": "", "payload": None}],
            raise_on_run=True,
        )
        runner = OfflineExperimentRunner(pg=pg, llm_handler=_noop_handler)
        with pytest.raises(RuntimeError):
            await runner.run("org-1", "exp-1")
        failed_updates = [q for q, _ in pg.executes if "status = 'failed'" in q]
        assert len(failed_updates) == 1

    @pytest.mark.asyncio
    async def test_run_raises_when_no_db(self) -> None:
        runner = OfflineExperimentRunner(memory_only=True, llm_handler=_noop_handler)
        with pytest.raises(RuntimeError, match="database unavailable"):
            await runner.run("org-1", "exp-1")

    @pytest.mark.asyncio
    async def test_run_result_shape(self) -> None:
        items = [{"id": "r1", "input": "x", "expected_output": "y", "payload": None}]
        pg = _MinimalPg(config={"tasks": [], "scorers": []}, items=items)
        runner = OfflineExperimentRunner(pg=pg, llm_handler=_noop_handler)
        result = await runner.run("org-1", "exp-1")
        required = {"experiment_id", "status", "rows", "grades", "synthetic", "method"}
        assert required.issubset(set(result.keys()))
        assert result["experiment_id"] == "exp-1"

    @pytest.mark.asyncio
    async def test_run_persists_datapoints(self) -> None:
        items = [
            {"id": "r1", "input": "a", "expected_output": "b", "payload": None},
            {"id": "r2", "input": "c", "expected_output": "d", "payload": None},
        ]
        pg = _MinimalPg(config={"tasks": [], "scorers": []}, items=items)
        runner = OfflineExperimentRunner(pg=pg, llm_handler=_noop_handler)
        result = await runner.run("org-1", "exp-1")
        datapoint_inserts = [
            q for q, _ in pg.executes if "INSERT INTO experiment_datapoints" in q
        ]
        assert len(datapoint_inserts) == 2
        assert result["rows"] == 2


# ---------------------------------------------------------------------------
# OfflineExperimentRunner.list_experiments() contract
# ---------------------------------------------------------------------------

class TestOfflineExperimentRunnerList:
    @pytest.mark.asyncio
    async def test_list_raises_when_no_db(self) -> None:
        runner = OfflineExperimentRunner(memory_only=True)
        with pytest.raises(RuntimeError, match="database unavailable"):
            await runner.list_experiments("org-1")

    @pytest.mark.asyncio
    async def test_list_passes_limit_to_query(self) -> None:
        queried_limits: list[Any] = []

        class _LimitCapturePg(_MinimalPg):
            async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
                if "offline_experiments" in query:
                    queried_limits.extend(args)
                return []

        pg = _LimitCapturePg()
        runner = OfflineExperimentRunner(pg=pg)
        await runner.list_experiments("org-1", limit=77)
        assert 77 in queried_limits


# ---------------------------------------------------------------------------
# OfflineExperimentRunner.compare() contract
# ---------------------------------------------------------------------------

class TestOfflineExperimentRunnerCompare:
    @pytest.mark.asyncio
    async def test_compare_raises_when_no_db(self) -> None:
        runner = OfflineExperimentRunner(memory_only=True)
        with pytest.raises(RuntimeError, match="database unavailable"):
            await runner.compare("org-1", "exp-1")

    @pytest.mark.asyncio
    async def test_compare_output_shape(self) -> None:
        pg = _MinimalPg(
            org_id="org-1",
            experiment_id="exp-1",
            dataset_id="ds-1",
        )
        runner = OfflineExperimentRunner(pg=pg)
        result = await runner.compare("org-1", "exp-1")
        required = {
            "experiment_id",
            "baseline_experiment_id",
            "source_issue_id",
            "datapoints",
            "summary",
            "immutable",
            "dataset_snapshot_id",
            "synthetic",
            "method",
        }
        assert required.issubset(set(result.keys()))
        assert result["immutable"] is True
        assert result["experiment_id"] == "exp-1"

    @pytest.mark.asyncio
    async def test_compare_raises_on_missing_experiment(self) -> None:
        class _NotFoundPg(_MinimalPg):
            async def fetchrow(self, query: str, *args: Any) -> None:
                return None

        pg = _NotFoundPg()
        runner = OfflineExperimentRunner(pg=pg)
        with pytest.raises(ValueError, match="experiment not found"):
            await runner.compare("org-1", "exp-missing")


# ---------------------------------------------------------------------------
# memory_only is backward-compatible
# ---------------------------------------------------------------------------

def test_offline_runner_memory_only_is_new_kwarg() -> None:
    """The new memory_only kwarg must not break existing call sites."""
    # All existing call sites use positional pg= or llm_handler= only.
    runner_a = OfflineExperimentRunner()
    runner_b = OfflineExperimentRunner(llm_handler=_noop_handler)
    runner_c = OfflineExperimentRunner(pg=None, llm_handler=_noop_handler)
    runner_d = OfflineExperimentRunner(memory_only=True)
    assert runner_a._memory_only is False
    assert runner_b._memory_only is False
    assert runner_c._memory_only is False
    assert runner_d._memory_only is True
