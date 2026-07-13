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

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_org_member,
    require_org_permission_dep,
)
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
    PRPatternService,
    PRQualityScorer,
    PRReviewerNotifier,
    PRReviewService,
    RepoConnector,
    TestPlanRunner,
)
from eden.code_change._common import (
    _error_envelope,
    _new_id,
    _ok_envelope,
    _select_one,
    _select_rows,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/code-change",
    tags=["intelligence-code-change"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_org_member),
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
_pr_pattern_service = PRPatternService()


# ─── Schemas ───────────────────────────────────────────────────────
class ConnectRepoRequest(BaseModel):
    provider: str = Field(..., description="github, gitlab, or bitbucket")
    repo_full_name: str
    default_branch: str = "main"
    # Gate 1: optional GitHub App installation id. When provided the
    # connector will verify the install via the GitHub API and flip the
    # repo_connections row to status='active' on success.
    installation_id: str | None = None
    model_config = {"extra": "ignore"}  # Audit 2026-07-02 S-4: ignore forged fields


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
    comment: str = ""
    edited_diff: str = ""
    policy: dict[str, Any] = Field(
        default_factory=lambda: {"code_change_enabled": False}
    )
    model_config = {"extra": "ignore"}  # Audit 2026-07-02 S-4: ignore forged fields


class CreateGrantRequest(BaseModel):
    granted_user_id: str
    scope_type: str
    scope_value: str
    reason: str = ""
    expires_at: str = ""
    model_config = {"extra": "ignore"}  # Audit 2026-07-02 S-4: ignore forged fields


class CreateDelegationRequest(BaseModel):
    delegate_user_id: str
    starts_at: str
    ends_at: str
    scope_filter: str = ""
    model_config = {"extra": "ignore"}  # Audit 2026-07-02 S-4: ignore forged fields


class AutoApprovalRequest(BaseModel):
    patch_id: str
    metrics: dict[str, Any] = Field(default_factory=dict)
    model_config = {"extra": "ignore"}  # Audit 2026-07-02 S-4: ignore forged fields


class AutoApprovalDryRunRequest(BaseModel):
    window_days: int = Field(30, ge=1, le=90)
    model_config = {"extra": "ignore"}  # Audit 2026-07-02 S-4: ignore forged fields


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
    user: dict = Depends(get_current_user),
    _admin: dict = Depends(require_org_permission_dep("settings:edit")),
) -> dict[str, Any]:
    # Audit 2026-07-02 S-4 — connected_by_user_id comes from auth, not body
    return await _repo_connector.connect(
        org_id,
        provider=body.provider,
        repo_full_name=body.repo_full_name,
        default_branch=body.default_branch,
        connected_by_user_id=user.get("user_id") or user.get("sub", "user-test"),
        installation_id=body.installation_id,
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
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    return await _repo_connector.disconnect(org_id, repo_id)


# ─── CODEOWNERS (Gate 1) ─────────────────────────────────────
@router.get("/repos/codeowners")
async def read_repo_codeowners(
    org_id: str = Path(...),
) -> dict[str, Any]:
    """Read + parse the connected repo's CODEOWNERS file.

    Probes the three GitHub-standard locations in order
    (``.github/CODEOWNERS``, ``CODEOWNERS``,
    ``docs/CODEOWNERS``) and returns the parsed entries.
    Side-effect free. Cat 23 Gate-1 audit entrypoint.
    """
    return await _repo_connector.read_codeowners(org_id)


@router.post("/repos/codeowners/owners")
async def resolve_codeowners_for_files(
    org_id: str = Path(...),
    file_paths: list[str] = Body(..., embed=True),
) -> dict[str, Any]:
    """Resolve the CODEOWNERS owner for each file path.

    Last-match-wins per GitHub semantics. Empty owner list
    when no pattern matches or when no CODEOWNERS file
    exists — the caller is responsible for the manual-
    reviewer fallback.
    """
    return await _repo_connector.owners_for_files(org_id, file_paths)


# ─── Policy ───────────────────────────────────────────────────────
@router.post("/policy")
async def update_policy(
    org_id: str = Path(...),
    body: UpdatePolicyRequest = Body(...),
    _admin: dict = Depends(require_org_admin),
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
    _admin: dict = Depends(require_org_admin),
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
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # Audit 2026-07-02 S-4 — actor_user_id comes from auth, not body
    return await _review.act(
        org_id,
        patch_id=patch_id,
        action=action,
        policy=body.policy,
        actor_user_id=user.get("user_id") or user.get("sub", "user-test"),
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
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # Audit 2026-07-02 S-4 — granted_by_user_id comes from auth, not body
    return await _grants.create_grant(
        org_id,
        granted_user_id=body.granted_user_id,
        granted_by_user_id=user.get("user_id") or user.get("sub", "user-test"),
        scope_type=body.scope_type,
        scope_value=body.scope_value,
        reason=body.reason,
        expires_at=body.expires_at,
    )


@router.delete("/settings/approvals/grants/{grant_id}")
async def revoke_grant(
    org_id: str = Path(...),
    grant_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # Audit 2026-07-02 S-4 — revoked_by_user_id comes from auth, not body
    return await _grants.revoke_grant(
        org_id, grant_id=grant_id, revoked_by_user_id=user.get("user_id") or user.get("sub", "user-test")
    )


# ─── Settings — delegations ──────────────────────────────────────
@router.get("/settings/approvals/delegations")
async def list_delegations(org_id: str = Path(...)) -> dict[str, Any]:
    return await _delegations.list_delegations(org_id)


@router.post("/settings/approvals/delegations")
async def create_delegation(
    org_id: str = Path(...),
    body: CreateDelegationRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # Audit 2026-07-02 S-4 — delegator_user_id comes from auth, not body
    return await _delegations.create_delegation(
        org_id,
        delegator_user_id=user.get("user_id") or user.get("sub", "user-test"),
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
    # Audit 2026-07-02 S-4 — policy is resolved from DB, NEVER from
    # the body. The body-schema strips ``policy`` via extra='ignore',
    # but the route is the authoritative source of truth.
    from eden.code_change import policy as _policy_mod

    db_policy = await _policy_mod.get_org_code_change_policy(org_id)
    return await _auto_approval_rules.evaluate(
        org_id,
        patch_id=body.patch_id,
        metrics=body.metrics,
        policy=db_policy,
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
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    # Audit 2026-07-02 S-4 — requested_by_user_id comes from auth, not body
    return await _auto_approval_dry_run.run(
        org_id,
        requested_by_user_id=user.get("user_id") or user.get("sub", "user-test"),
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
async def list_prs(
    org_id: str = Path(...),
    state: str = "open",
    repo_id: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """List the org's PRs from the ``pull_requests`` table."""
    return await _pr_creator.list_prs(
        org_id, repo_id=repo_id, state=state, limit=limit,
    )


@router.get("/prs/{pr_id}")
async def get_pr(
    org_id: str = Path(...),
    pr_id: str = Path(...),
) -> dict[str, Any]:
    return await _pr_creator.get_pr(org_id, pr_id)


@router.post("/prs/{pr_id}/revert")
async def revert_pr(
    org_id: str = Path(...),
    pr_id: str = Path(...),
    body: RevertRequest = Body(...),
    _admin: dict = Depends(require_org_admin),
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


# ─── Real Cat 23 service routes (June 2026 audit pass) ────────


class LearnRepoRequest(BaseModel):
    """POST /repos/{id}/learn body. Empty = use the connected
    repo's files (the RepoConnector will pull them via the
    configured provider)."""

    sample_size: int = 20


class BlastRadiusRequest(BaseModel):
    diff: str


class ExplainRequest(BaseModel):
    patch_id: str
    rca_summary: str = ""
    diff_summary: str = ""
    predicted_cost_savings_usd: float = 0.0


class QualityScoreRequest(BaseModel):
    patch_id: str
    diff: str


class TestPlanRequest(BaseModel):
    patch_id: str
    rca_summary: str = ""
    diff: str = ""


class RCALinkRequest(BaseModel):
    rca_id: str
    rca_description: str = ""
    stack_trace: str | None = None
    request_path: str | None = None
    trace_id: str | None = None


@router.post("/repos/{repo_id}/learn")
async def learn_repo(
    org_id: str = Path(...),
    repo_id: str = Path(...),
    body: LearnRepoRequest = Body(default_factory=LearnRepoRequest),
) -> dict[str, Any]:
    """Trigger style + PR pattern learning for the connected repo."""
    style_result = await _style_learner.learn(org_id, repo_id)
    pr_pattern_result = await _pr_pattern_service.learn(org_id, repo_id)
    return {
        "status": "ok",
        "feature": "learn",
        "live": True,
        "trace_id": _new_id("learn"),
        "timestamp": None,
        "data": {
            "style": style_result.get("data"),
            "pr_patterns": pr_pattern_result.get("data"),
        },
    }


@router.get("/repos/{repo_id}/style")
async def get_style(
    org_id: str = Path(...),
    repo_id: str = Path(...),
) -> dict[str, Any]:
    return await _style_learner.get_profile(org_id, repo_id)


@router.get("/repos/{repo_id}/patterns")
async def get_pr_patterns(
    org_id: str = Path(...),
    repo_id: str = Path(...),
) -> dict[str, Any]:
    return await _pr_pattern_service.get_patterns(org_id, repo_id)


@router.get("/repos/{repo_id}/knowledge")
async def get_knowledge(
    org_id: str = Path(...),
    repo_id: str = Path(...),
    rca_category: str | None = None,
    telemetry_signature: str | None = None,
) -> dict[str, Any]:
    """Return the per-repo knowledge graph summary."""
    if rca_category:
        return await _knowledge_graph.same_rca_category_history(
            org_id, repo_id, rca_category,
        )
    if telemetry_signature:
        return await _knowledge_graph.telemetry_signature_match(
            org_id, repo_id, telemetry_signature,
        )
    return {
        "status": "ok",
        "feature": "knowledge",
        "live": True,
        "trace_id": _new_id("know"),
        "timestamp": None,
        "data": {
            "repo_id": repo_id,
            "message": "Pass ?rca_category=<prefix> or "
                       "?telemetry_signature=<sig> to query a "
                       "specific slice of the knowledge graph.",
        },
    }


@router.post("/patches/{patch_id}/blast-radius")
async def blast_radius(
    org_id: str = Path(...),
    patch_id: str = Path(...),
    body: BlastRadiusRequest = Body(...),
) -> dict[str, Any]:
    return await _blast_radius.analyze(
        org_id, diff=body.diff, repo_id=patch_id,
    )


@router.post("/patches/{patch_id}/explain")
async def explain(
    org_id: str = Path(...),
    patch_id: str = Path(...),
    body: ExplainRequest = Body(...),
) -> dict[str, Any]:
    return await _explanation.generate(
        org_id,
        patch_id=body.patch_id,
        rca_summary=body.rca_summary,
        diff_summary=body.diff_summary,
        predicted_cost_savings_usd=body.predicted_cost_savings_usd,
    )


@router.post("/patches/{patch_id}/quality")
async def quality(
    org_id: str = Path(...),
    patch_id: str = Path(...),
    body: QualityScoreRequest = Body(...),
) -> dict[str, Any]:
    return await _quality_scorer.score(
        org_id,
        patch_id=body.patch_id,
        diff=body.diff,
        repo_id=patch_id,
    )


@router.post("/patches/{patch_id}/test-plan")
async def test_plan(
    org_id: str = Path(...),
    patch_id: str = Path(...),
    body: TestPlanRequest = Body(...),
) -> dict[str, Any]:
    return await _test_runner.generate_plan(
        org_id,
        patch_id=body.patch_id,
        rca_summary=body.rca_summary,
        diff=body.diff,
    )


@router.post("/rca/link")
async def link_rca(
    org_id: str = Path(...),
    body: RCALinkRequest = Body(...),
) -> dict[str, Any]:
    return await _rca_linker.link(
        org_id,
        rca_id=body.rca_id,
        repo_id="",
        rca_description=body.rca_description,
        stack_trace=body.stack_trace,
        request_path=body.request_path,
        trace_id=body.trace_id,
    )



# ─── Discipline (Cat 23 v1.7 PR revamp) ──────────────────────────
#
# These endpoints expose the discipline layer for the
# portal UI: the repo-graph status, the dedupe index,
# the circuit-breaker status, and the rate-limit
# snapshot. They are read-only side-effect-light
# endpoints — the actual trigger flows are invoked
# elsewhere (the incident pipeline + the scheduled
# optimization cron).


class DisciplineDecisionRequest(BaseModel):
    trigger_kind: str = Field(
        "incident",
        description="incident or scheduled",
    )
    trigger_identifier: str = Field(...)
    summary: str = ""
    rca_confidence: float = 0.0
    quality_score: float = 0.0
    blast_radius_score: float = 0.0
    evidence_count: int = 0
    reverted_history: int = 0
    denied_history: int = 0
    fix_area_localized: bool = False
    can_validate: bool = False
    protected_path_match: bool = False
    file_paths: list[str] = Field(default_factory=list)
    repo_id: str = ""
    model_config = {"extra": "ignore"}


@router.post("/discipline/decide")
async def discipline_decide(
    org_id: str = Path(...),
    body: DisciplineDecisionRequest = Body(...),
) -> dict[str, Any]:
    """Evaluate the discipline gate for a single candidate.

    Returns the same Cat 23 envelope shape as the rest
    of the surface so the portal can render uniformly.
    """
    from eden.code_change.discipline import (
        Trigger,
        compute_decision,
    )

    trigger = Trigger(
        kind=body.trigger_kind if body.trigger_kind in ("incident", "scheduled") else "incident",
        identifier=body.trigger_identifier,
        summary=body.summary,
    )
    decision = compute_decision(
        trigger,
        rca_confidence=body.rca_confidence,
        quality_score=body.quality_score,
        blast_radius_score=body.blast_radius_score,
        evidence_count=body.evidence_count,
        reverted_history=body.reverted_history,
        denied_history=body.denied_history,
        fix_area_localized=body.fix_area_localized,
        can_validate=body.can_validate,
        protected_path_match=body.protected_path_match,
        file_paths=tuple(body.file_paths),
    )
    return _ok_envelope(
        "discipline",
        {
            "decision": {
                "allowed": decision.allowed,
                "score": decision.score,
                "reasons": decision.reasons,
                "fingerprint": decision.fingerprint,
                "trigger_kind": trigger.kind,
                "trigger_identifier": trigger.identifier,
            }
        },
    )


@router.get("/discipline/breaker-status")
async def discipline_breaker_status(
    org_id: str = Path(...),
    breaker_name: str = "incident_pr",
) -> dict[str, Any]:
    """Return the current state of the org's PR breaker."""
    from eden.code_change.discipline.circuit_breaker import CircuitBreaker

    breaker = CircuitBreaker(breaker_name=breaker_name)
    status = await breaker.status(org_id)
    return _ok_envelope("discipline", {"breaker": status})


@router.post("/discipline/breaker-reset")
async def discipline_breaker_reset(
    org_id: str = Path(...),
    breaker_name: str = "incident_pr",
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Manually reset an org's PR breaker (admin-only)."""
    from eden.code_change.discipline.circuit_breaker import CircuitBreaker

    breaker = CircuitBreaker(breaker_name=breaker_name)
    await breaker.record_outcome(org_id, outcome="manual_reset")
    status = await breaker.status(org_id)
    return _ok_envelope(
        "discipline",
        {"breaker": status, "message": "breaker reset"},
    )


@router.get("/discipline/rate-limit")
async def discipline_rate_limit(
    org_id: str = Path(...),
    repo_id: str = "",
) -> dict[str, Any]:
    """Return the current rate-limit snapshot for an org (+ optional repo)."""
    from eden.code_change.discipline import RateLimiter

    limiter = RateLimiter()
    verdict = await limiter.check(org_id, repo_id)
    return _ok_envelope("discipline", {"rate_limit": verdict})


@router.get("/repos/graph-status")
async def repo_graph_status(
    org_id: str = Path(...),
    repo_full_name: str | None = None,
) -> dict[str, Any]:
    """Return the repo-graph status for an org's linked repo(s).

    When ``repo_full_name`` is omitted, returns the status
    for the first active repo in the org. The endpoint
    surfaces whether Greptile is configured (via the
    ``graph_provider`` column) and the most recent
    ``graph_indexed_at`` timestamp.
    """
    from eden.code_change.graph import get_default_repo_graph

    graph = get_default_repo_graph()
    graph_name = getattr(graph, "name", "unknown")
    if repo_full_name is None:
        rows = await _select_rows(
            org_id,
            "repo_connections",
            where="status = 'active'",
            order_by="created_at DESC",
            limit=1,
        )
        if not rows:
            return _ok_envelope(
                "graph_status",
                {
                    "graph_provider": graph_name,
                    "repos": [],
                    "message": "no active repos for this org",
                },
            )
        repo_full_name = str(rows[0].get("repo_full_name") or "")
        branch = str(rows[0].get("default_branch") or "main")
    else:
        branch = "main"
    if not repo_full_name:
        return _ok_envelope(
            "graph_status",
            {
                "graph_provider": graph_name,
                "repos": [],
                "message": "repo_full_name not set",
            },
        )
    status = await graph.status(repo_full_name, branch=branch)
    return _ok_envelope(
        "graph_status",
        {
            "graph_provider": graph_name,
            "repo_full_name": repo_full_name,
            "branch": branch,
            "status": status,
        },
    )


@router.post("/repos/{repo_id}/request-index")
async def request_repo_index(
    org_id: str = Path(...),
    repo_id: str = Path(...),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Kick off (re-)indexing for a linked repo.

    Returns the acceptance status. The actual indexing
    runs in the background; callers should poll
    ``GET /repos/graph-status`` to confirm completion.
    """
    from eden.code_change.graph import get_default_repo_graph

    row = await _select_one(
        org_id,
        "repo_connections",
        where="id = $2",
        params=(repo_id,),
    )
    if row is None:
        return _error_envelope(
            "graph_status",
            message=f"repo {repo_id} not found",
            error_code="repo_not_found",
        )
    repo_full_name = str(row.get("repo_full_name") or "")
    branch = str(row.get("default_branch") or "main")
    if not repo_full_name:
        return _error_envelope(
            "graph_status",
            message="repo_full_name not set on connection",
            error_code="repo_full_name_missing",
        )
    graph = get_default_repo_graph()
    accepted = await graph.request_index(
        repo_full_name, branch=branch,
    )
    return _ok_envelope(
        "graph_status",
        {
            "repo_id": repo_id,
            "repo_full_name": repo_full_name,
            "branch": branch,
            "index_requested": accepted,
            "graph_provider": getattr(graph, "name", "unknown"),
        },
    )
