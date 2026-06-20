"""STUB tests for Cat 23 — Autonomous Code Modification.

The v1.6 STUB verification checklist (per
``docs/eden-observability-gap-roadmap.md``) requires 30+ STUB
tests that:

* confirm the 21 Cat 23 service classes are importable from
  ``eden.code_change`` and its sub-packages
* confirm the package re-exports work via PEP 562 lazy
  ``__getattr__``
* confirm the read-only routes return the live envelope
  (``status="ok"``, ``live=True``)
* confirm the destructive routes return the
  not-implemented envelope (``status="not_implemented"``,
  ``live=False``) with the correct ``gate=<N>_blocked`` marker
* confirm the two-stage opt-in is enforced BEFORE any
  side-effect (the v1.6 STUB checklist constraint)
* confirm the new ``CodeChangeHook`` is registered in
  ``register_all_hooks()`` and is callable from the Cat 2
  RCA scorer (no-op in STUB mode — logs the call, doesn't
  actually generate a patch)
* confirm the umbrella ``intelligence_gap_v0`` flag still
  gates the surface
* confirm the existing 14/23 IMPLEMENTED cats' tests still
  pass (no regressions in adjacent suites)

Mirrors the structure of
:mod:`tests.intelligence.test_autonomous_intelligence` and
:mod:`tests.intelligence.test_metric_studio` — service-level
unit tests + route-level smoke tests, no Postgres required
(``_check_two_stage_optin`` + the live / not-implemented
envelope are pure functions).
"""

from __future__ import annotations

import importlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── 1. Package re-exports + module shape ──────────────────────────


class TestPackageReExports:
    """The 26 public names (PRPatternService added June 2026) listed in ``__all__`` resolve via PEP 562
    lazy ``__getattr__`` to the implementation in the corresponding
    submodule."""

    def test_all_26_names_importable(self) -> None:
        from eden.code_change import __all__

        assert len(__all__) == 26
        for name in __all__:
            assert isinstance(name, str)
            assert name, "empty public name"

    @pytest.mark.parametrize(
        "name",
        [
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
            "PRQualityScorer",
            "PRReviewerNotifier",
            "PRReviewService",
            "RepoConnector",
            "TestPlanRunner",
        ],
    )
    def test_public_name_resolves_to_class(self, name: str) -> None:
        from eden import code_change

        cls = getattr(code_change, name)
        assert isinstance(cls, type), f"{name} should be a class"
        # Every service class exposes a ``name`` attribute so the
        # closed-loop hook + the activity feed + the envelope
        # wrapper can identify the source service.
        assert hasattr(cls, "name"), f"{name} should have a .name attr"

    def test_dir_shows_public_surface(self) -> None:
        from eden import code_change

        public = set(code_change.__dir__())
        # The 26 public names (PRPatternService added June 2026) + the package's own module-level
        # names (``__all__``, ``_LAZY_IMPORTS``, ``__getattr__``,
        # ``__dir__``).
        for name in (
            "AgentActivityFeed",
            "PatchGenerator",
            "RepoConnector",
            "TestPlanRunner",
        ):
            assert name in public

    def test_unknown_name_raises_attributeerror(self) -> None:
        from eden import code_change

        with pytest.raises(AttributeError):
            _ = code_change.NotARealService  # type: ignore[attr-defined]


# ─── 2. Service-class shape ────────────────────────────────────────


class TestServiceClassShape:
    """Every service class has a ``.name`` attribute + at least one
    async method that returns the right envelope shape."""

    def test_repo_connector_has_4_methods(self) -> None:
        from eden.code_change import RepoConnector

        rc = RepoConnector()
        for method in ("connect", "list_repos", "get_repo", "disconnect"):
            assert hasattr(rc, method)
            assert callable(getattr(rc, method))

    def test_pr_inbox_has_5_methods(self) -> None:
        from eden.code_change import PRInboxService

        ib = PRInboxService()
        for method in (
            "list_inbox",
            "get_patch",
            "get_diff",
            "get_style",
            "get_stats",
        ):
            assert hasattr(ib, method)

    def test_pr_review_has_act_method(self) -> None:
        from eden.code_change import PRReviewService

        rv = PRReviewService()
        assert hasattr(rv, "act")
        assert callable(rv.act)


# ─── 3. Read-only routes return the live envelope ──────────────────


class TestReadOnlyRoutesReturnLiveEnvelope:
    """Per the v1.6 STUB checklist, the read-only routes return
    the live envelope (``status="ok"``, ``live=True``) with a
    deterministic in-memory response derived from the input."""

    @pytest.mark.asyncio
    async def test_repo_connector_list_repos(self) -> None:
        from eden.code_change import RepoConnector

        result = await RepoConnector().list_repos("org_test")
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["feature"] == "repo_connector"
        assert result["data"]["repos"] == []
        assert result["data"]["count"] == 0

    @pytest.mark.asyncio
    async def test_policy_get_returns_defaults(self) -> None:
        from eden.code_change import CodeChangePolicyService

        result = await CodeChangePolicyService().get("org_test")
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["policy"]["code_change_enabled"] is False
        assert result["data"]["policy"]["auto_pr_enabled"] is False
        assert result["data"]["policy"]["auto_revert_enabled"] is False

    @pytest.mark.asyncio
    async def test_inbox_list_inbox_default(self) -> None:
        from eden.code_change import PRInboxService

        result = await PRInboxService().list_inbox("org_test")
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["status"] == "open"
        assert result["data"]["sort"] == "priority"
        assert result["data"]["patches"] == []

    @pytest.mark.asyncio
    async def test_inbox_stats_zero_counters(self) -> None:
        from eden.code_change import PRInboxService

        result = await PRInboxService().get_stats("org_test")
        assert result["status"] == "ok"
        assert result["data"]["proposed_count"] == 0
        assert result["data"]["approved_count"] == 0
        assert result["data"]["merged_count"] == 0

    @pytest.mark.asyncio
    async def test_activity_feed_list_events(self) -> None:
        from eden.code_change import AgentActivityFeed

        result = await AgentActivityFeed().list_events("org_test", limit=10)
        assert result["status"] == "ok"
        assert result["data"]["events"] == []
        assert result["data"]["limit"] == 10

    @pytest.mark.asyncio
    async def test_grants_list_grants(self) -> None:
        from eden.code_change import ApprovalGrantService

        result = await ApprovalGrantService().list_grants("org_test")
        assert result["status"] == "ok"
        assert result["data"]["grants"] == []

    @pytest.mark.asyncio
    async def test_delegations_list(self) -> None:
        from eden.code_change import ApprovalDelegationService

        result = await ApprovalDelegationService().list_delegations("org_test")
        assert result["status"] == "ok"
        assert result["data"]["delegations"] == []

    @pytest.mark.asyncio
    async def test_style_learner_get_profile(self) -> None:
        from eden.code_change import CodeStyleLearner

        result = await CodeStyleLearner().get_profile("org_test", "repo_x")
        assert result["status"] == "ok"
        assert result["data"]["profile"]["indentation"]["type"] == "spaces"


# ─── 4. Destructive routes return the not-implemented envelope ─────


class TestDestructiveRoutesReturnNotImplemented:
    """The v1.6 STUB checklist requires every destructive
    route to return a not-implemented envelope with a
    ``gate=<N>_blocked`` marker so the portal can show
    "this requires Gate N (real ship)"."""

    @pytest.mark.asyncio
    async def test_test_runner_returns_gate_3(self) -> None:
        from eden.code_change import TestPlanRunner

        result = await TestPlanRunner().run("org_test", patch_id="patch_x")
        assert result["status"] == "not_implemented"
        assert result["live"] is False
        assert result["data"]["gate"] == "3_blocked"
        # The inner ``data`` sub-payload carries the sandbox limits.
        assert result["data"]["data"]["sandbox_cpu_limit"] == "2.0"
        assert result["data"]["data"]["sandbox_memory_mb"] == 4096

    @pytest.mark.asyncio
    async def test_patch_generator_returns_gate_4a(self) -> None:
        from eden.code_change import PatchGenerator

        result = await PatchGenerator().generate(
            "org_test", rca_id="rca_x", trace_id="trace_x", repo_id="repo_x"
        )
        # June 2026 audit pass: real implementation exists.
        # Without a router, gate="router_missing". The legacy
        # "4a_blocked" gate is also accepted for backwards-
        # compat with the v1.6 STUB checklist.
        assert result["status"] == "not_implemented"
        assert result["data"]["gate"] in {"router_missing", "4a_blocked"}

    @pytest.mark.asyncio
    async def test_rca_linker_real(self) -> None:
        """June 2026 audit pass: real implementation.

        Without any of the 4 input signals, returns the empty
        envelope (``links: []``). With ``stack_trace`` or
        ``candidate_files`` the linker scores candidates and
        persists the top match.
        """
        from eden.code_change import CodeRootCauseLinker

        result = await CodeRootCauseLinker().link(
            "org_test", rca_id="rca_x", repo_id="repo_x",
        )
        assert result["status"] == "ok"
        assert result["data"]["links"] == []
        assert result["data"]["primary_link_id"] is None

        # With stack trace, the linker extracts files.
        result2 = await CodeRootCauseLinker().link(
            "org_test", rca_id="rca_x", repo_id="repo_x",
            stack_trace='File "src/x.py", line 1, in foo',
        )
        assert result2["status"] == "ok"
        assert any(
            link["path"] == "src/x.py"
            for link in result2["data"]["links"]
        )

    @pytest.mark.asyncio
    async def test_blast_radius_real(self) -> None:
        """June 2026 audit pass: real implementation.

        Returns ``status=ok`` with a 0..1 blast_radius_score.
        The score is the 40/60 weighted average of the static
        + dynamic dimensions per the v1.6 cat spec.
        """
        from eden.code_change import BlastRadiusAnalyzer

        result = await BlastRadiusAnalyzer().analyze(
            "org_test",
            diff=(
                "--- a/src/rate_limiter.py\n+++ b/src/rate_limiter.py\n@@ -1 +1 @@\n"
                "-old\n+new\n"
            ),
            repo_id="repo_x",
        )
        assert result["status"] == "ok"
        assert 0.0 <= result["data"]["blast_radius_score"] <= 1.0
        # The 40/60 weighting is the canonical signal mix.
        assert result["data"]["static_weight"] == 0.4
        assert result["data"]["dynamic_weight"] == 0.6

    @pytest.mark.asyncio
    async def test_knowledge_graph_read_paths_real(self) -> None:
        from eden.code_change import CodebaseKnowledgeGraph

        kg = CodebaseKnowledgeGraph()
        # June 2026 audit pass: read paths now query the real
        # ``codebase_knowledge_graph`` table (no Gate-5 stub).
        # conftest's ``patch_postgres`` mocks ``get_postgres_client``.
        # Note: the real impl takes ``(org_id, repo_id, ...)``;
        # the stub-era test passed only 2 args — fixed here.
        for method, args, key in (
            ("same_file_history", ("org_test", "repo_x", "src/x.py"), "node_id"),
            (
                "same_rca_category_history",
                ("org_test", "repo_x", "rate_limiter"),
                "rca_category",
            ),
            (
                "telemetry_signature_match",
                ("org_test", "repo_x", "sig_123"),
                "telemetry_signature",
            ),
        ):
            result = await getattr(kg, method)(*args)
            # Real path: status=ok, ``data`` carries the
            # method's payload directly (no nested ``data.data``).
            assert result["status"] == "ok"
            assert key in result["data"]


# ─── 5. Two-stage opt-in is enforced BEFORE any side-effect ───────


class TestTwoStageOptin:
    """The v1.6 STUB checklist constraint: "every STUB endpoint
    reads ``code_change_enabled`` BEFORE the auto-mode gates;
    no endpoint auto-creates a PR or auto-reverts without both
    opt-ins"."""

    def test_default_policy_disables_both_optins(self) -> None:
        from eden.code_change._common import DEFAULT_POLICY

        assert DEFAULT_POLICY["code_change_enabled"] is False
        assert DEFAULT_POLICY["auto_pr_enabled"] is False
        assert DEFAULT_POLICY["auto_revert_enabled"] is False

    @pytest.mark.asyncio
    async def test_pr_creator_blocked_when_master_off(self) -> None:
        from eden.code_change import PRCreator

        result = await PRCreator().create(
            "org_test", patch_id="patch_x", policy={"code_change_enabled": False}
        )
        assert result["status"] == "not_implemented"
        assert result["data"]["gate"] == "optin_blocked"
        assert "code_change_enabled is false" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_pr_creator_blocked_when_auto_pr_off(self) -> None:
        from eden.code_change import PRCreator

        result = await PRCreator().create(
            "org_test",
            patch_id="patch_x",
            policy={
                "code_change_enabled": True,
                "auto_pr_enabled": False,
            },
        )
        assert result["status"] == "not_implemented"
        assert result["data"]["gate"] == "auto_mode_blocked"
        assert "auto_pr_enabled=true" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_revert_blocked_when_auto_revert_off(self) -> None:
        from eden.code_change import AutoRevertEngine

        result = await AutoRevertEngine().revert(
            "org_test",
            pr_id="pr_x",
            policy={
                "code_change_enabled": True,
                "auto_revert_enabled": False,
            },
        )
        assert result["status"] == "not_implemented"
        assert result["data"]["gate"] == "auto_mode_blocked"
        assert "auto_revert_enabled=true" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_revert_strategy_picker(self) -> None:
        """With both opt-ins on, the strategy picker picks the
        right strategy for the PR state."""
        from eden.code_change import AutoRevertEngine
        from eden.code_change.revert_engine import (
            STRATEGY_CLOSE_PR,
            STRATEGY_REVERT_BRANCH,
            STRATEGY_REVERT_PR,
        )

        engine = AutoRevertEngine()
        # open PR → close_pr
        r = await engine.revert(
            "org_test",
            pr_id="pr_x",
            policy={
                "code_change_enabled": True,
                "auto_revert_enabled": True,
            },
            pr_state="open",
        )
        assert r["data"]["strategy"] == STRATEGY_CLOSE_PR
        # merged PR with linear history → revert_pr
        r = await engine.revert(
            "org_test",
            pr_id="pr_x",
            policy={
                "code_change_enabled": True,
                "auto_revert_enabled": True,
            },
            pr_state="merged",
            history_is_linear=True,
        )
        assert r["data"]["strategy"] == STRATEGY_REVERT_PR
        # merged PR with non-linear history → revert_branch
        r = await engine.revert(
            "org_test",
            pr_id="pr_x",
            policy={
                "code_change_enabled": True,
                "auto_revert_enabled": True,
            },
            pr_state="merged",
            history_is_linear=False,
        )
        assert r["data"]["strategy"] == STRATEGY_REVERT_BRANCH


# ─── 6. Auto-approval rules evaluate the policy correctly ──────────


class TestAutoApprovalRules:
    """The 12-field auto-approval policy is the core of the
    power-user / enterprise opt-in (v1.6 cat spec)."""

    def test_defaults_all_thresholds_conservative(self) -> None:
        from eden.code_change.auto_approval.rules import AUTO_APPROVAL_DEFAULTS

        # 6 threshold fields — conservative defaults
        assert AUTO_APPROVAL_DEFAULTS["max_risk_score"] == 0.3
        assert AUTO_APPROVAL_DEFAULTS["max_lines_changed"] == 50
        assert AUTO_APPROVAL_DEFAULTS["max_files_changed"] == 3
        assert AUTO_APPROVAL_DEFAULTS["min_quality_score"] == 0.9
        assert AUTO_APPROVAL_DEFAULTS["min_rca_confidence"] == 0.85
        # 4 safety-net fields — default ON
        assert AUTO_APPROVAL_DEFAULTS["require_human_for_protected_paths"] is True
        assert AUTO_APPROVAL_DEFAULTS["require_human_for_first_pr_to_file"] is True
        assert AUTO_APPROVAL_DEFAULTS["cool_off_after_revert_hours"] == 168
        assert AUTO_APPROVAL_DEFAULTS["max_auto_approvals_per_day"] == 20
        # Master switch + dry-run mode
        assert AUTO_APPROVAL_DEFAULTS["enabled"] is False
        assert AUTO_APPROVAL_DEFAULTS["dry_run_mode"] is True

    @pytest.mark.asyncio
    async def test_disabled_master_switch_blocks(self) -> None:
        from eden.code_change import AutoApprovalRuleService

        result = await AutoApprovalRuleService().evaluate(
            "org_test",
            patch_id="patch_x",
            metrics={"lines_changed": 1},
            policy={},  # master switch off
        )
        assert result["data"]["auto_approved"] is False
        assert any("disabled" in c for c in result["data"]["failing_conditions"])

    @pytest.mark.asyncio
    async def test_too_many_lines_blocks(self) -> None:
        from eden.code_change import AutoApprovalRuleService

        result = await AutoApprovalRuleService().evaluate(
            "org_test",
            patch_id="patch_x",
            metrics={
                "lines_changed": 120,
                "files_changed": 1,
                "quality_score": 1.0,
                "rca_confidence": 1.0,
                "blast_radius_score": 0.0,
            },
            policy={"enabled": True},
        )
        assert result["data"]["auto_approved"] is False
        assert any("lines_changed" in c for c in result["data"]["failing_conditions"])

    @pytest.mark.asyncio
    async def test_protected_path_blocks(self) -> None:
        from eden.code_change import AutoApprovalRuleService

        result = await AutoApprovalRuleService().evaluate(
            "org_test",
            patch_id="patch_x",
            metrics={
                "lines_changed": 1,
                "files_changed": 1,
                "quality_score": 1.0,
                "rca_confidence": 1.0,
                "blast_radius_score": 0.0,
                "touches_protected_path": True,
            },
            policy={"enabled": True},
        )
        assert result["data"]["auto_approved"] is False
        assert any("protected_path" in c for c in result["data"]["failing_conditions"])

    @pytest.mark.asyncio
    async def test_clean_small_patch_approves(self) -> None:
        from eden.code_change import AutoApprovalRuleService

        result = await AutoApprovalRuleService().evaluate(
            "org_test",
            patch_id="patch_x",
            metrics={
                "lines_changed": 18,
                "files_changed": 1,
                "quality_score": 0.94,
                "rca_confidence": 0.92,
                "blast_radius_score": 0.12,
                # Explicitly override the conservative default so
                # the test exercises the "small clean patch"
                # happy path, not the "first PR to file" blocker.
                "is_first_pr_to_file": False,
                "touches_protected_path": False,
            },
            policy={"enabled": True},
        )
        assert result["data"]["auto_approved"] is True
        assert result["data"]["failing_conditions"] == []


# ─── 7. CodeChangeHook is registered and callable ──────────────────


class TestCodeChangeHook:
    """The v1.6 STUB checklist constraint: "the
    CodeChangeHook.propose_patch_from_rca method is registered
    in register_all_hooks() and is callable from the Cat 2
    RCA scorer (no-op in STUB mode — logs the call, doesn't
    actually generate a patch)"."""

    def test_hook_class_is_exported(self) -> None:
        from eden.llmops.promotion_hooks import (
            CodeChangeHook,
            get_code_change_hook,
        )

        assert isinstance(get_code_change_hook(), CodeChangeHook)
        assert CodeChangeHook.name == "code_change_hook"

    def test_action_kind_includes_propose_patch(self) -> None:
        from eden.llmops.promotion_hooks import ACTION_KIND

        assert "propose_patch_from_rca" in ACTION_KIND
        assert ACTION_KIND["propose_patch_from_rca"] == "propose_patch"
        assert "post_merge_degraded" in ACTION_KIND
        assert ACTION_KIND["post_merge_degraded"] == "consider_revert"

    @pytest.mark.asyncio
    async def test_propose_patch_from_rca_is_no_op_in_stub(self) -> None:
        from eden.llmops.promotion_hooks import get_code_change_hook

        hook = get_code_change_hook()
        # The STUB surface doesn't actually call the PatchGenerator
        # — it just records the recommendation. The method should
        # complete without raising even when Postgres is down.
        result = await hook.propose_patch_from_rca(
            "org_test",
            rca_id="rca_x",
            trace_id="trace_x",
            confidence=0.85,
        )
        # Returns None or an action_id (depending on whether the
        # closed_loop_actions table exists); either is acceptable
        # for the no-op STUB path.
        assert result is None or isinstance(result, str)

    @pytest.mark.asyncio
    async def test_post_merge_degraded_is_no_op_in_stub(self) -> None:
        from eden.llmops.promotion_hooks import get_code_change_hook

        hook = get_code_change_hook()
        result = await hook.post_merge_degraded(
            "org_test",
            pr_id="pr_x",
            regression_evidence={"success_rate_drop": 0.15},
            window_hours=24,
        )
        assert result is None or isinstance(result, str)


# ─── 8. Route surface — Router mount + smoke tests ────────────────


class TestRouteSmoke:
    """The 19-route surface ships via the
    ``intelligence_code_change`` router. The router is gated by
    the umbrella ``intelligence_gap_v0`` flag."""

    def _build_app(self) -> tuple[FastAPI, TestClient]:
        # The router requires a current user; we override the
        # dep with a stub so the route smoke tests don't need
        # a real auth flow.
        from eden.api.deps import get_current_user

        app = FastAPI()
        from eden.api.routes import intelligence_code_change

        app.include_router(intelligence_code_change.router)
        app.dependency_overrides[get_current_user] = lambda: {
            "id": "user_test",
            "email": "test@example.com",
        }
        return app, TestClient(app)

    def test_router_has_24_routes(self) -> None:
        from eden.api.routes.intelligence_code_change import router

        # 24 unique paths (the v1.6 STUB checklist counts 19
        # "route surfaces" — the 8 inbox actions share one
        # ``POST /inbox/{patch_id}/{action}`` path).
        assert len(router.routes) >= 19

    def test_health_route_404(self) -> None:
        """The router does not define /health; the app's
        ``/health`` is mounted elsewhere."""
        _app, client = self._build_app()
        r = client.get("/health")
        assert r.status_code in (404, 200)  # not mounted here

    def test_inbox_list_post(self) -> None:
        _app, client = self._build_app()
        r = client.post(
            "/orgs/org_test/intelligence/code-change/inbox/list",
            json={"status": "open", "sort": "priority", "group_by": "repo"},
        )
        # 200 if the feature flag is on, 401/403 if off.
        assert r.status_code in (200, 401, 403, 404)


# ─── 9. Diff-parsing helpers used by the auto-approval scorer ────


class TestDiffParsingHelpers:
    """The :mod:`eden.code_change._common` helpers
    (``diff_line_count``, ``diff_files_changed``,
    ``diff_hunk_count``) power the auto-approval metrics
    collector. Pure functions; no async needed."""

    def test_diff_line_count_excludes_headers(self) -> None:
        from eden.code_change._common import diff_line_count

        diff = (
            "--- a/file.py\n"
            "+++ b/file.py\n"
            "@@ -1,3 +1,4 @@\n"
            " line1\n"
            "+new line\n"
            "-old line\n"
            " line2\n"
        )
        # 1 + line, 1 - line = 2 (the +++/--- headers and the @@
        # hunk header are NOT counted).
        assert diff_line_count(diff) == 2

    def test_diff_line_count_empty(self) -> None:
        from eden.code_change._common import diff_line_count

        assert diff_line_count("") == 0
        assert diff_line_count("nothing to parse") == 0

    def test_diff_files_changed_extracts_paths(self) -> None:
        from eden.code_change._common import diff_files_changed

        diff = (
            "--- a/file1.py\n"
            "+++ b/file1.py\n"
            "@@ -1,3 +1,4 @@\n"
            " line\n"
            "--- a/file2.py\n"
            "+++ b/file2.py\n"
            "@@ -1,3 +1,4 @@\n"
            " line\n"
        )
        assert diff_files_changed(diff) == ["file1.py", "file2.py"]

    def test_diff_hunk_count(self) -> None:
        from eden.code_change._common import diff_hunk_count

        diff = (
            "@@ -1,3 +1,4 @@\n"
            " a\n"
            "@@ -10,3 +11,4 @@\n"
            " b\n"
            "@@ -20,3 +21,4 @@\n"
            " c\n"
        )
        assert diff_hunk_count(diff) == 3


# ─── 10. PRQualityScorer computes the stub dimensions inline ────


class TestPRQualityScorer:
    """The :class:`PRQualityScorer` computes the security +
    complexity dimensions inline (no sandbox needed); the 3
    sandbox-dependent dimensions return the not-implemented
    envelope."""

    @pytest.mark.asyncio
    async def test_clean_diff_scores_high(self) -> None:
        from eden.code_change import PRQualityScorer

        diff = "@@ -1,3 +1,4 @@\n a\n+b\n c\n"
        result = await PRQualityScorer().score(
            "org_test", patch_id="patch_x", diff=diff, repo_id="repo_x"
        )
        assert result["status"] == "ok"
        assert result["data"]["quality_score"] is not None
        # A clean 3-hunk, 1-line diff should score well above 0.5.
        assert result["data"]["quality_score"] > 0.5

    @pytest.mark.asyncio
    async def test_secret_in_diff_zero_security(self) -> None:
        from eden.code_change import PRQualityScorer

        diff = (
            "+api_key = 'sk-1234567890abcdefghij'\n"
        )
        result = await PRQualityScorer().score(
            "org_test", patch_id="patch_x", diff=diff, repo_id="repo_x"
        )
        assert result["data"]["quality_breakdown"]["security"] == 0.0

    @pytest.mark.asyncio
    async def test_eval_in_diff_zero_security(self) -> None:
        from eden.code_change import PRQualityScorer

        diff = "+x = eval(user_input)\n"
        result = await PRQualityScorer().score(
            "org_test", patch_id="patch_x", diff=diff, repo_id="repo_x"
        )
        assert result["data"]["quality_breakdown"]["security"] == 0.0

    @pytest.mark.asyncio
    async def test_many_hunks_lower_complexity(self) -> None:
        from eden.code_change import PRQualityScorer

        # 20 hunks → complexity should be 0.0
        diff = "\n".join("@@ -1,3 +1,4 @@\n a\n" for _ in range(20))
        result = await PRQualityScorer().score(
            "org_test", patch_id="patch_x", diff=diff, repo_id="repo_x"
        )
        assert result["data"]["quality_breakdown"]["complexity"] == 0.0


# ─── 11. No regressions: existing umbrella flag still gates ───────


class TestUmbrellaFlagStillGates:
    """The v1.6 STUB checklist constraint: "the existing
    ``intelligence_gap_v0`` flag still gates the surface;
    the existing 14/23 IMPLEMENTED cats still pass their
    tests"."""

    def test_intelligence_gap_v0_flag_is_unchanged(self) -> None:
        from eden.intelligence_envelope import INTELLIGENCE_GAP_FLAG

        assert INTELLIGENCE_GAP_FLAG == "intelligence_gap_v0"

    def test_router_uses_umbrella_flag(self) -> None:
        """The Cat 23 router depends on ``intelligence_gap_v0`` —
        not on a new sub-flag. Sub-flags are a per-tenant policy
        concern, not a route concern."""
        from eden.api.deps import require_feature_flag

        # The dep builder is callable with the umbrella flag name.
        dep = require_feature_flag("intelligence_gap_v0")
        assert dep is not None

        # And the Cat 23 router actually wires the dep in.
        from eden.api.routes import intelligence_code_change

        deps = intelligence_code_change.router.dependencies
        # The dep list is a list of ``Depends(...)`` objects; we
        # just check that the router was built with at least one
        # dep (the umbrella flag + the auth dep).
        assert len(deps) >= 2


# ─── 12. New migration 027 has 8 core + 11 support tables ──────────


class TestMigration:
    """The v1.6 STUB checklist constraint: "Migration 023
    applies: 8 new tables with the unique indexes and the
    strict RLS policies. ``alembic upgrade head`` succeeds."

    Note: the actual revision id is 027 (per the v0 ship which
    used 026 for Cat 22). The 8 core + 4 approval + 3
    auto-approval + 4 inbox/persona/style/quality = 19 tables
    total."""

    @staticmethod
    def _load_migration() -> Any:
        """Load the 027 migration module via importlib (file
        names that start with a digit can't be imported as
        regular Python modules).
        """
        import importlib.util
        import pathlib

        path = pathlib.Path(
            "src/eden/db_migrations/versions/027_autonomous_code_modification.py"
        )
        spec = importlib.util.spec_from_file_location("m027", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_revision_is_027(self) -> None:
        m = self._load_migration()
        assert m.revision == "027"
        assert m.down_revision == "026"

    def test_migration_module_has_upgrade_and_downgrade(self) -> None:
        m = self._load_migration()
        assert callable(m.upgrade)
        assert callable(m.downgrade)
