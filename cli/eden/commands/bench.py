"""`/eden-bench` slash command — gated by ``enable_eval_pipeline``.

The Eden evaluation *pipeline* (multi-stage Planner/Critic/Refiner/…)
is the legacy env-generation workflow. The new Eden is observability-
first, with a thin local eval harness replacing most pipeline use.
The ``enable_eval_pipeline`` server flag (set by unit B6) hides the
pipeline entirely by default.

This command:
  1. Checks the server flag. If OFF, prints a deprecation warning
     and routes the user to ``/integrate-eden`` + local harness.
  2. If ON, dispatches a benchmark job to the server.

In this C2 worker the *gate* is implemented; the actual server
submission is a stub that the B6 unit wires up.
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
    parser = argparse.ArgumentParser(prog="/eden-bench", description="Run a benchmark")
    parser.add_argument("action", choices=["create", "run", "compare", "history"], nargs="?")
    parser.add_argument("--name", help="Benchmark name")
    parser.add_argument("--criteria", help="Criteria JSON or path to JSON file")
    parser.add_argument("--benchmark-id", help="Benchmark ID for run/compare")
    parser.add_argument("--baseline-id", help="Baseline ID (compare)")
    parser.add_argument("--yes", action="store_true", help="Skip autonomy prompt")
    return parser.parse_args(shlex.split(args) if args else [])


DEPRECATION_NOTICE = (
    "[DEPRECATED] The Eden evaluation pipeline is gated behind "
    "`enable_eval_pipeline=true` on the server. With the default "
    "(flag=off), use `/integrate-eden` to generate a local eval "
    "harness: it works without the pipeline and covers the same "
    "smoke / instantiation / latency checks. Re-run with the server "
    "flag enabled to dispatch jobs to the legacy pipeline."
)


def _flag_enabled(config: Any) -> bool:
    """Resolve the ``enable_eval_pipeline`` flag.

    Resolution order:
      1. ``EDEN_ENABLE_EVAL_PIPELINE`` env var (test override).
      2. The Eden server's settings endpoint (real deployment).
      3. Conservative default: ``False``.
    """
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


def cmd_eden_bench(self: Any, args: str) -> Optional[dict]:
    """The ``/eden-bench`` slash command (gated)."""
    config = getattr(self, "eden_config", None) or _StubConfig()
    autonomy: AutonomyManager = getattr(self, "eden_autonomy", None) or AutonomyManager(config)

    ns = _parse_args(args)

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
        _print_warn(f"[eden-bench] BLOCKED: {decision.reason}")
        return {"success": False, "error": decision.reason, "gated": False}
    if decision.requires_confirmation and not ns.yes:
        if not autonomy.confirm(decision, f"Run benchmark action={ns.action!r}?"):
            _print_warn("[eden-bench] cancelled by user")
            return {"success": False, "error": "cancelled", "gated": False}

    # The actual pipeline submission lives in the B6 unit. C2 stops at
    # the gate; we return a stub result so the chat loop can move on.
    autonomy.record_invocation("pipeline_invoke")
    return {
        "success": True,
        "gated": False,
        "action": ns.action,
        "result": "submitted",
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
