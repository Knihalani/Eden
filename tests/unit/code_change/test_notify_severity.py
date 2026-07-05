"""Unit tests for Phase 3b severity-aware PRReviewerNotifier.

Verifies:

- _normalize_severity coerces synonyms + falls back to medium
- _apply_opt_outs respects per-org channel policy + keeps inbox on
- notify_pr_opened routes per severity table
- notify_revert defaults to high severity
- route_for_patch is a pure verdict helper
"""
from __future__ import annotations

import pytest

# ── _normalize_severity ─────────────────────────────────────────────


class TestNormalizeSeverity:
    def test_known_keys_pass_through(self):
        from eden.code_change.notify import _normalize_severity
        for sev in ("low", "medium", "high", "critical"):
            assert _normalize_severity(sev) == sev

    def test_uppercase_normalised(self):
        from eden.code_change.notify import _normalize_severity
        assert _normalize_severity("HIGH") == "high"

    def test_aliases(self):
        from eden.code_change.notify import _normalize_severity
        assert _normalize_severity("warn") == "low"
        assert _normalize_severity("warning") == "low"
        assert _normalize_severity("info") == "low"
        assert _normalize_severity("major") == "high"
        assert _normalize_severity("error") == "high"
        assert _normalize_severity("fatal") == "critical"
        assert _normalize_severity("blocker") == "critical"

    def test_unknown_defaults_to_medium(self):
        from eden.code_change.notify import _normalize_severity
        assert _normalize_severity("garbage") == "medium"

    def test_none_defaults_to_medium(self):
        from eden.code_change.notify import _normalize_severity
        assert _normalize_severity(None) == "medium"

    def test_blank_defaults_to_medium(self):
        from eden.code_change.notify import _normalize_severity
        assert _normalize_severity("") == "medium"


# ── _apply_opt_outs ─────────────────────────────────────────────────


class TestApplyOptOuts:
    def test_no_policy_keeps_all_channels(self):
        from eden.code_change.notify import _apply_opt_outs
        result = _apply_opt_outs(
            ("inbox", "email", "slack"), notify_channels=None,
        )
        assert result == ("inbox", "email", "slack")

    def test_email_opted_out(self):
        from eden.code_change.notify import _apply_opt_outs
        result = _apply_opt_outs(
            ("inbox", "email", "slack"),
            notify_channels={"email": False, "slack": True},
        )
        assert result == ("inbox", "slack")

    def test_inbox_cannot_be_disabled(self):
        from eden.code_change.notify import _apply_opt_outs
        # Even with inbox=False in the policy, inbox stays on.
        result = _apply_opt_outs(
            ("inbox", "email"),
            notify_channels={"inbox": False, "email": False},
        )
        assert "inbox" in result
        assert "email" not in result

    def test_missing_key_defaults_to_enabled(self):
        from eden.code_change.notify import _apply_opt_outs
        # Slack not mentioned in policy → enabled by default.
        result = _apply_opt_outs(
            ("inbox", "slack"),
            notify_channels={"email": False},
        )
        assert result == ("inbox", "slack")


# ── Routing table ──────────────────────────────────────────────────


class TestSeverityRoutes:
    def test_low_routes_inbox_only(self):
        from eden.code_change.notify import _SEVERITY_ROUTES
        assert _SEVERITY_ROUTES["low"] == ("inbox",)

    def test_medium_includes_digest(self):
        from eden.code_change.notify import _SEVERITY_ROUTES
        assert "digest" in _SEVERITY_ROUTES["medium"]

    def test_high_includes_email(self):
        from eden.code_change.notify import _SEVERITY_ROUTES
        assert "email" in _SEVERITY_ROUTES["high"]

    def test_critical_includes_slack(self):
        from eden.code_change.notify import _SEVERITY_ROUTES
        assert "slack" in _SEVERITY_ROUTES["critical"]

    def test_inbox_always_in_every_route(self):
        from eden.code_change.notify import _SEVERITY_ROUTES
        for sev, channels in _SEVERITY_ROUTES.items():
            assert "inbox" in channels, (
                f"severity {sev} must include inbox"
            )


# ── PRReviewerNotifier.notify_pr_opened ─────────────────────────────


class TestNotifyPrOpened:
    @pytest.mark.asyncio
    async def test_low_severity_returns_inbox_only(self):
        from eden.code_change.notify import PRReviewerNotifier

        n = PRReviewerNotifier()
        result = await n.notify_pr_opened(
            "org_test", "pr_1", "rca_x",
            test_pass_rate=0.95,
            blast_radius_score=0.3,
            estimated_cost_savings_usd=10.0,
            severity="low",
        )
        assert result["data"]["severity"] == "low"
        assert result["data"]["channels"] == ["inbox"]

    @pytest.mark.asyncio
    async def test_high_severity_includes_email(self):
        from eden.code_change.notify import PRReviewerNotifier

        n = PRReviewerNotifier()
        result = await n.notify_pr_opened(
            "org_test", "pr_1", "rca_x",
            test_pass_rate=0.95,
            blast_radius_score=0.3,
            estimated_cost_savings_usd=10.0,
            severity="high",
        )
        assert result["data"]["severity"] == "high"
        assert "email" in result["data"]["channels"]
        assert "inbox" in result["data"]["channels"]

    @pytest.mark.asyncio
    async def test_critical_includes_slack(self):
        from eden.code_change.notify import PRReviewerNotifier

        n = PRReviewerNotifier()
        result = await n.notify_pr_opened(
            "org_test", "pr_1", "rca_x",
            test_pass_rate=0.95,
            blast_radius_score=0.5,
            estimated_cost_savings_usd=10.0,
            severity="critical",
        )
        assert "slack" in result["data"]["channels"]

    @pytest.mark.asyncio
    async def test_email_opt_out_respected(self):
        from eden.code_change.notify import PRReviewerNotifier

        n = PRReviewerNotifier()
        result = await n.notify_pr_opened(
            "org_test", "pr_1", "rca_x",
            test_pass_rate=0.95,
            blast_radius_score=0.3,
            estimated_cost_savings_usd=10.0,
            severity="high",
            notify_channels={"email": False, "slack": False},
        )
        assert "email" not in result["data"]["channels"]
        # Inbox is always kept on.
        assert "inbox" in result["data"]["channels"]


class TestNotifyRevert:
    @pytest.mark.asyncio
    async def test_default_severity_is_high(self):
        from eden.code_change.notify import PRReviewerNotifier

        n = PRReviewerNotifier()
        result = await n.notify_revert(
            "org_test", "pr_1", revert_reason="regression",
        )
        assert result["data"]["severity"] == "high"
        assert "email" in result["data"]["channels"]


class TestRouteForPatch:
    @pytest.mark.asyncio
    async def test_returns_resolved_verdict(self):
        from eden.code_change.notify import PRReviewerNotifier

        n = PRReviewerNotifier()
        result = await n.route_for_patch(
            "org_test", "patch_1", severity="critical",
        )
        assert result["data"]["severity"] == "critical"
        assert result["data"]["send_slack"] is True
        assert result["data"]["send_email"] is True
        assert result["data"]["in_digest"] is True

    @pytest.mark.asyncio
    async def test_low_severity_no_slack_no_email(self):
        from eden.code_change.notify import PRReviewerNotifier

        n = PRReviewerNotifier()
        result = await n.route_for_patch(
            "org_test", "patch_1", severity="low",
        )
        assert result["data"]["send_slack"] is False
        assert result["data"]["send_email"] is False
        assert result["data"]["in_digest"] is False
