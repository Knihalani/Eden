"""M6 (spec §3.7): prompt_update producer from N18 evolution canaries.

A concluded canary names a winner; when the F68 prod pin drifts from it
the sweep emits ``plan_kind="prompt_update"`` with a concrete from→to
version pair. No pair (pin already on the winner, or no registry row for
the target) → no plan. The M4 ``plan_kind_hint`` prioritizes the lane.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement.agent import ImprovementAgent
from eden.improvement.approve import approve_plan

_EXP_ROW = {
    "experiment_id": "exp-1",
    "agent": "checkout",
    "control_version": 3,
    "candidate_version": 4,
    "status": "rolled_back",
    "ended_at": "2026-08-01T00:00:00+00:00",
}


def _client(fetch_rows: list[list[dict]], fetchrow_results: list[dict | None]) -> MagicMock:
    client = MagicMock()
    client.fetch = AsyncMock(side_effect=fetch_rows)
    client.fetchrow = AsyncMock(side_effect=fetchrow_results)
    return client


@pytest.mark.asyncio
async def test_canary_loser_emits_prompt_update_with_version_pair() -> None:
    """Rolled-back candidate (loser) + prod pinned to the loser → plan
    proposing the concrete pair from=4 (pinned loser) → to=3 (control)."""
    agent = ImprovementAgent()
    client = _client(
        fetch_rows=[[dict(_EXP_ROW)]],
        fetchrow_results=[
            {"version": 4},  # prod pin — still on the losing candidate
            {"id": "pv-uuid-3"},  # registry row for target v3
        ],
    )
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        out = await agent._from_prompt_updates("org-1", None)

    assert len(out) == 1
    cand = out[0]
    assert cand.plan_kind == "prompt_update"
    assert cand.agent_id == "checkout"
    assert cand.evidence["agent_id"] == "checkout"
    assert cand.evidence["prompt_version_from"] == 4
    assert cand.evidence["prompt_version_to"] == 3
    assert cand.evidence["prompt_version_id"] == "pv-uuid-3"
    assert cand.evidence["evidence"]["canary_status"] == "rolled_back"
    assert cand.evidence["evidence"]["source"] == "prompt_version_drift"
    assert cand.source_fingerprint == "prompt_update:checkout:4->3"


@pytest.mark.asyncio
async def test_no_plan_when_prod_already_pins_winner() -> None:
    """Pin == winner → no concrete drift pair → no plan."""
    agent = ImprovementAgent()
    client = _client(
        fetch_rows=[[dict(_EXP_ROW)]],
        fetchrow_results=[{"version": 3}],  # prod pin already on control v3
    )
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        out = await agent._from_prompt_updates("org-1", None)

    assert out == []


@pytest.mark.asyncio
async def test_no_plan_when_target_version_not_in_registry() -> None:
    """Target version has no prompt_versions row — F68 cannot deploy it,
    so honesty demands no plan."""
    agent = ImprovementAgent()
    client = _client(
        fetch_rows=[[dict(_EXP_ROW)]],
        fetchrow_results=[
            {"version": 4},  # drifted pin
            None,  # registry lookup for v3 misses
        ],
    )
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        out = await agent._from_prompt_updates("org-1", None)

    assert out == []


@pytest.mark.asyncio
async def test_hint_boosts_confidence_and_orders_lane_first() -> None:
    """plan_kind_hint="prompt_update" (M4→M6) boosts the lane's ranking
    and places prompt_update candidates ahead of nudge candidates."""
    agent = ImprovementAgent()
    nudge_rows = [{"id": "n-1", "agent_id": "checkout", "name": "tighten-tone"}]
    client = _client(
        fetch_rows=[[dict(_EXP_ROW)], nudge_rows],
        fetchrow_results=[{"version": 4}, {"id": "pv-uuid-3"}],
    )
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_open_fingerprints",
            AsyncMock(return_value=set()),
        ),
    ):
        out = await agent._from_prompt_nudge_candidates(
            "org-1", None, plan_kind_hint="prompt_update"
        )

    kinds = [c.plan_kind for c in out]
    assert kinds == ["prompt_update", "nudge_promote"]
    hinted = out[0]
    assert hinted.confidence == 0.85  # boosted from the 0.7 default

    # Unhinted run for comparison.
    client2 = _client(
        fetch_rows=[[dict(_EXP_ROW)], nudge_rows],
        fetchrow_results=[{"version": 4}, {"id": "pv-uuid-3"}],
    )
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client2),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_open_fingerprints",
            AsyncMock(return_value=set()),
        ),
    ):
        base = await agent._from_prompt_nudge_candidates("org-1", None)

    assert base[0].confidence == 0.7
    assert hinted.score > base[0].score


@pytest.mark.asyncio
async def test_scoped_sweep_threads_hint_to_prompt_lane() -> None:
    """request_sweep(issue_id=…, plan_kind_hint="prompt_update") runs the
    prompt/nudge lane scoped to the issue's agent (TODO(M6) removed)."""
    agent = ImprovementAgent()
    lane = AsyncMock(return_value=[])
    with (
        patch(
            "eden.improvement.agent._agent_enabled_for_org",
            AsyncMock(return_value=True),
        ),
        patch(
            "eden.improvement.agent.runs_repo.get_watermark",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.improvement.agent.runs_repo.create_run",
            AsyncMock(return_value={"id": "run-1"}),
        ),
        patch(
            "eden.improvement.agent.runs_repo.finish_run",
            AsyncMock(),
        ),
        patch(
            "eden.improvement.agent.imp_settings.get_settings",
            AsyncMock(return_value={}),
        ),
        patch(
            "eden.improvement.issue_patch_trigger.propose_plan_for_issue",
            AsyncMock(return_value={"status": "skipped"}),
        ),
        patch(
            "eden.improvement.agent._issue_agent_id",
            AsyncMock(return_value="agent-z"),
        ) as issue_agent,
        patch.object(ImprovementAgent, "_from_prompt_nudge_candidates", lane),
        patch("eden.improvement.agent._emit_sweep_completed", AsyncMock()),
    ):
        result = await agent.sweep(
            "org-1", issue_id="iss-1", plan_kind_hint="prompt_update"
        )

    assert result["status"] == "completed"
    issue_agent.assert_awaited_once_with("org-1", "iss-1")
    lane.assert_awaited_once_with("org-1", "agent-z", plan_kind_hint="prompt_update")


@pytest.mark.asyncio
async def test_sweep_produced_prompt_update_flows_through_approve() -> None:
    """End-to-end kind proof (M6 E): the producer's evidence carries the
    prompt_version_id that approve resolves and deploys via mocked F68."""
    agent = ImprovementAgent()
    producer_client = _client(
        fetch_rows=[[dict(_EXP_ROW)]],
        fetchrow_results=[{"version": 4}, {"id": "pv-uuid-3"}],
    )
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=producer_client),
        ),
        patch(
            "eden.improvement.agent.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        cands = await agent._from_prompt_updates("org-1", None)
    assert len(cands) == 1
    cand = cands[0]

    plan = {
        "id": "plan-pu-1",
        "status": "pending_review",
        "plan_kind": cand.plan_kind,
        "agent_id": cand.agent_id,
        "source_ref": cand.source_ref,
        "evidence": cand.evidence,
    }
    deploy = AsyncMock(return_value={"prompt_name": "checkout", "env": "prod", "version": 3})
    approve_client = MagicMock()
    approve_client.fetchrow = AsyncMock(return_value={"prompt_name": "checkout", "version": 3})
    with (
        patch(
            "eden.improvement.approve.plans_repo.get_plan",
            AsyncMock(return_value=plan),
        ),
        patch("eden.improvement.approve._n22_blocked", AsyncMock(return_value=None)),
        patch(
            "eden.improvement.approve.plans_repo.mark_approved",
            AsyncMock(return_value={**plan, "status": "approved"}),
        ),
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=approve_client),
        ),
        patch("eden.prompts.deploy.PromptDeployService.deploy", deploy),
        patch("eden.improvement.approve._audit_approve", AsyncMock()),
    ):
        result = await approve_plan("org-1", "plan-pu-1", approved_by="user-1")

    assert result["status"] == "deployed"
    assert result["prompt_name"] == "checkout"
    assert result["version"] == 3
    assert result["env"] == "prod"
    # Approve resolved the version by the producer's prompt_version_id.
    lookup_args = approve_client.fetchrow.await_args.args
    assert "pv-uuid-3" in lookup_args
    deploy.assert_awaited_once()
