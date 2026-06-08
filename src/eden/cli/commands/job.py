"""Eden CLI — Job commands."""

from __future__ import annotations

import asyncio
from typing import Any

import click

from eden.cli.main import cli, echo_json, echo_table, get_client


@cli.group(name="job")
def job() -> None:
    """Manage pipeline jobs."""


@job.command(name="list")
@click.option("--status", help="Filter by status")
@click.option("--outcome", "outcome_tier", help="Filter by outcome tier")
@click.option("--q", "query", help="Search query")
@click.option("--limit", default=20, help="Number of results")
@click.option("--offset", default=0, help="Offset for pagination")
@click.pass_context
def job_list(ctx: click.Context, status: str, outcome_tier: str, query: str, limit: int, offset: int) -> None:
    """List jobs."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            data = await client.jobs.list(
                status=status,
                outcome_tier=outcome_tier,
                q=query,
                limit=limit,
                offset=offset,
            )
            items = data.get("jobs", data.get("data", []))
            total = data.get("total", len(items))

            fmt = ctx.obj["format"]
            if fmt == "json":
                echo_json(data)
            else:
                headers = ["Job ID", "Status", "Stage", "Outcome", "Created"]
                rows = [
                    [
                        i.get("job_id", "")[:12],
                        i.get("status", ""),
                        i.get("current_stage", ""),
                        i.get("outcome_tier", "-"),
                        i.get("created_at", "")[:19],
                    ]
                    for i in items
                ]
                echo_table(headers, rows)
                click.echo(f"Total: {total} | Limit: {limit} | Offset: {offset}")

    asyncio.run(_run())


@job.command(name="get")
@click.argument("job_id")
@click.pass_context
def job_get(ctx: click.Context, job_id: str) -> None:
    """Get job status."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            j = await client.jobs.get(job_id)
            fmt = ctx.obj["format"]
            if fmt == "json":
                echo_json(j.model_dump())
            else:
                click.echo(f"Job ID:      {j.job_id}")
                click.echo(f"Status:      {j.status}")
                click.echo(f"Stage:       {j.current_stage}")
                click.echo(f"Outcome:     {j.outcome_tier or '-'}")
                click.echo(f"Created:     {j.created_at}")
                click.echo(f"Updated:     {j.updated_at}")
                if j.stage_history:
                    click.echo("Stage History:")
                    for entry in j.stage_history:
                        click.echo(f"  {entry}")

    asyncio.run(_run())


@job.command(name="result")
@click.argument("job_id")
@click.pass_context
def job_result(ctx: click.Context, job_id: str) -> None:
    """Get job result."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            try:
                result = await client.jobs.get_result(job_id)
                fmt = ctx.obj["format"]
                if fmt == "json":
                    echo_json(result.model_dump())
                else:
                    click.echo(f"Job ID:      {result.job_id}")
                    click.echo(f"Status:      {result.status}")
                    click.echo(f"Outcome:     {result.outcome_tier or '-'}")
                    if result.environment_code:
                        click.echo("--- Environment Code ---")
                        click.echo(result.environment_code[:3000])
                    if result.test_results:
                        click.echo("--- Test Results ---")
                        click.echo(str(result.test_results)[:1000])
            except Exception as e:
                click.echo(f"Error: {e}", err=True)
                raise click.ClickException(str(e))

    asyncio.run(_run())


@job.command(name="watch")
@click.argument("job_id")
@click.pass_context
def job_watch(ctx: click.Context, job_id: str) -> None:
    """Watch job progress in real time with a stage progress bar."""
    from eden.cli.progress import StageProgress

    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            progress = StageProgress()
            progress.update("planning", status=f"job {job_id}")
            progress.start()
            try:
                async for event in client.jobs.stream(job_id):
                    data = event.data
                    if event.event == "status":
                        stage = data.get("current_stage", "?")
                        outcome = data.get("outcome_tier")
                        progress.update(
                            stage,
                            status=outcome or data.get("status"),
                        )
                    elif event.event == "stage_change":
                        progress.echo(
                            f"  → {data.get('from', '?')} → {data.get('to', '?')}"
                        )
                    elif event.event == "code_fragment":
                        progress.echo(f"  → New code: {data.get('field', '?')}")
                    elif event.event == "complete":
                        progress.finish(
                            f"{data.get('status')} / {data.get('outcome_tier', '-')}"
                        )
                        break
                    elif event.event == "error":
                        progress.finish(f"error: {data}")
                        break
                else:
                    # Stream ended without a terminal event
                    progress.finish("stream ended")
            except Exception as exc:
                progress.finish(f"error: {exc}")
                raise

    asyncio.run(_run())


@job.command(name="cancel")
@click.argument("job_id")
@click.pass_context
def job_cancel(ctx: click.Context, job_id: str) -> None:
    """Cancel an in-progress job."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            result = await client.jobs.cancel(job_id)
            click.echo(f"Cancelled: {result.get('message', job_id)}")

    asyncio.run(_run())
