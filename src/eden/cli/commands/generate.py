"""``eden generate`` — generate a quality-gated environment from a description.

This is the command wrapped by the ``eden-generate`` GitHub Action
(see ``.github/actions/eden-generate/action.yml``). It is also
usable directly from the CLI for local development.

The command is intentionally minimal: it POSTs the description to
``/specs`` (creating a spec), POSTs to ``/jobs`` (creating a job),
and polls ``/jobs/{id}`` until the job terminates. The GitHub
Action layer adds PR-comment rendering on top of the JSON output.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

import click
import yaml

from eden.cli.main import cli


# Terminal job statuses. See STATUS_COLORS in clients/portal/src/lib/types.ts
# — the CLI uses the same vocabulary so a future unified schema
# (job_status enum) can be lifted out of the duplicated lists.
TERMINAL_STATUSES = {"completed", "failed", "cancelled", "human_review"}


def _emit(ctx: click.Context, payload: dict[str, Any]) -> None:
    """Emit a result in the requested format (json/table/yaml)."""
    fmt = ctx.obj.get("format", "table")
    quiet = ctx.obj.get("quiet", False)
    if fmt == "json":
        click.echo(json.dumps(payload, indent=2, default=str))
        return
    if fmt == "yaml":
        click.echo(yaml.safe_dump(payload, sort_keys=False))
        return
    # table — human-friendly one-screen summary
    if not quiet:
        click.echo(f"Job {payload.get('job_id', '?')}: {payload.get('status', '?')}")
        click.echo(f"  Description: {payload.get('description', '')[:80]}")
        click.echo(f"  Quality:     {payload.get('quality_score', 'n/a')}")
        click.echo(f"  Outcome:     {payload.get('outcome_tier', 'n/a')}")
        if payload.get("report_url"):
            click.echo(f"  Report:      {payload['report_url']}")


@cli.command("generate")
@click.option(
    "--description",
    "-d",
    required=True,
    help="Plain-language description of the environment to generate.",
)
@click.option(
    "--spec-file",
    type=click.Path(exists=True, dir_okay=False, path_type=Path),
    default=None,
    help="Optional path to a pre-built spec YAML/JSON. When provided, --description is used only as the spec's title.",
)
@click.option(
    "--timeout",
    default=1800,
    show_default=True,
    help="Maximum seconds to wait for the job to reach a terminal state.",
)
@click.option(
    "--poll-interval",
    default=5,
    show_default=True,
    help="Seconds between job-status polls while waiting for completion.",
)
@click.option(
    "--wait/--no-wait",
    default=True,
    show_default=True,
    help="When false, returns immediately after creating the job (useful for fire-and-forget).",
)
@click.option(
    "--out",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    help="If set, write the final result to this path as JSON (in addition to stdout).",
)
@click.pass_context
def generate(
    ctx: click.Context,
    description: str,
    spec_file: Path | None,
    timeout: int,
    poll_interval: int,
    wait: bool,
    out: Path | None,
) -> None:
    """Generate a quality-gated Eden environment from a description.

    \b
    Examples:
      eden generate --description "Multi-agent negotiation with limited trust"
      eden generate --description "Adversarial coding eval" --no-wait
      eden generate --spec-file ./spec.yaml --out ./result.json
    """
    from eden.sdk import EdenClient
    from eden.sdk.config import EdenConfig

    config: EdenConfig = ctx.obj["config"]
    client = EdenClient(config=config)

    if not config.api_key:
        click.echo(
            "error: --api-key (or EDEN_API_KEY env) is required for `eden generate`",
            err=True,
        )
        sys.exit(2)

    # Build the spec.
    if spec_file is not None:
        spec_payload = _load_spec(spec_file, title=description)
    else:
        spec_payload = {
            "title": description,
            "description": description,
            "source": "cli:generate",
        }

    spec = client.create_spec(spec_payload)

    job = client.create_job(
        {
            "spec_id": spec.get("id"),
            "title": description,
            "description": description,
        }
    )
    job_id = job.get("id") or job.get("job_id")
    if not job_id:
        click.echo(f"error: job creation returned no id: {job}", err=True)
        sys.exit(1)

    if not wait:
        result = {"job_id": job_id, "status": "pending", "description": description}
        _emit(ctx, result)
        if out:
            out.write_text(json.dumps(result, indent=2, default=str))
        return

    final = _wait_for_terminal(client, job_id, timeout=timeout, poll_interval=poll_interval)
    result = {
        "job_id": job_id,
        "status": final.get("status"),
        "description": description,
        "quality_score": final.get("quality_score"),
        "outcome_tier": final.get("outcome_tier"),
        "report_url": final.get("report_url"),
    }
    _emit(ctx, result)
    if out:
        out.write_text(json.dumps(result, indent=2, default=str))
    if final.get("status") == "failed":
        sys.exit(1)


def _load_spec(path: Path, title: str) -> dict[str, Any]:
    """Load a spec from YAML or JSON, falling back to a description-only spec."""
    text = path.read_text()
    if path.suffix in {".yaml", ".yml"}:
        loaded = yaml.safe_load(text) or {}
    else:
        loaded = json.loads(text)
    if not isinstance(loaded, dict):
        raise click.BadParameter(f"Spec file must be a mapping; got {type(loaded).__name__}")
    loaded.setdefault("title", title)
    loaded.setdefault("description", title)
    loaded.setdefault("source", f"cli:generate:{path.name}")
    return loaded


def _wait_for_terminal(
    client: Any,
    job_id: str,
    *,
    timeout: int,
    poll_interval: int,
) -> dict[str, Any]:
    """Poll the job until it reaches a terminal state or the timeout expires."""
    deadline = time.monotonic() + timeout
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = client.get_job(job_id) or {}
        status = last.get("status")
        if status in TERMINAL_STATUSES:
            return last
        time.sleep(poll_interval)
    # Timed out — return whatever the last poll saw so the caller can
    # decide what to do (CI will surface "running after N seconds").
    return {**last, "status": last.get("status", "timeout"), "timed_out": True}
