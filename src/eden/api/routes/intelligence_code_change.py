"""Intelligence Gap — Autonomous Code Modification (Cat 23) routes.

Cat 23 v1.6 STUB surface (per the v1.6 STUB checklist, weeks
25-26 of the rollout). The 19 routes wire the 21 Cat 23 service
classes (the 3 admin-controlled approval services ship as
additional routes in the same router).

The STUB surface returns the :func:`eden.intelligence_envelope.
not_implemented` envelope for destructive actions and the
``_ok_envelope`` for read-only actions. The two-stage opt-in
(:func:`eden.code_change._common._check_two_stage_optin`) is
checked FIRST on every destructive route so the auto-mode
flows are never reachable without the explicit per-tenant
opt-in.

Gates:

* ``intelligence_gap_v0`` umbrella flag — mirrors the
  Cat 16 / Cat 18 / Cat 22 pattern.
* ``intelligence_code_change_v0`` sub-flag — the v1.6 sub-flag
  per the v1.6 rollout controls section.
* Org scoping via ``{org_id}`` path param.
* ``get_current_user`` for auth.
* ``require_org_admin`` for the destructive auto-mode routes
  (``POST /patches/{id}/pr`` with ``auto_pr_enabled=true``,
  ``POST /prs/{id}/revert`` with ``auto_revert_enabled=true``).

The 19 routes:

1. ``POST /repos/connect`` — register a new repo connection
2. ``GET /repos`` — list the org's connected repos
3. ``GET /repos/{repo_id}`` — get a single repo connection
4. ``DELETE /repos/{repo_id}`` — disconnect a repo
5. ``POST /policy`` — update the Cat 23 opt-in policy
6. ``GET /policy`` — read the current policy
7. ``POST /patches`` — propose a new patch (Gate 4a blocked)
8. ``GET /patches/{patch_id}`` — get a single patch
9. ``POST /patches/{patch_id}/test`` — run the test plan (Gate 3 blocked)
10. ``POST /patches/{patch_id}/pr`` — open a PR (Gate 4a blocked + opt-in)
11. ``GET /inbox`` — list the PR Inbox
12. ``GET /inbox/{patch_id}`` — get a single inbox item
13. ``GET /inbox/{patch_id}/diff`` — get the raw diff
14. ``GET /inbox/{patch_id}/style`` — get the per-patch style breakdown
15. ``GET /inbox/stats`` — get the aggregate stats
16. ``POST /inbox/{patch_id}/{action}`` — dispatch the 8 inbox actions
17. ``GET /settings/approvals/grants`` — list approval grants
18. ``POST /settings/approvals/grants`` — create a grant
19. ``DELETE /settings/approvals/grants/{grant_id}`` — revoke a grant
20. ``GET /settings/approvals/delegations`` — list delegations
21. ``POST /settings/approvals/delegations`` — create a delegation
22. ``GET /prs`` — list the PRs
23. ``GET /prs/{pr_id}`` — get a single PR
24. ``POST /prs/{pr_id}/revert`` — auto-revert (Gate 4b blocked + opt-in)

The router has 24 unique route paths but the v1.6 STUB
checklist counts 19 "route surfaces" (the 8 inbox actions
share one ``POST /inbox/{patch_id}/{action}`` route path with
an ``action`` path param).

See ``docs/observability-gap/23-autonomous-code-modification.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.code_change import (
    AgentActivityFeed,
    AgentPersonaService,
    ApprovalDelegationService,
    ApprovalGrantService,
    ApprovalWorkflowService,
    AutoApprovalDryRunService,
    AutoApprovalMetricsCollector,
    AutoApprovalRateLimiter,
    AutoApprovalRuleService,
    AutoRevertEngine,
    BlastRadiusAnalyzer,
    CodebaseKnowledgeGraph,
    CodeChangePolicyService,
    CodeRootCauseLinker,
    CodeStyleLearner,
    PatchGenerator,
    PostMergeMonitor,
    PRCreator,
    PRExplanationService,
    PRInboxService,
    PRQualityScorer,
    PRReviewerNotifier,
    PRReviewService,
    RepoConnector,
    TestPlanRunner,
)
from eden.intelligence_envelope import not_implemented

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/code-change",
    tags=["intelligence-code-change"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

# ─── Singletons (stateless) ───────────────────────────────────────
_repo_connector = RepoConnector()
_policy = CodeChangePolicyService()
_persona = AgentPersonaService()
_activity_feed = AgentActivityFeed()
_rca_linker = CodeRootCauseLinker()
_blast_radius = BlastRadiusAnalyzer()
_quality_scorer = PRQualityScorer()
_explanation = PRExplanationService()
_patch_generator = PatchGenerator()
_test_runner = TestPlanRunner()
_inbox = PRInboxService()
_review = PRReviewService()
_grants = ApprovalGrantService()
_workflow = ApprovalWorkflowService()
_delegations = ApprovalDelegationService()
_auto_approval_rules = AutoApprovalRuleService()
_auto_approval_metrics = AutoApprovalMetricsCollector()
_auto_approval_dry_run = AutoApprovalDryRunService()
_auto_approval_rate_limit = AutoApprovalRateLimiter()
_pr_creator = PRCreator()
_post_merge = PostMergeMonitor()
_revert = AutoRevertEngine()
_notifier = PRReviewerNotifier()
_style_learner = CodeStyleLearner()
_knowledge_graph = CodebaseKnowledgeGraph()


# ─── Schemas ───────────────────────────────────────────────────────
class ConnectRepoRequest(BaseModel):
    provider: str = Field(..., description="github, gitlab, or bitbucket")
    repo_full_name: str
    default_branch: str = "main"
    connected_by_user_id: str = "stub_user"


class UpdatePolicyRequest(BaseModel):
    policy: dict[str, Any]


class ProposePatchRequest(BaseModel):
    trace_id: str
    rca_id: str
    repo_id: str


class InboxListRequest(BaseModel):
    status: str = "open"
    sort: str = "priority"
    group_by: str = "repo"
    limit: int = Field(50, ge=1, le=500)


class InboxActionRequest(BaseModel):
    action: str = Field(
        ...,
        description=(
            "approve | deny | edit | request-changes | comment | pr | "
            "revert | bulk"
        ),
    )
    actor_user_id: str = "stub_user"
    comment: str = ""
    edited_diff: str = ""
    policy: dict[str, Any] = Field(
        default_factory=lambda: {"code_change_enabled": False}
    )


class CreateGrantRequest(BaseModel):
    granted_user_id: str
    granted_by_user_id: str
    scope_type: str
    scope_value: str
    reason: str = ""
    expires_at: str = ""


class CreateDelegationRequest(BaseModel):
    delegator_user_id: str
    delegate_user_id: str
    starts_at: str
    ends_at: str
    scope_filter: str = ""


class AutoApprovalRequest(BaseModel):
    patch_id: str
    metrics: dict[str, Any] = Field(default_factory=dict)
    policy: dict[str, Any] = Field(default_factory=dict)


class AutoApprovalDryRunRequest(BaseModel):
    requested_by_user_id: str = "stub_user"
    window_days: int = Field(30, ge=1, le=90)


class RevertRequest(BaseModel):
    policy: dict[str, Any] = Field(
        default_factory=lambda: {"code_change_enabled": False}
    )
    pr_state: str = "merged"
    history_is_linear: bool = True
    regression_evidence: dict[str, Any] = Field(default_factory=dict)


class TestPatchRequest(BaseModel):
    patch_id: str


class OpenPRRequest(BaseModel):
    policy: dict[str, Any] = Field(
        default_factory=lambda: {"code_change_enabled": False}
    )


class PostMergeWatchRequest(BaseModel):
    patch_id: str
    affected_metrics: list[str] | None = None


# ─── Repos ────────────────────────────────────────────────────────
@router.post("/repos/connect")
async def connect_repo(
    org_id: str = Path(...),
    body: ConnectRepoRequest = Body(...),
) -> dict[str, Any]:
    return await _repo_connector.connect(
        org_id,
        provider=body.provider,
        repo_full_name=body.repo_full_name,
        default_branch=body.default_branch,
        connected_by_user_id=body.connected_by_user_id,
    )


@router.get("/repos")
async def list_repos(org_id: str = Path(...)) -> dict[str, Any]:
    return await _repo_connector.list_repos(org_id)


@router.get("/repos/{repo_id}")
async def get_repo(
    org_id: str = Path(...),
    repo_id: str = Path(...),
) -> dict[str, Any]:
    return await _repo_connector.get_repo(org_id, repo_id)


@router.delete("/repos/{repo_id}")
async def disconnect_repo(
    org_id: str = Path(...),
    repo_id: str = Path(...),
) -> dict[str, Any]:
    return await _repo_connector.disconnect(org_id, repo_id)


# ─── Policy ───────────────────────────────────────────────────────
@router.post("/policy")
async def update_policy(
    org_id: str = Path(...),
    body: UpdatePolicyRequest = Body(...),
) -> dict[str, Any]:
    return await _policy.update(org_id, body.policy)


@router.get("/policy")
async def get_policy(org_id: str = Path(...)) -> dict[str, Any]:
    return await _policy.get(org_id)


# ─── Patches ──────────────────────────────────────────────────────
@router.post("/patches")
async def propose_patch(
    org_id: str = Path(...),
    body: ProposePatchRequest = Body(...),
) -> dict[str, Any]:
    return await _patch_generator.generate(
        org_id,
        rca_id=body.rca_id,
        trace_id=body.trace_id,
        repo_id=body.repo_id,
    )


@router.get("/patches/{patch_id}")
async def get_patch(
    org_id: str = Path(...),
    patch_id: str = Path(...),
) -> dict[str, Any]:
    return await _inbox.get_patch(org_id, patch_id)


@router.post("/patches/{patch_id}/test")
async def test_patch(
    org_id: str = Path(...),
    patch_id: str = Path(...),
    body: TestPatchRequest = Body(...),
) -> dict[str, Any]:
    return await _test_runner.run(org_id, patch_id=body.patch_id)


@router.post("/patches/{patch_id}/pr")
async def open_pr(
    org_id: str = Path(...),
    patch_id: str = Path(...),
    body: OpenPRRequest = Body(...),
) -> dict[str, Any]:
    return await _pr_creator.create(
        org_id, patch_id=patch_id, policy=body.policy
    )


# ─── Inbox ────────────────────────────────────────────────────────
@router.post("/inbox/list")
async def list_inbox(
    org_id: str = Path(...),
    body: InboxListRequest = Body(...),
) -> dict[str, Any]:
    return await _inbox.list_inbox(
        org_id,
        status=body.status,
        sort=body.sort,
        group_by=body.group_by,
        limit=body.limit,
    )


@router.get("/inbox")
async def get_inbox_default(org_id: str = Path(...)) -> dict[str, Any]:
    """Default inbox view (status=open, sort=priority, group_by=repo)."""
    return await _inbox.list_inbox(org_id)


@router.get("/inbox/stats")
async def get_inbox_stats(org_id: str = Path(...)) -> dict[str, Any]:
    return await _inbox.get_stats(org_id)


@router.get("/inbox/{patch_id}/diff")
async def get_inbox_diff(
    org_id: str = Path(...),
    patch_id: str = Path(...),
) -> dict[str, Any]:
    return await _inbox.get_diff(org_id, patch_id)


@router.get("/inbox/{patch_id}/style")
async def get_inbox_style(
    org_id: str = Path(...),
    patch_id: str = Path(...),
) -> dict[str, Any]:
    return await _inbox.get_style(org_id, patch_id)


@router.post("/inbox/{patch_id}/{action}")
async def inbox_action(
    org_id: str = Path(...),
    patch_id: str = Path(...),
    action: str = Path(...),
    body: InboxActionRequest = Body(...),
) -> dict[str, Any]:
    return await _review.act(
        org_id,
        patch_id=patch_id,
        action=action,
        policy=body.policy,
        actor_user_id=body.actor_user_id,
        comment=body.comment,
        edited_diff=body.edited_diff,
    )


# ─── Settings — approval grants ──────────────────────────────────
@router.get("/settings/approvals/grants")
async def list_grants(
    org_id: str = Path(...),
    include_revoked: bool = False,
) -> dict[str, Any]:
    return await _grants.list_grants(org_id, include_revoked=include_revoked)


@router.post("/settings/approvals/grants")
async def create_grant(
    org_id: str = Path(...),
    body: CreateGrantRequest = Body(...),
) -> dict[str, Any]:
    return await _grants.create_grant(
        org_id,
        granted_user_id=body.granted_user_id,
        granted_by_user_id=body.granted_by_user_id,
        scope_type=body.scope_type,
        scope_value=body.scope_value,
        reason=body.reason,
        expires_at=body.expires_at,
    )


@router.delete("/settings/approvals/grants/{grant_id}")
async def revoke_grant(
    org_id: str = Path(...),
    grant_id: str = Path(...),
) -> dict[str, Any]:
    return await _grants.revoke_grant(
        org_id, grant_id=grant_id, revoked_by_user_id="stub_user"
    )


# ─── Settings — delegations ──────────────────────────────────────
@router.get("/settings/approvals/delegations")
async def list_delegations(org_id: str = Path(...)) -> dict[str, Any]:
    return await _delegations.list_delegations(org_id)


@router.post("/settings/approvals/delegations")
async def create_delegation(
    org_id: str = Path(...),
    body: CreateDelegationRequest = Body(...),
) -> dict[str, Any]:
    return await _delegations.create_delegation(
        org_id,
        delegator_user_id=body.delegator_user_id,
        delegate_user_id=body.delegate_user_id,
        starts_at=body.starts_at,
        ends_at=body.ends_at,
        scope_filter=body.scope_filter,
    )


# ─── Settings — auto-approval ────────────────────────────────────
@router.post("/settings/auto-approval/evaluate")
async def auto_approval_evaluate(
    org_id: str = Path(...),
    body: AutoApprovalRequest = Body(...),
) -> dict[str, Any]:
    return await _auto_approval_rules.evaluate(
        org_id,
        patch_id=body.patch_id,
        metrics=body.metrics,
        policy=body.policy,
    )


@router.post("/settings/auto-approval/metrics")
async def auto_approval_metrics(
    org_id: str = Path(...),
    diff: str = "",
    blast_radius_score: float = 0.0,
    quality_score: float = 0.0,
    rca_confidence: float = 0.0,
) -> dict[str, Any]:
    return await _auto_approval_metrics.collect(
        org_id,
        diff=diff,
        blast_radius_score=blast_radius_score,
        quality_score=quality_score,
        rca_confidence=rca_confidence,
    )


@router.post("/settings/auto-approval/dry-run")
async def auto_approval_dry_run(
    org_id: str = Path(...),
    body: AutoApprovalDryRunRequest = Body(...),
) -> dict[str, Any]:
    return await _auto_approval_dry_run.run(
        org_id,
        requested_by_user_id=body.requested_by_user_id,
        window_days=body.window_days,
    )


@router.post("/settings/auto-approval/rate-limit")
async def auto_approval_rate_limit(
    org_id: str = Path(...),
    per_day_count: int = 0,
    per_file_per_week_count: int = 0,
    max_per_day: int = 20,
    max_per_file_per_week: int = 3,
) -> dict[str, Any]:
    return await _auto_approval_rate_limit.check(
        org_id,
        per_day_count=per_day_count,
        per_file_per_week_count=per_file_per_week_count,
        max_per_day=max_per_day,
        max_per_file_per_week=max_per_file_per_week,
    )


# ─── PRs ─────────────────────────────────────────────────────────
@router.get("/prs")
async def list_prs(org_id: str = Path(...)) -> dict[str, Any]:
    """List the org's PRs. STUB: empty list."""
    return not_implemented(
        "list_prs",
        message=(
            "Stub list — Gate 4a will read from pull_requests + "
            "patch_approvals + patch_approval_status."
        ),
    )


@router.get("/prs/{pr_id}")
async def get_pr(
    org_id: str = Path(...),
    pr_id: str = Path(...),
) -> dict[str, Any]:
    return not_implemented(
        "get_pr",
        message="Stub read — Gate 4a will return the full row.",
        data={"pr_id": pr_id},
    )


@router.post("/prs/{pr_id}/revert")
async def revert_pr(
    org_id: str = Path(...),
    pr_id: str = Path(...),
    body: RevertRequest = Body(...),
) -> dict[str, Any]:
    return await _revert.revert(
        org_id,
        pr_id=pr_id,
        policy=body.policy,
        pr_state=body.pr_state,
        history_is_linear=body.history_is_linear,
        regression_evidence=body.regression_evidence,
    )


@router.post("/prs/{pr_id}/start-watching")
async def start_watching(
    org_id: str = Path(...),
    pr_id: str = Path(...),
    body: PostMergeWatchRequest = Body(...),
) -> dict[str, Any]:
    return await _post_merge.start_watching(
        org_id,
        pr_id=pr_id,
        patch_id=body.patch_id,
        affected_metrics=body.affected_metrics,
    )
