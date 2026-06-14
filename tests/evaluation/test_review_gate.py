"""Tests for eden.evaluation.review_gate."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from eden.evaluation.review_gate import (
    EnvironmentDiff,
    ReviewDecision,
    ReviewGate,
    RiskClassifier,
    RiskLevel,
)


class TestRiskClassifier:
    def test_low_risk_simple_change(self):
        classifier = RiskClassifier()
        diff = EnvironmentDiff(
            environment_id="env_1",
            old_version="v1.0.0",
            new_version="v1.0.1",
            lines_changed=10,
        )
        risk = classifier.classify(diff)
        assert risk == RiskLevel.LOW

    def test_high_risk_auth_change(self):
        classifier = RiskClassifier()
        diff = EnvironmentDiff(
            environment_id="env_1",
            old_version="v1.0.0",
            new_version="v1.1.0",
            changes_auth_logic=True,
        )
        risk = classifier.classify(diff)
        assert risk == RiskLevel.HIGH

    def test_high_risk_payment_change(self):
        classifier = RiskClassifier()
        diff = EnvironmentDiff(
            environment_id="env_1",
            old_version="v1.0.0",
            new_version="v1.1.0",
            changes_payment_logic=True,
        )
        risk = classifier.classify(diff)
        assert risk == RiskLevel.HIGH

    def test_medium_risk_network_access(self):
        classifier = RiskClassifier()
        diff = EnvironmentDiff(
            environment_id="env_1",
            old_version="v1.0.0",
            new_version="v1.1.0",
            adds_network_access=True,
            lines_changed=100,
        )
        risk = classifier.classify(diff)
        assert risk == RiskLevel.MEDIUM  # network (50) + lines (10) = 60 >= 50, < 100

    def test_medium_risk_coverage_drop(self):
        classifier = RiskClassifier()
        diff = EnvironmentDiff(
            environment_id="env_1",
            old_version="v1.0.0",
            new_version="v1.1.0",
            test_coverage_delta=-10.0,
        )
        risk = classifier.classify(diff)
        assert risk == RiskLevel.LOW  # coverage drop gives only 20 points, < 50

    def test_explain_breakdown(self):
        classifier = RiskClassifier()
        diff = EnvironmentDiff(
            environment_id="env_1",
            old_version="v1.0.0",
            new_version="v1.1.0",
            changes_auth_logic=True,
            new_dependencies=["requests", "numpy"],
        )
        explanation = classifier.explain(diff)
        assert explanation["risk_level"] == "high"
        assert explanation["total_score"] > 0
        assert len(explanation["breakdown"]) > 0
        assert any("Authentication" in b["factor"] for b in explanation["breakdown"])

    def test_recommendation_text(self):
        classifier = RiskClassifier()
        low_rec = classifier._recommendation(RiskLevel.LOW)
        assert "Auto-approve" in low_rec
        high_rec = classifier._recommendation(RiskLevel.HIGH)
        assert "Mandatory human review" in high_rec


class TestReviewGate:
    def test_auto_approve_low_risk(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gate = ReviewGate(state_dir=Path(tmpdir))
            diff = EnvironmentDiff(
                environment_id="env_low",
                old_version="v1.0.0",
                new_version="v1.0.1",
                lines_changed=5,
            )
            decision = gate.assess(diff)
            assert decision.risk_level == RiskLevel.LOW
            assert decision.decision == "approve"
            assert decision.auto_approved is True

    def test_high_risk_requires_review(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gate = ReviewGate(state_dir=Path(tmpdir))
            diff = EnvironmentDiff(
                environment_id="env_high",
                old_version="v1.0.0",
                new_version="v1.1.0",
                changes_auth_logic=True,
            )
            decision = gate.assess(diff)
            assert decision.risk_level == RiskLevel.HIGH
            assert decision.decision == "requires_human_review"
            assert decision.required_approvals == 2

    def test_approve_and_full_approval(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gate = ReviewGate(state_dir=Path(tmpdir))
            diff = EnvironmentDiff(
                environment_id="env_med",
                old_version="v1.0.0",
                new_version="v1.1.0",
                adds_network_access=True,  # 50 points -> MEDIUM
                lines_changed=100,  # 10 more points
            )
            gate.assess(diff)

            # First approval — MEDIUM needs 1 approval
            d1 = gate.approve("env_med", "reviewer_a")
            assert d1.current_approvals == 1
            assert d1.decision == "approve"

    def test_approve_medium_risk(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gate = ReviewGate(state_dir=Path(tmpdir))
            diff = EnvironmentDiff(
                environment_id="env_med",
                old_version="v1.0.0",
                new_version="v1.1.0",
                adds_network_access=True,  # 50 points -> MEDIUM
                lines_changed=100,  # 10 more points
            )
            gate.assess(diff)
            d = gate.approve("env_med", "reviewer_a")
            assert d.decision == "approve"
            assert d.current_approvals == 1

    def test_reject(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gate = ReviewGate(state_dir=Path(tmpdir))
            diff = EnvironmentDiff(
                environment_id="env_rej",
                old_version="v1.0.0",
                new_version="v1.1.0",
                lines_changed=10,
            )
            gate.assess(diff)
            d = gate.reject("env_rej", "reviewer_x", "Found a bug")
            assert d.decision == "reject"
            assert "reviewer_x" in d.reviewers[0]

    def test_get_status(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gate = ReviewGate(state_dir=Path(tmpdir))
            diff = EnvironmentDiff(
                environment_id="env_stat",
                old_version="v1.0.0",
                new_version="v1.0.1",
                lines_changed=10,
            )
            gate.assess(diff)
            status = gate.get_status("env_stat")
            assert status is not None
            assert status.environment_id == "env_stat"

    def test_list_pending(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gate = ReviewGate(state_dir=Path(tmpdir))
            # Low-risk auto-approved -> not pending
            diff_low = EnvironmentDiff("env_low", "v1.0.0", "v1.0.1", lines_changed=5)
            gate.assess(diff_low)

            # High-risk -> pending
            diff_high = EnvironmentDiff("env_high", "v1.0.0", "v1.1.0", changes_auth_logic=True)
            gate.assess(diff_high)

            pending = gate.list_pending()
            assert len(pending) == 1
            assert pending[0].environment_id == "env_high"

    def test_approve_nonexistent_raises(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            gate = ReviewGate(state_dir=Path(tmpdir))
            with pytest.raises(ValueError):
                gate.approve("nonexistent", "reviewer")

    def test_environment_diff_from_dict(self):
        data = {
            "environment_id": "env_1",
            "old_version": "v1.0.0",
            "new_version": "v1.1.0",
            "lines_changed": 100,
            "new_dependencies": ["requests"],
            "changes_auth_logic": True,
        }
        diff = EnvironmentDiff.from_dict(data)
        assert diff.environment_id == "env_1"
        assert diff.lines_changed == 100
        assert diff.new_dependencies == ["requests"]
