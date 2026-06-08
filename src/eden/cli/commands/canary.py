"""Eden CLI — Canary deployment commands."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import click

from eden.cli.main import cli, echo_json, echo_table
from eden.evaluation.canary import (
    CanaryDeployment,
    DeploymentConfig,
    DeploymentStrategy,
    RollbackController,
    RolloutStage,
)


@cli.group(name="canary")
def canary() -> None:
    """Canary deployment and progressive delivery commands."""


@canary.command(name="deploy")
@click.option("--environment-id", required=True, help="Environment to deploy")
@click.option("--current", required=True, help="Currently serving version")
@click.option("--candidate", required=True, help="New version to deploy")
@click.option("--strategy", type=click.Choice(["shadow", "canary", "ab_test", "blue_green"]), default="canary", help="Deployment strategy")
@click.option("--no-rollback", is_flag=True, help="Disable automatic rollback")
@click.option("--stage-percent", multiple=True, type=int, default=[1, 5, 25, 100], help="Traffic percentages per stage")
@click.option("--stage-duration", multiple=True, type=int, default=[10, 30, 60, 0], help="Duration minutes per stage")
@click.pass_context
def canary_deploy(
    ctx: click.Context,
    environment_id: str,
    current: str,
    candidate: str,
    strategy: str,
    no_rollback: bool,
    stage_percent: tuple,
    stage_duration: tuple,
) -> None:
    """Execute a canary deployment."""
    click.echo(f"Starting {strategy} deployment: {current} -> {candidate}")

    strategy_enum = DeploymentStrategy(strategy)

    # Build stages
    stages = []
    for pct, dur in zip(stage_percent, stage_duration):
        stages.append(RolloutStage(percentage=pct, duration_minutes=dur, metrics=["error_rate", "latency_p99"]))

    config = DeploymentConfig(
        strategy=strategy_enum,
        stages=stages,
        rollback=not no_rollback,
    )

    deployment = CanaryDeployment()

    async def _run() -> None:
        result = await deployment.deploy(
            environment_id=environment_id,
            current_version=current,
            candidate_version=candidate,
            config=config,
        )

        click.echo(f"\nDeployment: {result.status.upper()}")
        click.echo(f"Action: {result.action}")
        click.echo(f"Confidence: {result.confidence:.2%}")

        if result.failed_checks:
            click.echo(f"Failed checks: {', '.join(result.failed_checks)}")

        if ctx.obj.get("format") == "json":
            echo_json(result.to_dict())

    asyncio.run(_run())


@canary.command(name="rollback")
@click.option("--environment-id", required=True, help="Environment to roll back")
@click.option("--reason", default="manual rollback via CLI", help="Rollback reason")
@click.pass_context
def canary_rollback(ctx: click.Context, environment_id: str, reason: str) -> None:
    """Execute an emergency rollback."""
    click.echo(f"Emergency rollback for {environment_id}: {reason}")

    controller = RollbackController()

    async def _run() -> None:
        result = await controller.emergency_rollback(environment_id, reason)
        click.echo(f"Rolled back to: {result['rolled_back_to']}")
        click.echo(f"Verified: {result['verified']}")

        if ctx.obj.get("format") == "json":
            echo_json(result)

    asyncio.run(_run())


@canary.command(name="dry-run")
@click.option("--environment-id", required=True, help="Environment to evaluate")
@click.option("--current", required=True, help="Current version")
@click.option("--candidate", required=True, help="Candidate version")
@click.pass_context
def canary_dry_run(ctx: click.Context, environment_id: str, current: str, candidate: str) -> None:
    """Validate rollback capability before deployment."""
    controller = RollbackController()

    async def _run() -> None:
        result = await controller.dry_run(environment_id, current, candidate)
        click.echo(f"Rollback possible: {result['rollback_possible']}")
        click.echo(f"Recommendation: {result['recommendation']}")

        if ctx.obj.get("format") == "json":
            echo_json(result)

    asyncio.run(_run())


@canary.command(name="status")
@click.argument("deployment_id")
@click.pass_context
def canary_status(ctx: click.Context, deployment_id: str) -> None:
    """Get deployment status."""
    deployment = CanaryDeployment()
    state = deployment.get_deployment_state(deployment_id)

    if not state:
        click.echo(f"Deployment {deployment_id} not found", err=True)
        return

    click.echo(f"Deployment: {deployment_id}")
    click.echo(f"Environment: {state.get('environment_id')}")
    click.echo(f"Candidate: {state.get('candidate_version')}")
    click.echo(f"Strategy: {state.get('strategy')}")

    if ctx.obj.get("format") == "json":
        echo_json(state)
