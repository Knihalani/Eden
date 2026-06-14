"""Intelligence Gap — Agent Intelligence (Cat 6) routes.

Six routes (one per service endpoint):

* ``GET /performance`` — per-agent success / cost / latency /
  judge averages over a time window
* ``GET /relationships`` — multi-agent handoff graph
  builder
* ``POST /handoffs/analyze`` — bottleneck / error-hotspot /
  drift classifier on the relationship graph
* ``POST /benchmark/run`` — deterministic synthetic
  benchmark runner
* ``POST /fleet/identity`` — LangSmith-Fleet-style
  identity registration (upsert with closed-loop
  deprecation-drift hook)
* ``POST /fleet/permissions`` — assign permissions to a
  registered identity

All routes are gated by the ``intelligence_gap_v0`` feature
flag and require an authenticated user. The service
implementations live in
:mod:`eden.agents.agent_intel.performance`; the shared
helpers (envelope shape, window parsing, fetchers,
persistence) live in
:mod:`eden.agents.agent_intel._common`.

See ``docs/observability-gap/06-agent-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path, Query
from pydantic import BaseModel, Field

from eden.agents.agent_intel.performance import (
    AgentBenchmarkRunner,
    AgentFleetService,
    AgentPerformanceScorer,
    AgentRelationshipGraph,
    HandoffAnalyzer,
)
from eden.api.deps import get_current_user, require_feature_flag

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/agents",
    tags=["intelligence-agents"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

_perf = AgentPerformanceScorer()
_graph = AgentRelationshipGraph()
_handoff = HandoffAnalyzer()
_bench = AgentBenchmarkRunner()
_fleet = AgentFleetService()


# ─── Request body models ─────────────────────────────────────────────


class HandoffRequest(BaseModel):
    """Request body for the HandoffAnalyzer.

    Both fields are optional. When both are empty the
    analyzer runs across the org's full relationship graph;
    supplying one or both filters the result to the
    matching edges.
    """

    from_agent: str = Field(default="", description="Filter to this parent agent")
    to_agent: str = Field(default="", description="Filter to this child agent")


class BenchmarkRequest(BaseModel):
    """Request body for the benchmark runner.

    ``dataset_id`` accepts any of the benchmark names
    enumerated in :data:`eden.agents.agent_intel._common.VALID_BENCHMARKS`
    (or a custom dataset id if/when the real AgentBench /
    SWE-bench / τ-bench / GAIA suites land in v2)."""

    agent_id: str = Field(..., description="Agent under test")
    dataset_id: str = Field(
        default="synthetic_default",
        description="Benchmark name or dataset id",
    )


class FleetIdentityRequest(BaseModel):
    """Request body for fleet identity registration.

    ``slack_identity`` is the optional per-agent Slack
    handle (LangSmith-Fleet parity)."""

    agent_id: str = Field(..., description="Stable agent identity key")
    display_name: str = Field(..., description="Human-readable name")
    slack_identity: str | None = Field(
        default=None, description="Per-agent Slack handle (optional)"
    )


class FleetPermissionsRequest(BaseModel):
    """Request body for fleet permission assignment.

    Each permission is a free-form string up to 128 chars;
    the v0 LangSmith-Fleet RBAC model is
    ``viewer|editor|deployer|admin`` but the API does not
    restrict to that vocabulary."""

    agent_id: str = Field(..., description="Agent identity to grant permissions to")
    permissions: list[str] = Field(..., description="Permission keys to grant")


# ─── Routes ──────────────────────────────────────────────────────────


@router.get("/performance")
async def performance(
    org_id: str = Path(...),
    agent_id: str = Query(..., description="Agent to score"),
    window: str = Query("24h", description="e.g. '24h', '7d', '30d'"),
) -> dict[str, Any]:
    return await _perf.score(org_id, agent_id, window=window)


@router.get("/relationships")
async def relationships(
    org_id: str = Path(...),
    window: str = Query("7d", description="e.g. '7d', '30d'"),
) -> dict[str, Any]:
    return await _graph.build(org_id, window=window)


@router.post("/handoffs/analyze")
async def handoffs(
    org_id: str = Path(...),
    body: HandoffRequest = Body(...),
) -> dict[str, Any]:
    return await _handoff.analyze(
        org_id, from_agent=body.from_agent, to_agent=body.to_agent
    )


@router.post("/benchmark/run")
async def benchmark(
    org_id: str = Path(...),
    body: BenchmarkRequest = Body(...),
) -> dict[str, Any]:
    return await _bench.run(
        org_id, body.agent_id, dataset_id=body.dataset_id
    )


@router.post("/fleet/identity")
async def fleet_identity(
    org_id: str = Path(...),
    body: FleetIdentityRequest = Body(...),
) -> dict[str, Any]:
    return await _fleet.register_agent_identity(
        org_id,
        agent_id=body.agent_id,
        display_name=body.display_name,
        slack_identity=body.slack_identity,
    )


@router.post("/fleet/permissions")
async def fleet_permissions(
    org_id: str = Path(...),
    body: FleetPermissionsRequest = Body(...),
) -> dict[str, Any]:
    return await _fleet.assign_permissions(
        org_id, agent_id=body.agent_id, permissions=body.permissions
    )
