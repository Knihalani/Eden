"""Eden CLI — Dataset commands for benchmarks and evaluation suites."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import click

from eden.cli.main import cli, echo_json, get_client


@cli.group(name="dataset")
def dataset() -> None:
    """Manage evaluation datasets and curriculum suites."""


@dataset.command(name="upload")
@click.argument("path", type=click.Path(exists=True))
@click.option("--name", "-n", required=True, help="Dataset name")
@click.option("--description", "-d", default="", help="Dataset description")
@click.option("--format", "fmt", type=click.Choice(["jsonl", "csv", "yaml"]), default="jsonl", help="File format")
@click.pass_context
def dataset_upload(ctx: click.Context, path: str, name: str, description: str, fmt: str) -> None:
    """Upload a dataset for benchmarking."""
    click.echo(f"Upload dataset '{name}' from {path} — Phase 3 feature.")


@dataset.command(name="list")
@click.pass_context
def dataset_list(ctx: click.Context) -> None:
    """List uploaded datasets."""
    click.echo("Dataset list — Phase 3 feature.")


@dataset.command(name="get")
@click.argument("dataset_id")
@click.pass_context
def dataset_get(ctx: click.Context, dataset_id: str) -> None:
    """Get dataset details."""
    click.echo(f"Dataset {dataset_id} — Phase 3 feature.")
