"""Eden CLI — Security scanning commands."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import click

from eden.cli.main import cli, echo_json, echo_table
from eden.evaluation.security_scanner import SecurityScanner, SecurityIssue, Severity


@cli.group(name="security")
def security() -> None:
    """Security scanning and analysis commands."""


@security.command(name="scan")
@click.argument("path", type=click.Path(exists=True))
@click.option("--requirements", "-r", help="Requirements file path")
@click.option("--output", "-o", type=click.Choice(["json", "table"]), default="table", help="Output format")
@click.pass_context
def security_scan(ctx: click.Context, path: str, requirements: str, output: str) -> None:
    """Run a comprehensive security scan on a Python file or directory."""
    target = Path(path)
    scanner = SecurityScanner()

    req_list: list[str] = []
    if requirements:
        req_path = Path(requirements)
        if req_path.exists():
            req_list = [line.strip() for line in req_path.read_text().splitlines() if line.strip() and not line.startswith("#")]

    async def _scan() -> None:
        if target.is_file():
            result = await scanner.scan_file(target, req_list)
        else:
            # Scan all Python files in directory
            all_issues = []
            for py_file in target.rglob("*.py"):
                try:
                    file_result = await scanner.scan_file(py_file, [])
                    all_issues.extend(file_result.get("all_issues", []))
                except Exception as e:
                    click.echo(f"Warning: failed to scan {py_file}: {e}", err=True)

            # De-duplicate issues by (file, line, rule_id)
            seen = set()
            unique_issues = []
            for issue in all_issues:
                key = (issue.get("file_path", ""), issue.get("line_number", 0), issue.get("rule_id", ""))
                if key not in seen:
                    seen.add(key)
                    unique_issues.append(issue)

            result = {
                "overall_passed": not any(i.get("severity") in ("critical", "high") for i in unique_issues),
                "gate_policy": {
                    "blocked_count": sum(1 for i in unique_issues if i.get("severity") == "critical"),
                    "warning_count": sum(1 for i in unique_issues if i.get("severity") in ("high", "medium")),
                },
                "all_issues": unique_issues,
                "scans": {"sast": {"issues": unique_issues}},
            }

        _display_results(result, output)

    asyncio.run(_scan())


@security.command(name="scan-code")
@click.argument("code")
@click.option("--requirements", "-r", multiple=True, help="Dependency requirements")
@click.pass_context
def security_scan_code(ctx: click.Context, code: str, requirements: tuple) -> None:
    """Run security scan on inline code."""
    scanner = SecurityScanner()

    async def _scan() -> None:
        result = await scanner.scan_environment(
            code=code,
            requirements=list(requirements),
            file_path="<inline>",
        )
        _display_results(result, ctx.obj.get("format", "table"))

    asyncio.run(_scan())


@security.command(name="sbom")
@click.option("--requirements", "-r", required=True, type=click.Path(exists=True), help="Requirements file")
@click.option("--project", default="eden", help="Project name")
@click.option("--output", "-o", type=click.Path(), help="Output file for SBOM JSON")
@click.pass_context
def security_sbom(ctx: click.Context, requirements: str, project: str, output: str) -> None:
    """Generate a Software Bill of Materials (SBOM)."""
    from eden.evaluation.security_scanner import SBOMGenerator

    req_path = Path(requirements)
    req_list = [line.strip() for line in req_path.read_text().splitlines() if line.strip() and not line.startswith("#")]

    generator = SBOMGenerator()
    sbom = generator.generate(req_list, project)

    if output:
        Path(output).write_text(json.dumps(sbom, indent=2), encoding="utf-8")
        click.echo(f"SBOM written to {output}")
    else:
        echo_json(sbom)


def _display_results(result: dict[str, Any], output_format: str) -> None:
    """Display security scan results."""
    if output_format == "json":
        echo_json(result)
        return

    click.echo(f"Security Scan: {'PASSED' if result['overall_passed'] else 'FAILED'}")
    click.echo(f"Blocked: {result['gate_policy']['blocked_count']} | Warnings: {result['gate_policy']['warning_count']}")

    issues = result.get("all_issues", [])
    if not issues:
        click.echo("No issues found.")
        return

    headers = ["Severity", "Category", "Rule", "File", "Line", "Message"]
    rows = []
    for issue in issues:
        rows.append([
            issue.get("severity", "?"),
            issue.get("category", "?"),
            issue.get("rule_id", "?"),
            issue.get("file_path", "")[-40:],  # truncate
            str(issue.get("line_number", "")),
            issue.get("message", "")[:60],
        ])
    echo_table(headers, rows)
