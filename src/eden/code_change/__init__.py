"""Autonomous Code Modification (Cat 23) — v1.6 STUB surface.

The Cat 23 surface is the largest single package in the v1.6
catalogue and the deepest closed-loop in the entire roadmap.
The package ships as a STUB surface per the v1.6 STUB
checklist; the real end-to-end ship is gated on the 4 hard
gates (read-only → attribution → sandbox → end-to-end)
documented in ``docs/observability-gap/
23-autonomous-code-modification.md``.

The 21 service classes (per the v1.6 cat spec, mapping to the
v1.6 STUB checklist's 18 + the 3 sub-package services for the
admin-controlled approval workflow):

Identity layer (3):

* :class:`RepoConnector` — connect Eden to a GitHub / GitLab /
  Bitbucket repo as a first-class identity.
* :class:`AgentPersonaService` — the per-tenant "Eden Agent"
  identity (display name, avatar, voice, track record).
* :class:`AgentActivityFeed` — the agent's public activity
  feed in the portal.

Trigger layer (2):

* :class:`CodeChangePolicyService` — the per-tenant + per-repo
  opt-in policy (the two-stage opt-in).
* :class:`CodeRootCauseLinker` — map a Cat 2 RCA to source
  files via 4-source correlation (Gate 2).

Generation layer (5):

* :class:`CodeStyleLearner` (style/style_learner.py) — learn
  the repo's style from the last 100 merged PRs.
* :class:`PRQualityScorer` (quality/quality_scorer.py) — the
  multi-dimensional 0-1 quality score.
* :class:`PRExplanationService` — the 4-paragraph
  human-readable explanation.
* :class:`PatchGenerator` — generate a unified diff (Gate 4a).
* :class:`TestPlanRunner` — run the CI + regression + golden
  test suites in a sandbox (Gate 3).
* :class:`BlastRadiusAnalyzer` — compute the 0-1 blast-radius
  score (Gate 2).
* :class:`CodebaseKnowledgeGraph` — per-repo graph of
  ``(code_path, telemetry_signature, history)`` (Gate 5).

Review layer (5):

* :class:`PRInboxService` (inbox/inbox.py) — the human-in-
  the-loop inbox for proposed patches.
* :class:`PRReviewService` (inbox/review.py) — the 8 actions
  a human can take on a patch.
* :class:`ApprovalGrantService` (approvals/grants.py) — the
  admin-controlled approval grants.
* :class:`ApprovalWorkflowService` (approvals/workflow.py) —
  the multi-approval workflow engine.
* :class:`ApprovalDelegationService`
  (approvals/delegations.py) — out-of-office delegations.
* :class:`AutoApprovalRuleService`
  (auto_approval/rules.py) — evaluate a patch against the
  auto-approval policy.
* :class:`AutoApprovalMetricsCollector`
  (auto_approval/metrics.py) — compute the patch metrics.
* :class:`AutoApprovalDryRunService`
  (auto_approval/dry_run.py) — dry-run the rule.
* :class:`AutoApprovalRateLimiter`
  (auto_approval/rate_limit.py) — enforce the per-day +
  per-file-per-week caps.

Auto-mode ops (3):

* :class:`PRCreator` — open a real PR (Gate 4a).
* :class:`PostMergeMonitor` — watch at 1h/6h/24h/7d (Gate
  4b).
* :class:`AutoRevertEngine` — 3-strategy auto-revert
  (Gate 4b).
* :class:`PRReviewerNotifier` — post the PR link to
  Slack/Teams.

The package uses **lazy re-exports** so that
``from eden.code_change import PatchGenerator`` does not
eagerly import :mod:`eden.code_change.patch_generator` (which
pulls in the patch generation glue). Routes that need a
specific service should either rely on the lazy re-export or
import the service module directly:

    from eden.code_change.patch_generator import PatchGenerator

See ``docs/observability-gap/23-autonomous-code-modification.md``
for the full design + the 4-gate rollout plan.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    # Identity layer
    "AgentActivityFeed",
    "AgentPersonaService",
    "ApprovalDelegationService",
    "ApprovalGrantService",
    "ApprovalWorkflowService",
    "AutoApprovalDryRunService",
    "AutoApprovalMetricsCollector",
    "AutoApprovalRateLimiter",
    "AutoApprovalRuleService",
    "AutoRevertEngine",
    "BlastRadiusAnalyzer",
    "CodeChangePolicyService",
    "CodeRootCauseLinker",
    "CodeStyleLearner",
    "CodebaseKnowledgeGraph",
    "PatchGenerator",
    "PostMergeMonitor",
    "PRCreator",
    "PRExplanationService",
    "PRInboxService",
    "PRPatternService",
    "PRQualityScorer",
    "PRReviewerNotifier",
    "PRReviewService",
    "RepoConnector",
    "TestPlanRunner",
]


if TYPE_CHECKING:  # pragma: no cover - import only
    from .activity_feed import AgentActivityFeed
    from .approvals.delegations import ApprovalDelegationService
    from .approvals.grants import ApprovalGrantService
    from .approvals.workflow import ApprovalWorkflowService
    from .auto_approval.dry_run import AutoApprovalDryRunService
    from .auto_approval.metrics import AutoApprovalMetricsCollector
    from .auto_approval.rate_limit import AutoApprovalRateLimiter
    from .auto_approval.rules import AutoApprovalRuleService
    from .blast_radius import BlastRadiusAnalyzer
    from .explanation import PRExplanationService
    from .inbox.inbox import PRInboxService
    from .inbox.review import PRReviewService
    from .knowledge_graph import CodebaseKnowledgeGraph
    from .notify import PRReviewerNotifier
    from .patch_generator import PatchGenerator
    from .persona import AgentPersonaService
    from .policy import CodeChangePolicyService
    from .post_merge_monitor import PostMergeMonitor
    from .pr_creator import PRCreator
    from .pr_patterns import PRPatternService
    from .quality.quality_scorer import PRQualityScorer
    from .rca_linker import CodeRootCauseLinker
    from .repo_connector import RepoConnector
    from .revert_engine import AutoRevertEngine
    from .style.style_learner import CodeStyleLearner
    from .test_runner import TestPlanRunner


# Map public name -> (module, attribute) for the lazy ``__getattr__``.
# Centralised so the public surface and the import spec stay in
# sync. Adding a new service means adding two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "AgentActivityFeed": (".activity_feed", "AgentActivityFeed"),
    "AgentPersonaService": (".persona", "AgentPersonaService"),
    "ApprovalDelegationService": (
        ".approvals.delegations",
        "ApprovalDelegationService",
    ),
    "ApprovalGrantService": (".approvals.grants", "ApprovalGrantService"),
    "ApprovalWorkflowService": (".approvals.workflow", "ApprovalWorkflowService"),
    "AutoApprovalDryRunService": (
        ".auto_approval.dry_run",
        "AutoApprovalDryRunService",
    ),
    "AutoApprovalMetricsCollector": (
        ".auto_approval.metrics",
        "AutoApprovalMetricsCollector",
    ),
    "AutoApprovalRateLimiter": (
        ".auto_approval.rate_limit",
        "AutoApprovalRateLimiter",
    ),
    "AutoApprovalRuleService": (".auto_approval.rules", "AutoApprovalRuleService"),
    "AutoRevertEngine": (".revert_engine", "AutoRevertEngine"),
    "BlastRadiusAnalyzer": (".blast_radius", "BlastRadiusAnalyzer"),
    "CodeChangePolicyService": (".policy", "CodeChangePolicyService"),
    "CodeRootCauseLinker": (".rca_linker", "CodeRootCauseLinker"),
    "CodeStyleLearner": (".style.style_learner", "CodeStyleLearner"),
    "CodebaseKnowledgeGraph": (".knowledge_graph", "CodebaseKnowledgeGraph"),
    "PRCreator": (".pr_creator", "PRCreator"),
    "PRExplanationService": (".explanation", "PRExplanationService"),
    "PRInboxService": (".inbox.inbox", "PRInboxService"),
    "PRPatternService": (".pr_patterns", "PRPatternService"),
    "PRQualityScorer": (".quality.quality_scorer", "PRQualityScorer"),
    "PRReviewerNotifier": (".notify", "PRReviewerNotifier"),
    "PRReviewService": (".inbox.review", "PRReviewService"),
    "PatchGenerator": (".patch_generator", "PatchGenerator"),
    "PostMergeMonitor": (".post_merge_monitor", "PostMergeMonitor"),
    "RepoConnector": (".repo_connector", "RepoConnector"),
    "TestPlanRunner": (".test_runner", "TestPlanRunner"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``PatchGenerator`` to the
    implementation in the corresponding submodule. The submodule
    is imported on first access and cached in ``sys.modules``,
    so subsequent accesses are O(1).
    """
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module

        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value  # cache for next access
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    """Make ``dir(eden.code_change)`` show the public surface — useful
    for REPL auto-completion and for the test suite's introspection."""
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
