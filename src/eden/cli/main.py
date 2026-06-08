"""Eden CLI — main Click command group."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import click

from eden.sdk import EdenClient
from eden.sdk.config import EdenConfig

# Import command modules to register subcommands on the CLI group
# These modules define functions decorated with @cli.group() and @group.command()
import eden.cli.commands.env       # noqa: F401  registers 'environment'
import eden.cli.commands.job       # noqa: F401  registers 'job'
import eden.cli.commands.bench     # noqa: F401  registers 'benchmark'
import eden.cli.commands.config_cmd # noqa: F401  registers 'config'
import eden.cli.commands.trace     # noqa: F401  registers 'trace'
import eden.cli.commands.dataset   # noqa: F401  registers 'dataset'
# Phase 5.6 — CI/CD evaluation commands
import eden.cli.commands.ci        # noqa: F401  registers 'ci'
import eden.cli.commands.canary    # noqa: F401  registers 'canary'
import eden.cli.commands.security  # noqa: F401  registers 'security'
import eden.cli.commands.review    # noqa: F401  registers 'review'
import eden.cli.commands.generate  # noqa: F401  registers 'generate'


@click.group()
@click.option("--api-key", envvar="EDEN_API_KEY", help="Eden API key")
@click.option("--org", envvar="EDEN_DEFAULT_ORG", help="Target organization ID")
@click.option("--base-url", envvar="EDEN_BASE_URL", default="http://localhost:8000", help="Eden API base URL")
@click.option("--format", "output_format", type=click.Choice(["json", "table", "yaml"]), default="table", help="Output format")
@click.option("--quiet", is_flag=True, help="Suppress non-essential output")
@click.option("--verbose", is_flag=True, help="Show debug information")
@click.pass_context
def cli(ctx: click.Context, api_key: str, org: str, base_url: str, output_format: str, quiet: bool, verbose: bool) -> None:
    """Eden CLI — AI-native environment generation.

    \b
    Examples:
      eden environment create --description "Multi-agent negotiation"
      eden job list --status running
      eden benchmark run bench_abc123 --target-code ./agent.py
    """
    ctx.ensure_object(dict)
    ctx.obj["config"] = EdenConfig.load(
        api_key=api_key or None,
        base_url=base_url,
        default_org=org or None,
        debug=verbose,
    )
    ctx.obj["format"] = output_format
    ctx.obj["quiet"] = quiet
    ctx.obj["verbose"] = verbose


def echo_json(data: Any, pretty: bool = True) -> None:
    """Output data as JSON."""
    kwargs = {"indent": 2} if pretty else {}
    click.echo(json.dumps(data, default=str, **kwargs))


def echo_table(headers: list[str], rows: list[list[str]]) -> None:
    """Output a simple text table."""
    if not rows:
        click.echo("No data.")
        return

    # Calculate column widths
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))

    # Build format string
    fmt = " | ".join(f"{{:{w}}}" for w in widths)
    sep = "-+-".join("-" * w for w in widths)

    click.echo(fmt.format(*headers))
    click.echo(sep)
    for row in rows:
        click.echo(fmt.format(*[str(c) for c in row]))


def get_client(ctx: click.Context) -> EdenClient:
    """Get an async EdenClient from context."""
    from eden.sdk import EdenClient
    return EdenClient(config=ctx.obj["config"])
