"""Eden CLI — Configuration and login commands."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import click

from eden.cli.main import cli


@cli.group(name="config")
def config() -> None:
    """Manage CLI configuration."""


@config.command(name="show")
def config_show() -> None:
    """Display current configuration."""
    from eden.sdk.config import EdenConfig
    cfg = EdenConfig.load()
    click.echo("Current configuration:")
    click.echo(f"  base_url:    {cfg.base_url}")
    click.echo(f"  default_org: {cfg.default_org or '(not set)'}")
    click.echo(f"  api_key:     {'*' * 8 if cfg.api_key else '(not set)'}")
    click.echo(f"  timeout:     {cfg.timeout}")
    click.echo(f"  max_retries: {cfg.max_retries}")
    click.echo(f"  debug:       {cfg.debug}")
    click.echo(f"  source:      {cfg._source}")


@config.command(name="set")
@click.argument("key")
@click.argument("value")
def config_set(key: str, value: str) -> None:
    """Set a configuration value."""
    config_path = Path.home() / ".eden" / "config.toml"
    config_path.parent.mkdir(parents=True, exist_ok=True)

    # Read existing
    existing: dict[str, Any] = {}
    if config_path.exists():
        try:
            import tomllib
        except ImportError:
            import tomli as tomllib  # type: ignore
        with open(config_path, "rb") as f:
            existing = tomllib.load(f)

    # Update with type coercion
    if key in ("timeout", "max_retries"):
        existing[key] = int(value)
    elif key == "debug":
        existing[key] = value.lower() in ("1", "true", "yes")
    else:
        existing[key] = value

    _write_toml(config_path, existing)
    click.echo(f"Set {key} = {value} in {config_path}")


def _write_toml(path: Path, data: dict[str, Any]) -> None:
    """Write config to TOML with proper string escaping via json.dumps."""
    lines = ["# Eden CLI configuration\n"]
    for k, v in data.items():
        if isinstance(v, str):
            lines.append(f"{k} = {json.dumps(v)}\n")
        elif isinstance(v, bool):
            lines.append(f"{k} = {'true' if v else 'false'}\n")
        elif isinstance(v, (int, float)):
            lines.append(f"{k} = {v}\n")
        else:
            lines.append(f"{k} = {json.dumps(str(v))}\n")
    path.write_text("".join(lines))


@config.command(name="login")
@click.option("--api-key", envvar="EDEN_API_KEY", help="Eden API key")
@click.option("--org", envvar="EDEN_DEFAULT_ORG", help="Default organization ID")
@click.option("--base-url", default="http://localhost:8000", help="Eden API base URL")
def config_login(api_key: str, org: str, base_url: str) -> None:
    """Authenticate and save API key configuration."""
    import asyncio
    import httpx

    if not api_key:
        api_key = click.prompt("API key", hide_input=True)
    if not org:
        org = click.prompt("Organization ID")

    if base_url.startswith("http://") and not base_url.startswith("http://localhost"):
        click.echo("WARNING: Using HTTP (not HTTPS) to send credentials. Use HTTPS in production.", err=True)

    async def _validate() -> None:
        async with httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=10.0) as c:
            headers: dict[str, str] = {}
            if api_key and org:
                headers["X-Org-Api-Key"] = api_key
                headers["X-Org-Id"] = org
            resp = await c.get("/v1/jobs?limit=1", headers=headers)
            if resp.status_code == 200:
                click.echo("✓ API key valid")
                config_path = Path.home() / ".eden" / "config.toml"
                config_path.parent.mkdir(parents=True, exist_ok=True)
                existing: dict[str, Any] = {}
                if config_path.exists():
                    try:
                        import tomllib
                    except ImportError:
                        import tomli as tomllib  # type: ignore
                    with open(config_path, "rb") as f:
                        existing = tomllib.load(f)
                existing["api_key"] = api_key
                existing["default_org"] = org
                existing["base_url"] = base_url
                _write_toml(config_path, existing)
                click.echo(f"Configuration saved to {config_path}")
            else:
                click.echo(f"✗ API key validation failed: {resp.status_code}", err=True)

    asyncio.run(_validate())
