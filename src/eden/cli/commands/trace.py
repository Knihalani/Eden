"""Eden CLI — Trace commands for observability."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import click

from eden.cli.main import cli, echo_json, echo_table, get_client


@cli.group(name="trace")
def trace() -> None:
    """Agent tracing and observability."""


@trace.command(name="list")
@click.option("--limit", default=20, help="Number of traces")
@click.option("--offset", default=0, help="Offset for pagination")
@click.pass_context
def trace_list(ctx: click.Context, limit: int, offset: int) -> None:
    """List recent traces (placeholder for Phase 3 telemetry)."""
    click.echo("Trace list will be available when the telemetry collector is online (Phase 3).")
    click.echo("Configure auto-tracing in your agent code with:")
    click.echo('  from eden.sdk import trace_agent\n  @trace_agent()\n  async def my_agent(...): ...')


@trace.command(name="show")
@click.argument("trace_id")
@click.pass_context
def trace_show(ctx: click.Context, trace_id: str) -> None:
    """Show trace details."""
    click.echo(f"Trace details for {trace_id} — available in Phase 3.")


@trace.command(name="export")
@click.option("--output", "-o", type=click.Path(), required=True, help="Output file (JSONL)")
@click.option("--limit", default=100, help="Number of traces to export")
@click.pass_context
def trace_export(ctx: click.Context, output: str, limit: int) -> None:
    """Export traces to a JSONL file."""
    click.echo(f"Export {limit} traces to {output} — available in Phase 3.")
