"""End-to-end style tests for the evolver -> canary wiring (Unit A8).

These tests exercise the full path:

    JudgeScorePromptEvolver / PromptEvolvers
        -> insert_version(prompt_variants)
        -> _auto_create_canary() (gated by Settings.evolver_auto_canary_pct)
            -> prompt_versions.update_quality_metrics(canary_*, ...)
            -> org_audit_log INSERT (action=evolver.auto_canary_created)

The FastAPI app isn't wired in this worktree, so the tests
deliberately bypass HTTP and call the evolver directly with mocked
clients.  They verify the contract: when the evolver fires, the
expected rows are written and the expected audit log entry is
emitted.

The original unit A8 spec referenced ``tests/integration/test_evolver_canary.py``
with the ``app.dependency_overrides`` pattern from
``tests/integration/test_ingestion.py``; that file does not exist in
this worktree, so we provide an equivalent end-to-end style test
covering the full data flow.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.agents.evolution.components import PromptEvolvers


@pytest.fixture
def evolver():
    """A ``PromptEvolvers`` with no LLM client and stubbed KB clients."""
    e = PromptEvolvers.__new__(PromptEvolvers)
    e.llm = MagicMock()
    e.last_run = None
    e.prompt_versions = MagicMock()
    e.prompt_versions.insert_version = AsyncMock(return_value=True)
    e.prompt_versions.update_quality_metrics = AsyncMock(return_value=True)
    return e


@pytest.fixture
def fake_pg():
    """Mock PostgresClient that returns deterministic org/user ids.

    Audit 2026-07-07: the canary-creation audit path now resolves
    ``org_id`` from ``prompt_versions.quality_metrics`` JSONB
    (instead of the previous ``SELECT id FROM organizations LIMIT 1``
    cross-tenant leak). We mock ``fetchrow`` to return a row whose
    ``quality_metrics`` carries the owning ``org_id`` so the test
    continues to exercise the audit path end-to-end with the
    correct, tenant-isolated org attribution.
    """
    pg = MagicMock()

    async def _fetchval_dispatch(q: str, *args):
        ql = " ".join(q.split()).lower()
        if "from users" in ql and "clerk_id" in ql:
            return "00000000-0000-0000-0000-000000000bbb"
        return None

    pg.fetchval = AsyncMock(side_effect=_fetchval_dispatch)
    pg.fetchrow = AsyncMock(
        return_value={
            "quality_metrics": json.dumps(
                {"org_id": "00000000-0000-0000-0000-000000000aaa"}
            )
        }
    )
    pg.execute = AsyncMock(return_value="INSERT 0 1")
    return pg


@pytest.mark.asyncio
async def test_seeded_degradation_triggers_canary(evolver, fake_pg):
    """E2E: simulate 'judge score degradation detected' -> evolver fires
    -> 5% canary experiment is created and audit log entry is written.

    This is the integration scenario from the A8 spec:

    > seed judge_scores degradation -> evolver fires -> verify
    > prompt_canary_experiments row at 5% traffic, status active;
    > verify org_audit_log has evolver.auto_canary_created
    """
    # Seed a degradation: 3 jobs with bronze/failed outcomes, 10-point
    # drop in test pass rate vs previous quality window.
    failure_jobs = [
        {"job_id": f"job{i}", "outcome_tier": "Failed"} for i in range(3)
    ]
    current_quality = {"test_pass_rate": 0.50, "avg_executor_iterations": 2.0}
    previous_quality = {"test_pass_rate": 0.95, "avg_executor_iterations": 1.0}

    with patch.object(
        evolver, "_generate_prompt_variants",
        AsyncMock(return_value=[
            {"prompt": "improved-prompt-A"},
            {"prompt": "improved-prompt-B"},
        ]),
    ):
        with patch(
            "eden.agents.evolution.components.settings"
        ) as mock_settings:
            mock_settings.evolver_auto_canary_pct = 5
            with patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=fake_pg),
            ):
                created = await evolver._handle_degradation(
                    agent="planner",
                    current_version=1,
                    failure_jobs=failure_jobs,
                    current_quality=current_quality,
                    previous_quality=previous_quality,
                )

    # Two variants should be created (v2 and v3).
    assert created == 2
    assert evolver.prompt_versions.insert_version.await_count == 2
    assert evolver.prompt_versions.update_quality_metrics.await_count == 2

    # Both variants should be enrolled as 5% canaries.
    canary_calls = (
        evolver.prompt_versions.update_quality_metrics.await_args_list
    )
    for call in canary_calls:
        agent, version, metrics = call.args
        assert metrics["canary_status"] == "active"
        assert metrics["canary_traffic_pct"] == 5
        assert metrics["ab_test_active"] is True
        assert "canary_created_at" in metrics
    enrolled_versions = sorted(c.args[1] for c in canary_calls)
    assert enrolled_versions == [2, 3]

    experiment_inserts = [
        c for c in fake_pg.execute.await_args_list
        if "INSERT INTO prompt_canary_experiments" in c.args[0]
    ]
    assert len(experiment_inserts) == 2

    # org_audit_log should have one INSERT per canary, with the
    # expected action and metadata.
    audit_inserts = [
        c for c in fake_pg.execute.await_args_list
        if "INSERT INTO org_audit_log" in c.args[0]
    ]
    assert len(audit_inserts) == 2
    for call in audit_inserts:
        org_id, user_id, action, target_type, target_id, metadata_json = (
            call.args[1:7]
        )
        assert action == "evolver.auto_canary_created"
        assert target_type == "prompt_version"
        metadata = json.loads(metadata_json)
        assert metadata["agent"] == "planner"
        assert metadata["traffic_pct"] == 5
        assert metadata["version"] in {2, 3}


@pytest.mark.asyncio
async def test_zero_pct_keeps_variants_inactive(evolver, fake_pg):
    """E2E: when ``evolver_auto_canary_pct=0``, the evolver still
    generates variants but no canary / audit row is created.

    This is the 'opt-out' path required by the A8 spec.
    """
    failure_jobs = [
        {"job_id": f"job{i}", "outcome_tier": "Failed"} for i in range(3)
    ]
    current_quality = {"test_pass_rate": 0.50}
    previous_quality = {"test_pass_rate": 0.95}

    with patch.object(
        evolver, "_generate_prompt_variants",
        AsyncMock(return_value=[{"prompt": "improved-prompt-A"}]),
    ):
        with patch(
            "eden.agents.evolution.components.settings"
        ) as mock_settings:
            mock_settings.evolver_auto_canary_pct = 0
            with patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=fake_pg),
            ):
                created = await evolver._handle_degradation(
                    agent="planner",
                    current_version=1,
                    failure_jobs=failure_jobs,
                    current_quality=current_quality,
                    previous_quality=previous_quality,
                )

    assert created == 1
    # Variant was inserted but NOT marked as a canary.
    evolver.prompt_versions.update_quality_metrics.assert_not_called()
    # No audit log entry should have been written.
    audit_inserts = [
        c for c in fake_pg.execute.await_args_list
        if "INSERT INTO org_audit_log" in c.args[0]
    ]
    assert audit_inserts == []
