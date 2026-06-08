"""Eden CLI — Environment commands."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import click

from eden.cli.main import cli, echo_json, echo_table, get_client


@cli.group(name="environment")
def environment() -> None:
    """Manage generated environments."""


@environment.command(name="create")
@click.option("--description", "-d", required=True, help="Natural language description")
@click.option("--tags", "-t", multiple=True, help="Tags to guide the Planner")
@click.option("--difficulty", type=str, default="", help="Difficulty parameters as JSON")
@click.option("--wait", is_flag=True, help="Wait for completion and stream progress")
@click.option("--output", "-o", type=click.Path(), help="Write result code to file")
@click.pass_context
def env_create(ctx: click.Context, description: str, tags: tuple[str, ...], difficulty: str, wait: bool, output: str) -> None:
    """Create a new environment generation job."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            params: dict[str, Any] = {}
            if difficulty:
                import json
                params = json.loads(difficulty)

            job = await client.jobs.create(
                description=description,
                tags=list(tags),
                difficulty_parameters=params,
            )

            if ctx.obj.get("quiet"):
                click.echo(job.job_id)
                return

            click.echo(f"Created job: {job.job_id}")
            click.echo(f"Status: {job.status}")

            if wait:
                click.echo("Streaming progress...")
                async for event in client.jobs.stream(job.job_id):
                    data = event.data
                    if event.event == "status":
                        click.echo(f"  [{data.get('status', '?')}] {data.get('current_stage', '?')}")
                    elif event.event == "complete":
                        click.echo(f"  Complete: {data.get('status')}")
                        break

                # Fetch result
                try:
                    result = await client.jobs.get_result(job.job_id)
                    if result.environment_code:
                        if output:
                            Path(output).write_text(result.environment_code)
                            click.echo(f"Saved to {output}")
                        else:
                            click.echo("--- Environment Code ---")
                            click.echo(result.environment_code)
                except Exception as e:
                    click.echo(f"Result not ready: {e}", err=True)

    asyncio.run(_run())


@environment.command(name="list")
@click.option("--status", help="Filter by status")
@click.option("--outcome", "outcome_tier", help="Filter by outcome tier")
@click.option("--limit", default=20, help="Number of results")
@click.option("--offset", default=0, help="Offset for pagination")
@click.pass_context
def env_list(ctx: click.Context, status: str, outcome_tier: str, limit: int, offset: int) -> None:
    """List environments."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            data = await client.environments.list(
                status=status,
                outcome_tier=outcome_tier,
                limit=limit,
                offset=offset,
            )
            items = data.get("data", data)
            total = data.get("total", len(items))

            fmt = ctx.obj["format"]
            if fmt == "json":
                echo_json(data)
            elif fmt == "yaml":
                try:
                    import yaml
                    click.echo(yaml.dump(data))
                except ImportError:
                    echo_json(data)
            else:
                headers = ["Job ID", "Status", "Outcome", "Created"]
                rows = [
                    [i.get("job_id", "")[:12], i.get("status", ""), i.get("outcome_tier", "-"), i.get("created_at", "")[:19]]
                    for i in items
                ]
                echo_table(headers, rows)
                click.echo(f"Total: {total} | Limit: {limit} | Offset: {offset}")

    asyncio.run(_run())


@environment.command(name="get")
@click.argument("job_id")
@click.pass_context
def env_get(ctx: click.Context, job_id: str) -> None:
    """Get environment details by job ID."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            env = await client.environments.get(job_id)
            fmt = ctx.obj["format"]
            if fmt == "json":
                echo_json(env.model_dump())
            else:
                click.echo(f"Job ID:     {env.job_id}")
                click.echo(f"Status:     {env.status}")
                click.echo(f"Stage:      {env.current_stage}")
                click.echo(f"Outcome:    {env.outcome_tier or '-'}")
                if env.environment_code:
                    click.echo("--- Code ---")
                    click.echo(env.environment_code[:2000])

    asyncio.run(_run())


@environment.command(name="download")
@click.argument("job_id")
@click.option("--output", "-o", type=click.Path(), required=True, help="Output ZIP path")
@click.pass_context
def env_download(ctx: click.Context, job_id: str, output: str) -> None:
    """Download environment code as a ZIP archive."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            zip_bytes = await client.environments.download(job_id)
            Path(output).write_bytes(zip_bytes)
            click.echo(f"Downloaded {len(zip_bytes)} bytes to {output}")

    asyncio.run(_run())


@environment.command(name="tests")
@click.argument("job_id")
@click.pass_context
def env_tests(ctx: click.Context, job_id: str) -> None:
    """Get test results for an environment."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            report = await client.environments.tests(job_id)
            fmt = ctx.obj["format"]
            if fmt == "json":
                echo_json(report.model_dump())
            else:
                click.echo(f"Job ID:     {report.job_id}")
                click.echo(f"Status:     {report.status}")
                click.echo(f"Verdict:    {report.verdict}")
                click.echo(f"Tests:      {report.total_passed}/{report.total_tests} passed")
                click.echo(f"Exploits:   {report.exploits_detected}")
                click.echo(f"Adversarial: {report.adversarial_issues}")

    asyncio.run(_run())
