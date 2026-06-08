"""Eden CLI — Review gate commands."""

from __future__ import annotations

import asyncio
from typing import Any

import click

from eden.cli.main import cli, echo_json, echo_table
from eden.evaluation.review_gate import ReviewGate, RiskClassifier, EnvironmentDiff, RiskLevel


@cli.group(name="review")
def review() -> None:
    """Review gate and approval workflow commands."""


@review.command(name="assess")
@click.option("--environment-id", required=True, help="Environment being changed")
@click.option("--old-version", required=True, help="Baseline version")
@click.option("--new-version", required=True, help="Candidate version")
@click.option("--lines-changed", default=0, type=int, help="Lines changed")
@click.option("--new-deps", help="Comma-separated new dependencies")
@click.option("--changes-auth", is_flag=True, help="Authentication logic changed")
@click.option("--changes-payment", is_flag=True, help="Payment logic changed")
@click.option("--adds-network", is_flag=True, help="New network access added")
@click.option("--changes-sandbox", is_flag=True, help="Sandbox config changed")
@click.option("--changes-reward", is_flag=True, help="Reward function changed")
@click.option("--changes-obs", is_flag=True, help="Observation space changed")
@click.option("--coverage-delta", default=0.0, type=float, help="Test coverage change (%)")
@click.pass_context
def review_assess(
    ctx: click.Context,
    environment_id: str,
    old_version: str,
    new_version: str,
    lines_changed: int,
    new_deps: str,
    changes_auth: bool,
    changes_payment: bool,
    adds_network: bool,
    changes_sandbox: bool,
    changes_reward: bool,
    changes_obs: bool,
    coverage_delta: float,
) -> None:
    """Assess an environment change and determine review requirements."""
    gate = ReviewGate()

    diff = EnvironmentDiff(
        environment_id=environment_id,
        old_version=old_version,
        new_version=new_version,
        lines_changed=lines_changed,
        new_dependencies=[d.strip() for d in new_deps.split(",")] if new_deps else [],
        modified_tools=[],
        changes_auth_logic=changes_auth,
        changes_payment_logic=changes_payment,
        adds_network_access=adds_network,
        changes_sandbox_config=changes_sandbox,
        changes_reward_function=changes_reward,
        changes_observation_space=changes_obs,
        test_coverage_delta=coverage_delta,
    )

    decision = gate.assess(diff)

    click.echo(f"Environment: {decision.environment_id}")
    click.echo(f"Risk Level: {decision.risk_level.value.upper()}")
    click.echo(f"Decision: {decision.decision}")
    click.echo(f"Required Approvals: {decision.required_approvals}")
    click.echo(f"Auto-approved: {decision.auto_approved}")

    # Show detailed risk explanation
    classifier = RiskClassifier()
    explanation = classifier.explain(diff)
    click.echo(f"\nRisk Score: {explanation['total_score']}")
    click.echo(f"Recommendation: {explanation['recommendation']}")

    if ctx.obj.get("format") == "json":
        echo_json({
            "decision": decision.to_dict(),
            "explanation": explanation,
        })


@review.command(name="approve")
@click.option("--environment-id", required=True, help="Environment to approve")
@click.option("--reviewer", required=True, help="Reviewer identifier")
@click.option("--notes", default="", help="Approval notes")
@click.pass_context
def review_approve(ctx: click.Context, environment_id: str, reviewer: str, notes: str) -> None:
    """Approve an environment change."""
    gate = ReviewGate()

    try:
        decision = gate.approve(environment_id, reviewer, notes)
        click.echo(f"Approved {environment_id} by {reviewer}")
        click.echo(f"Status: {decision.decision}")
        click.echo(f"Approvals: {decision.current_approvals}/{decision.required_approvals}")

        if ctx.obj.get("format") == "json":
            echo_json(decision.to_dict())
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)


@review.command(name="reject")
@click.option("--environment-id", required=True, help="Environment to reject")
@click.option("--reviewer", required=True, help="Reviewer identifier")
@click.option("--reason", required=True, help="Rejection reason")
@click.pass_context
def review_reject(ctx: click.Context, environment_id: str, reviewer: str, reason: str) -> None:
    """Reject an environment change."""
    gate = ReviewGate()

    try:
        decision = gate.reject(environment_id, reviewer, reason)
        click.echo(f"Rejected {environment_id} by {reviewer}")
        click.echo(f"Reason: {reason}")

        if ctx.obj.get("format") == "json":
            echo_json(decision.to_dict())
    except ValueError as e:
        click.echo(f"Error: {e}", err=True)


@review.command(name="pending")
@click.pass_context
def review_pending(ctx: click.Context) -> None:
    """List all pending reviews."""
    gate = ReviewGate()
    pending = gate.list_pending()

    if not pending:
        click.echo("No pending reviews.")
        return

    click.echo(f"Pending Reviews ({len(pending)}):")

    if ctx.obj.get("format") == "json":
        echo_json([d.to_dict() for d in pending])
    else:
        headers = ["Environment", "Risk", "Required", "Current", "Reviewers"]
        rows = [
            [d.environment_id, d.risk_level.value, str(d.required_approvals), str(d.current_approvals), ", ".join(d.reviewers)]
            for d in pending
        ]
        echo_table(headers, rows)
