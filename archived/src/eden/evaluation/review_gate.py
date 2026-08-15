"""Review gate system — risk-based routing and approval workflows for environment changes.

Not all changes require human review. Eden uses a risk classifier to determine
the review path: HIGH → mandatory human review, MEDIUM → AI pre-review + spot
check, LOW → auto-approve if tests pass.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class RiskLevel(StrEnum):
    """Risk classification levels for environment changes."""

    LOW = "low"          # Auto-approve if tests pass
    MEDIUM = "medium"    # AI pre-review + human spot check
    HIGH = "high"        # Mandatory human review


@dataclass
class EnvironmentDiff:
    """Represents changes between two environment versions.

    Attributes:
        environment_id: The environment being changed.
        old_version: Baseline version.
        new_version: Candidate version.
        lines_changed: Total lines added + removed.
        new_dependencies: New packages/imports added.
        modified_tools: Tools whose behavior changed.
        changes_auth_logic: Whether authentication logic changed.
        changes_payment_logic: Whether payment/billing logic changed.
        adds_network_access: Whether new network access was added.
        changes_sandbox_config: Whether sandbox configuration changed.
        changes_reward_function: Whether reward function changed.
        changes_observation_space: Whether observation space changed.
        test_coverage_delta: Change in test coverage percentage.
    """

    environment_id: str
    old_version: str
    new_version: str
    lines_changed: int = 0
    new_dependencies: list[str] = field(default_factory=list)
    modified_tools: list[str] = field(default_factory=list)
    changes_auth_logic: bool = False
    changes_payment_logic: bool = False
    adds_network_access: bool = False
    changes_sandbox_config: bool = False
    changes_reward_function: bool = False
    changes_observation_space: bool = False
    test_coverage_delta: float = 0.0

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EnvironmentDiff:
        return cls(
            environment_id=data["environment_id"],
            old_version=data["old_version"],
            new_version=data["new_version"],
            lines_changed=data.get("lines_changed", 0),
            new_dependencies=data.get("new_dependencies", []),
            modified_tools=data.get("modified_tools", []),
            changes_auth_logic=data.get("changes_auth_logic", False),
            changes_payment_logic=data.get("changes_payment_logic", False),
            adds_network_access=data.get("adds_network_access", False),
            changes_sandbox_config=data.get("changes_sandbox_config", False),
            changes_reward_function=data.get("changes_reward_function", False),
            changes_observation_space=data.get("changes_observation_space", False),
            test_coverage_delta=data.get("test_coverage_delta", 0.0),
        )


@dataclass
class ReviewDecision:
    """Decision from a review gate.

    Attributes:
        environment_id: The environment being reviewed.
        risk_level: Assessed risk level.
        decision: "approve", "reject", or "requires_human_review".
        reason: Human-readable explanation.
        required_approvals: Number of approvals needed.
        current_approvals: Current approval count.
        reviewers: List of assigned reviewers.
        auto_approved: Whether the decision was auto-approved.
        timestamp: ISO timestamp.
    """

    environment_id: str
    risk_level: RiskLevel
    decision: str
    reason: str
    required_approvals: int = 0
    current_approvals: int = 0
    reviewers: list[str] = field(default_factory=list)
    auto_approved: bool = False
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_dict(self) -> dict[str, Any]:
        return {
            "environment_id": self.environment_id,
            "risk_level": self.risk_level.value,
            "decision": self.decision,
            "reason": self.reason,
            "required_approvals": self.required_approvals,
            "current_approvals": self.current_approvals,
            "reviewers": self.reviewers,
            "auto_approved": self.auto_approved,
            "timestamp": self.timestamp,
        }


class RiskClassifier:
    """Classifies environment changes by risk level.

    Uses a weighted scoring system:
      - Critical factors: auth logic, payment logic, sandbox changes
      - Moderate factors: new dependencies, modified tools, lines changed
      - Minor factors: test coverage delta, documentation changes

    Score >= 100 → HIGH
    Score >= 50  → MEDIUM
    Score < 50   → LOW
    """

    # Critical factor weights
    WEIGHT_AUTH_LOGIC = 100
    WEIGHT_PAYMENT_LOGIC = 100
    WEIGHT_NETWORK_ACCESS = 50
    WEIGHT_SANDBOX_CONFIG = 30
    WEIGHT_REWARD_FUNCTION = 40
    WEIGHT_OBSERVATION_SPACE = 25

    # Moderate factor weights
    WEIGHT_NEW_DEPENDENCY = 10
    WEIGHT_MODIFIED_TOOL = 5
    WEIGHT_LINES_CHANGED = 0.1

    # Coverage threshold
    MIN_COVERAGE_DELTA = -5.0  # % drop that triggers medium risk

    def classify(self, diff: EnvironmentDiff) -> RiskLevel:
        """Classify an environment diff by risk level.

        Args:
            diff: The environment change to classify.

        Returns:
            RiskLevel: LOW, MEDIUM, or HIGH.
        """
        score = 0
        reasons = []

        # Critical factors
        if diff.changes_auth_logic:
            score += self.WEIGHT_AUTH_LOGIC
            reasons.append("authentication logic changed")

        if diff.changes_payment_logic:
            score += self.WEIGHT_PAYMENT_LOGIC
            reasons.append("payment/billing logic changed")

        if diff.adds_network_access:
            score += self.WEIGHT_NETWORK_ACCESS
            reasons.append("new network access added")

        if diff.changes_sandbox_config:
            score += self.WEIGHT_SANDBOX_CONFIG
            reasons.append("sandbox configuration changed")

        if diff.changes_reward_function:
            score += self.WEIGHT_REWARD_FUNCTION
            reasons.append("reward function changed")

        if diff.changes_observation_space:
            score += self.WEIGHT_OBSERVATION_SPACE
            reasons.append("observation space changed")

        # Moderate factors
        dep_score = len(diff.new_dependencies) * self.WEIGHT_NEW_DEPENDENCY
        if dep_score > 0:
            score += dep_score
            reasons.append(f"{len(diff.new_dependencies)} new dependencies")

        tool_score = len(diff.modified_tools) * self.WEIGHT_MODIFIED_TOOL
        if tool_score > 0:
            score += tool_score
            reasons.append(f"{len(diff.modified_tools)} tools modified")

        line_score = diff.lines_changed * self.WEIGHT_LINES_CHANGED
        if line_score > 0:
            score += line_score
            reasons.append(f"{diff.lines_changed} lines changed")

        # Test coverage drop
        if diff.test_coverage_delta < self.MIN_COVERAGE_DELTA:
            score += 20
            reasons.append(f"test coverage dropped by {abs(diff.test_coverage_delta):.1f}%")

        # Determine risk level
        if score >= 100:
            risk = RiskLevel.HIGH
        elif score >= 50:
            risk = RiskLevel.MEDIUM
        else:
            risk = RiskLevel.LOW

        logger.info(
            f"Risk classification for {diff.environment_id}: {risk.value} "
            f"(score={score}, reasons={reasons})"
        )

        return risk

    def explain(self, diff: EnvironmentDiff) -> dict[str, Any]:
        """Provide detailed explanation of risk classification.

        Returns:
            Dict with score breakdown and reasoning.
        """
        score = 0
        breakdown = []

        checks = [
            ("changes_auth_logic", self.WEIGHT_AUTH_LOGIC, "Authentication logic changed"),
            ("changes_payment_logic", self.WEIGHT_PAYMENT_LOGIC, "Payment logic changed"),
            ("adds_network_access", self.WEIGHT_NETWORK_ACCESS, "New network access"),
            ("changes_sandbox_config", self.WEIGHT_SANDBOX_CONFIG, "Sandbox config changed"),
            ("changes_reward_function", self.WEIGHT_REWARD_FUNCTION, "Reward function changed"),
            ("changes_observation_space", self.WEIGHT_OBSERVATION_SPACE, "Observation space changed"),
        ]

        for attr, weight, description in checks:
            if getattr(diff, attr):
                score += weight
                breakdown.append({"factor": description, "weight": weight})

        if diff.new_dependencies:
            dep_score = len(diff.new_dependencies) * self.WEIGHT_NEW_DEPENDENCY
            score += dep_score
            breakdown.append({"factor": f"New dependencies ({len(diff.new_dependencies)})", "weight": dep_score})

        if diff.modified_tools:
            tool_score = len(diff.modified_tools) * self.WEIGHT_MODIFIED_TOOL
            score += tool_score
            breakdown.append({"factor": f"Modified tools ({len(diff.modified_tools)})", "weight": tool_score})

        if diff.lines_changed > 0:
            line_score = diff.lines_changed * self.WEIGHT_LINES_CHANGED
            score += line_score
            breakdown.append({"factor": f"Lines changed ({diff.lines_changed})", "weight": round(line_score, 1)})

        if diff.test_coverage_delta < self.MIN_COVERAGE_DELTA:
            score += 20
            breakdown.append({
                "factor": f"Coverage drop ({diff.test_coverage_delta:.1f}%)",
                "weight": 20,
            })

        risk = self.classify(diff)

        return {
            "environment_id": diff.environment_id,
            "risk_level": risk.value,
            "total_score": score,
            "thresholds": {"high": 100, "medium": 50, "low": 0},
            "breakdown": breakdown,
            "recommendation": self._recommendation(risk),
        }

    def _recommendation(self, risk: RiskLevel) -> str:
        """Get recommendation text for a risk level."""
        recommendations = {
            RiskLevel.LOW: "Auto-approve if all CI checks pass. No human review required.",
            RiskLevel.MEDIUM: "AI pre-review required. Human spot-check recommended.",
            RiskLevel.HIGH: "Mandatory human review. At least 2 approvals required.",
        }
        return recommendations[risk]


class ReviewGate:
    """Manages the review gate workflow for environment deployments.

    Workflow:
        Environment Generated
               |
               v
        +--------------+
        | Risk Assess  |--HIGH----> Human Review Queue (2+ approvals)
        |  (auto)      |--MEDIUM--> AI Review -> Human Spot Check (1 approval)
        +--------------+--LOW-----> Auto-approve (0 approvals, tests pass)
               |
               v
        +--------------+
        | Approved?    |--YES--> Proceed to canary
        |              |--NO---> Reject with feedback
        +--------------+
    """

    # Approval requirements by risk level
    REQUIRED_APPROVALS = {
        RiskLevel.LOW: 0,
        RiskLevel.MEDIUM: 1,
        RiskLevel.HIGH: 2,
    }

    def __init__(
        self,
        classifier: RiskClassifier | None = None,
        state_dir: Path | None = None,
    ):
        """Initialize review gate.

        Args:
            classifier: RiskClassifier instance.
            state_dir: Directory for persisting review state.
        """
        self._classifier = classifier or RiskClassifier()
        self._state_dir = state_dir or Path("./.eden/review_gates")
        self._state_dir.mkdir(parents=True, exist_ok=True)

    def assess(
        self,
        diff: EnvironmentDiff,
        test_results: dict[str, Any] | None = None,
    ) -> ReviewDecision:
        """Assess an environment change and determine review path.

        Args:
            diff: The environment change to assess.
            test_results: Optional CI test results to inform decision.

        Returns:
            ReviewDecision with risk level and required actions.
        """
        risk = self._classifier.classify(diff)
        required = self.REQUIRED_APPROVALS[risk]

        # Auto-approve low-risk changes that pass tests
        if risk == RiskLevel.LOW:
            tests_passed = test_results is None or test_results.get("overall_status") == "passed"
            if tests_passed:
                decision = ReviewDecision(
                    environment_id=diff.environment_id,
                    risk_level=risk,
                    decision="approve",
                    reason="Low risk change with passing tests. Auto-approved.",
                    required_approvals=0,
                    current_approvals=0,
                    auto_approved=True,
                )
                self._persist_decision(decision)
                logger.info(f"Auto-approved {diff.environment_id}: low risk, tests pass")
                return decision

        # Build decision
        if risk == RiskLevel.HIGH:
            decision_text = "requires_human_review"
            explanation = self._classifier.explain(diff)
            breakdown = "; ".join(
                f"{b['factor']} (+{b['weight']})" for b in explanation.get("breakdown", [])
            )
            reason = f"High risk change: {breakdown or 'multiple critical factors'}"
        elif risk == RiskLevel.MEDIUM:
            decision_text = "requires_human_review"
            reason = "Medium risk change: AI pre-review and human spot-check required."
        else:
            decision_text = "approve"
            reason = "Low risk change approved."

        decision = ReviewDecision(
            environment_id=diff.environment_id,
            risk_level=risk,
            decision=decision_text,
            reason=reason,
            required_approvals=required,
            current_approvals=0,
            auto_approved=False,
        )

        self._persist_decision(decision)
        logger.info(f"Review gate for {diff.environment_id}: {decision.decision} ({risk.value})")
        return decision

    def approve(
        self,
        environment_id: str,
        reviewer: str,
        notes: str = "",
    ) -> ReviewDecision:
        """Record an approval for an environment change.

        Args:
            environment_id: The environment being approved.
            reviewer: Identifier of the reviewer.
            notes: Optional approval notes.

        Returns:
            Updated ReviewDecision.
        """
        decision = self._load_decision(environment_id)
        if not decision:
            raise ValueError(f"No pending review for {environment_id}")

        if decision.decision == "approve":
            logger.warning(f"{environment_id} already approved")
            return decision

        decision.current_approvals += 1
        decision.reviewers.append(reviewer)

        # Check if enough approvals collected
        if decision.current_approvals >= decision.required_approvals:
            decision.decision = "approve"
            decision.reason += f" Approved by {reviewer}."
            logger.info(f"{environment_id} fully approved ({decision.current_approvals}/{decision.required_approvals})")
        else:
            decision.reason += f" Partial approval by {reviewer} ({decision.current_approvals}/{decision.required_approvals})."
            logger.info(f"{environment_id} partial approval ({decision.current_approvals}/{decision.required_approvals})")

        self._persist_decision(decision)
        return decision

    def reject(
        self,
        environment_id: str,
        reviewer: str,
        reason: str,
    ) -> ReviewDecision:
        """Record a rejection for an environment change.

        Args:
            environment_id: The environment being rejected.
            reviewer: Identifier of the reviewer.
            reason: Rejection reason.

        Returns:
            Updated ReviewDecision.
        """
        decision = self._load_decision(environment_id)
        if not decision:
            raise ValueError(f"No pending review for {environment_id}")

        decision.decision = "reject"
        decision.reason = f"Rejected by {reviewer}: {reason}"
        decision.reviewers.append(f"{reviewer} (rejected)")

        self._persist_decision(decision)
        logger.info(f"{environment_id} rejected by {reviewer}: {reason}")
        return decision

    def get_status(self, environment_id: str) -> ReviewDecision | None:
        """Get current review status for an environment."""
        return self._load_decision(environment_id)

    def list_pending(self) -> list[ReviewDecision]:
        """List all pending reviews."""
        pending = []
        for path in self._state_dir.glob("*.json"):
            try:
                data = json.loads(path.read_text())
                if data.get("decision") == "requires_human_review":
                    pending.append(ReviewDecision(
                        environment_id=data["environment_id"],
                        risk_level=RiskLevel(data["risk_level"]),
                        decision=data["decision"],
                        reason=data["reason"],
                        required_approvals=data.get("required_approvals", 0),
                        current_approvals=data.get("current_approvals", 0),
                        reviewers=data.get("reviewers", []),
                        auto_approved=data.get("auto_approved", False),
                        timestamp=data.get("timestamp", ""),
                    ))
            except Exception:
                continue
        return pending

    def _persist_decision(self, decision: ReviewDecision) -> None:
        """Persist a review decision to disk."""
        path = self._state_dir / f"{decision.environment_id}.json"
        path.write_text(json.dumps(decision.to_dict(), indent=2), encoding="utf-8")

    def _load_decision(self, environment_id: str) -> ReviewDecision | None:
        """Load a review decision from disk."""
        path = self._state_dir / f"{environment_id}.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return ReviewDecision(
            environment_id=data["environment_id"],
            risk_level=RiskLevel(data["risk_level"]),
            decision=data["decision"],
            reason=data["reason"],
            required_approvals=data.get("required_approvals", 0),
            current_approvals=data.get("current_approvals", 0),
            reviewers=data.get("reviewers", []),
            auto_approved=data.get("auto_approved", False),
            timestamp=data.get("timestamp", ""),
        )
