"""Eden CLI — Benchmark commands."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import click

from eden.cli.main import cli, echo_json, echo_table, get_client


@cli.group(name="benchmark")
def benchmark() -> None:
    """Run and manage benchmarks."""


@benchmark.command(name="create")
@click.option("--name", "-n", required=True, help="Benchmark name")
@click.option("--agent", "-a", multiple=True, required=True, help="Target agent(s)")
@click.option("--criteria", "-c", type=str, help="Criteria JSON")
@click.pass_context
def bench_create(ctx: click.Context, name: str, agent: tuple[str, ...], criteria: str) -> None:
    """Create a new benchmark definition."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            crit: dict[str, Any] = {}
            if criteria:
                import json
                crit = json.loads(criteria)

            bench = await client.benchmarks.create(
                benchmark_name=name,
                target_agents=list(agent),
                criteria=crit,
            )
            click.echo(f"Created benchmark: {bench.benchmark_id}")
            click.echo(bench.message)

    asyncio.run(_run())


@benchmark.command(name="run")
@click.argument("benchmark_id")
@click.option("--target-code", "-t", type=click.Path(exists=True), required=True, help="Path to code file to benchmark")
@click.option("--output", "-o", type=click.Path(), help="Write results to JSON file")
@click.pass_context
def bench_run(ctx: click.Context, benchmark_id: str, target_code: str, output: str) -> None:
    """Run a benchmark against target code."""
    async def _run() -> None:
        client = get_client(ctx)
        code = Path(target_code).read_text()
        async with client:
            result = await client.benchmarks.run(benchmark_id, target_code=code)
            fmt = ctx.obj["format"]
            if fmt == "json":
                echo_json(result.model_dump())
            else:
                click.echo(f"Run ID:    {result.run_id}")
                click.echo(f"Status:    {result.status}")
                click.echo(f"Passed:    {'✅' if result.passed else '❌'}")
                click.echo("Scores:")
                for k, v in result.scores.items():
                    click.echo(f"  {k}: {v}")
            if output:
                import json
                Path(output).write_text(json.dumps(result.model_dump(), indent=2))
                click.echo(f"Saved to {output}")

    asyncio.run(_run())


@benchmark.command(name="results")
@click.argument("benchmark_id")
@click.pass_context
def bench_results(ctx: click.Context, benchmark_id: str) -> None:
    """Get benchmark results."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            result = await client.benchmarks.results(benchmark_id)
            fmt = ctx.obj["format"]
            if fmt == "json":
                echo_json(result.model_dump())
            else:
                click.echo(f"Benchmark: {result.benchmark_id}")
                click.echo(f"Run ID:    {result.run_id}")
                click.echo(f"Passed:    {'✅' if result.passed else '❌'}")
                click.echo(f"Timestamp: {result.timestamp}")
                click.echo("Scores:")
                for k, v in result.scores.items():
                    click.echo(f"  {k}: {v}")

    asyncio.run(_run())


@benchmark.command(name="history")
@click.pass_context
def bench_history(ctx: click.Context) -> None:
    """List past benchmark runs."""
    async def _run() -> None:
        client = get_client(ctx)
        async with client:
            history = await client.benchmarks.history()
            fmt = ctx.obj["format"]
            if fmt == "json":
                echo_json([h.model_dump() for h in history])
            else:
                headers = ["Run ID", "Benchmark", "Status", "Passed", "Timestamp"]
                rows = [
                    [
                        h.run_id[:12],
                        h.benchmark_id[:12],
                        h.status,
                        "✅" if h.passed else "❌",
                        h.timestamp[:19],
                    ]
                    for h in history
                ]
                echo_table(headers, rows)

    asyncio.run(_run())


@benchmark.command(name="compare")
@click.argument("baseline_id")
@click.argument("current_id")
@click.pass_context
def bench_compare(ctx: click.Context, baseline_id: str, current_id: str) -> None:
    """Compare two benchmark runs (placeholder for Phase 3)."""
    click.echo(f"Comparing {baseline_id} vs {current_id}")
    click.echo("Detailed comparison available via the portal.")
