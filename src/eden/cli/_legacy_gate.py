"""Shared helpers for deprecating the legacy eval-pipeline thin CLI.

The thin ``eden <command>`` interface (``generate``, ``environment``,
``job``, ``benchmark``) drove the original environment-generation
pipeline. After the observability/improvement-platform pivot, that
pipeline is gated behind :attr:`Settings.enable_eval_pipeline` (default
``False``). This module centralises the deprecation behaviour so every
legacy command emits a consistent notice.

Use :func:`require_eval_pipeline` at the top of any command body that
*creates work* on the legacy pipeline. Use :func:`warn_legacy_pipeline`
for read-only commands (``eden job list``) that should still run, but
with a small notice steering callers to the modern CLI.
"""
from __future__ import annotations

import os
import sys

import click

from eden.config import get_settings


def _eval_pipeline_enabled() -> bool:
    """Return True iff the legacy eval pipeline is enabled.

    Reads both the Settings field and the env var (the latter is checked
    in case Settings doesn't auto-bind from the environment).
    """
    if get_settings().enable_eval_pipeline:
        return True
    raw = os.environ.get("EDEN_ENABLE_EVAL_PIPELINE")
    if raw is None:
        return False
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def require_eval_pipeline(command_name: str) -> None:
    """Exit 2 with a deprecation notice unless ``enable_eval_pipeline`` is on.

    Place this call as the first statement of a legacy command body. If
    the setting is enabled, control returns normally and the original
    implementation proceeds.
    """
    if _eval_pipeline_enabled():
        return
    click.echo(
        f"[DEPRECATED] `eden {command_name}` is part of the legacy environment-generation "
        "pipeline, which is disabled by default.\n"
        "            Enable it by setting EDEN_ENABLE_EVAL_PIPELINE=true, OR use the new "
        "Eden Agent CLI:\n"
        "              `eden integrate-eden`  (from the `cli/` directory — see plan unit C1/C2)",
        err=True,
    )
    sys.exit(2)


def warn_legacy_pipeline(command_name: str) -> None:
    """Print a small notice that the command is legacy but still run it."""
    click.echo(
        f"[NOTE] `eden {command_name}` reads from the legacy eval-pipeline dataset. "
        "For the modern flow, see the Eden Agent CLI's `eden integrate-eden` command "
        "(in the `cli/` directory).",
        err=True,
    )
