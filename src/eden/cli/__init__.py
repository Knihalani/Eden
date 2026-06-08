"""Eden CLI — command-line interface for Eden.

Usage:
    eden environment create
    eden job list
    eden benchmark run bench_abc123 --target-code ./agent.py
"""

from eden.cli.main import cli


def main() -> None:
    """CLI entry point."""
    cli()
