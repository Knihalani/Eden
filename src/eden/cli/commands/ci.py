"""Eden CLI — CI/CD evaluation commands."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import click

from eden.cli.main import cli, echo_json, echo_table, get_client
from eden.evaluation.ci_pipeline import CIPipeline, StageName
from eden.evaluation.golden_dataset import load_canonical_datasets


@cli.group(name="ci")
def ci() -> None:
    """CI/CD evaluation pipeline commands."""


@ci.command(name="run")
@click.option("--commit-sha", required=True, help="Git commit SHA to evaluate")
@click.option("--branch", default="main", help="Git branch name")
@click.option("--changed-files", help="Comma-separated list of changed files")
@click.option("--baseline", help="Baseline commit for regression comparison")
@click.option("--skip", help="Comma-separated stages to skip")
@click.option("--wait", is_flag=True, help="Wait for pipeline to complete and show results")
@click.pass_context
def ci_run(ctx: click.Context, commit_sha: str, branch: str, changed_files: str, baseline: str, skip: str, wait: bool) -> None:
    """Run the CI evaluation pipeline."""
    click.echo(f"Starting CI pipeline for {branch}@{commit_sha[:8]}...")

    files = [f.strip() for f in changed_files.split(",")] if changed_files else []
    skip_stages = set()
    if skip:
        for name in skip.split(","):
            name = name.strip()
            try:
                skip_stages.add(StageName(name))
            except ValueError:
                click.echo(f"Warning: unknown stage '{name}', ignoring")

    pipeline = CIPipeline(dataset_registry=load_canonical_datasets())

    async def _run() -> None:
        report = await pipeline.run(
            commit_sha=commit_sha,
            branch=branch,
            changed_files=files,
            baseline_commit=baseline,
            skip_stages=skip_stages,
        )

        click.echo(f"\nCI Pipeline: {report.overall_status.value.upper()}")
        click.echo(f"Duration: {report.duration_ms:.0f}ms")
        click.echo(f"Merge allowed: {report.merge_allowed}")
        click.echo(f"Regression detected: {report.has_regression}")
        click.echo(f"\n{report.summary}")

        if ctx.obj.get("format") == "json":
            echo_json(report.to_dict())
        else:
            headers = ["Stage", "Status", "Duration (ms)", "Blocks Merge"]
            rows = [
                [s.stage.value, s.status.value, f"{s.duration_ms:.0f}", str(s.blocks_merge)]
                for s in report.stages
            ]
            echo_table(headers, rows)

    asyncio.run(_run())


@ci.command(name="report")
@click.argument("run_id")
@click.pass_context
def ci_report(ctx: click.Context, run_id: str) -> None:
    """Get a previously saved CI pipeline report."""
    pipeline = CIPipeline(dataset_registry=load_canonical_datasets())
    report = pipeline.load_report(run_id)

    if not report:
        click.echo(f"Report {run_id} not found", err=True)
        return

    click.echo(f"CI Report: {report.run_id}")
    click.echo(f"Commit: {report.commit_sha}")
    click.echo(f"Branch: {report.branch}")
    click.echo(f"Status: {report.overall_status.value}")
    click.echo(f"Merge allowed: {report.merge_allowed}")

    if ctx.obj.get("format") == "json":
        echo_json(report.to_dict())
    else:
        for stage in report.stages:
            status_color = {
                "passed": "green",
                "failed": "red",
                "warned": "yellow",
                "skipped": "dim",
            }.get(stage.status.value, "white")
            click.echo(f"  {stage.stage.value}: {stage.status.value} ({stage.duration_ms:.0f}ms)")


@ci.command(name="datasets")
@click.pass_context
def ci_datasets(ctx: click.Context) -> None:
    """List golden datasets available for CI evaluation."""
    registry = load_canonical_datasets()
    datasets = registry.list_datasets()

    click.echo(f"Golden Datasets ({len(datasets)}):")

    if ctx.obj.get("format") == "json":
        echo_json([d.to_dict() for d in datasets])
    else:
        headers = ["Dataset ID", "Version", "Cases", "Categories"]
        rows = [
            [d.dataset_id, d.version, str(len(d.cases)), ", ".join({c.category.value for c in d.cases})]
            for d in datasets
        ]
        echo_table(headers, rows)
