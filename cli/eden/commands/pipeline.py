"""`/eden-pipeline` slash command — gated by ``enable_eval_pipeline``.

Manually invokes the multi-stage Eden pipeline (Planner/Critic/…).
Like :mod:`eden.commands.bench`, this command:
  1. Checks the server flag. If OFF, prints a deprecation warning
     and routes the user to ``/integrate-eden`` + local harness.
  2. If ON, dispatches a pipeline job to the server (B6 stub).
"""

from __future__ import annotations

import argparse
import os
import shlex
import sys
from typing import Any, Optional

from eden.api_client import EdenAPIClient
from eden.autonomy import AutonomyManager


def _parse_args(args: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="/eden-pipeline", description="Invoke the Eden pipeline"
    )
    parser.add_argument("--description", help="Pipeline job description")
    parser.add_argument("--spec-file", help="Path to a spec file")
    parser.add_argument(
        "--yes", action="store_true", help="Skip autonomy confirmation prompt"
    )
    return parser.parse_args(shlex.split(args) if args else [])


DEPRECATION_NOTICE = (
    "[DEPRECATED] The Eden pipeline is gated behind "
    "`enable_eval_pipeline=true` on the server (default OFF). For "
    "modern flows, use `/integrate-eden` to bootstrap your agent with "
    "Eden SDK + a local eval harness. Re-run with the server flag "
    "enabled to dispatch to the legacy multi-stage pipeline."
)


def _flag_enabled(config: Any) -> bool:
    env = os.environ.get("EDEN_ENABLE_EVAL_PIPELINE")
    if env is not None:
        return env.strip().lower() in {"1", "true", "yes", "on"}

    base_url = config.get("base_url") if hasattr(config, "get") else None
    api_key = config.get("api_key") if hasattr(config, "get") else None
    org_id = config.get("org_id") if hasattr(config, "get") else None
    if not base_url:
        return False
    try:
        client = EdenAPIClient(base_url, api_key=api_key or "", org_id=org_id or "")
        return client.is_eval_pipeline_enabled()
    except Exception:  # noqa: BLE001
        return False


def _print_warn(msg: str) -> None:
    print(msg, file=sys.stderr)


def cmd_eden_pipeline(self: Any, args: str) -> Optional[dict]:
    """The ``/eden-pipeline`` slash command (gated)."""
    config = getattr(self, "eden_config", None) or _StubConfig()
    autonomy: AutonomyManager = getattr(self, "eden_autonomy", None) or AutonomyManager(config)

    ns = _parse_args(args)
    if not ns.description and not ns.spec_file:
        _print_warn(
            "[eden-pipeline] need --description or --spec-file. Use "
            "`/integrate-eden` for the modern flow."
        )
        return {"success": False, "error": "missing --description/--spec-file"}

    if not _flag_enabled(config):
        _print_warn(DEPRECATION_NOTICE)
        return {
            "success": False,
            "gated": True,
            "reason": "enable_eval_pipeline=false",
            "fallback": "/integrate-eden",
        }

    # Autonomy gate
    decision = autonomy.check_action("pipeline_invoke")
    if not decision.allowed:
        _print_warn(f"[eden-pipeline] BLOCKED: {decision.reason}")
        return {"success": False, "error": decision.reason, "gated": False}
    if decision.requires_confirmation and not ns.yes:
        if not autonomy.confirm(decision, f"Submit pipeline job? (desc={ns.description!r})"):
            _print_warn("[eden-pipeline] cancelled by user")
            return {"success": False, "error": "cancelled", "gated": False}

    autonomy.record_invocation("pipeline_invoke")
    return {
        "success": True,
        "gated": False,
        "description": ns.description,
        "spec_file": ns.spec_file,
        "note": "pipeline submission is implemented by unit B6; this stub confirms gating succeeded",
    }


class _StubConfig:
    raw: dict = {
        "autonomy": {"mode": "approval"},
        "rate_limits": {"pipeline_invocations_per_hour": 5},
        "base_url": "http://localhost:8000",
        "api_key": "",
        "org_id": "",
    }

    def get_section(self, name: str) -> dict:
        return dict(self.raw.get(name, {}))

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)
