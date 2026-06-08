"""`/integrate-eden` slash command.

Orchestrates:
  1. Framework detection  (``framework_detector.detect_framework``)
  2. SDK integration plan (``sdk_integrator.build_integration_plan``)
  3. Local eval harness   (``eval_harness_generator.build_eval_harness``)
  4. CI plan              (``ci_generator.build_ci_plan``)

The command does NOT require the Eden server pipeline. When
``integrate.use_server_pipeline`` is False (the default) it produces
a fully self-contained local harness so the user gets value even on
installations where ``enable_eval_pipeline=false`` on the server.
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, List, Optional

from eden.autonomy import AutonomyManager
from eden.ci_generator import build_ci_plan
from eden.eval_harness_generator import build_eval_harness
from eden.framework_detector import detect_framework
from eden.sdk_integrator import build_integration_plan


def _parse_args(args: str) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="/integrate-eden",
        description="Detect agent framework, integrate Eden SDK, generate eval harness",
    )
    parser.add_argument(
        "--target", default=".", help="Target repo root (default: cwd)"
    )
    parser.add_argument(
        "--ci",
        action="append",
        default=None,
        choices=["github", "gitlab"],
        help="Emit CI config for the given provider (repeatable).",
    )
    parser.add_argument(
        "--no-ci", action="store_true", help="Skip CI config generation"
    )
    parser.add_argument(
        "--use-server-pipeline",
        action="store_true",
        help="Forward eval runs to the Eden server pipeline (requires enable_eval_pipeline=true).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the plan as JSON without writing any files",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing files (only .eden/config.yaml and the bootstrap file).",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip autonomy confirmation prompt",
    )
    return parser.parse_args(shlex.split(args) if args else [])


def _print(msg: str) -> None:
    print(msg, file=sys.stdout)


def _print_err(msg: str) -> None:
    print(msg, file=sys.stderr)


def cmd_eden_integrate(self: Any, args: str) -> Optional[dict]:
    """The ``/integrate-eden`` slash command."""
    config = getattr(self, "eden_config", None) or _StubConfig()
    autonomy: AutonomyManager = (
        getattr(self, "eden_autonomy", None) or AutonomyManager(config)
    )

    ns = _parse_args(args)
    target = Path(ns.target).expanduser().resolve()
    if not target.exists():
        _print_err(f"[integrate-eden] target does not exist: {target}")
        return {"success": False, "error": "target not found"}

    # Step 1: detect
    detection = detect_framework(target)
    _print(
        f"[integrate-eden] detected: framework={detection.framework} "
        f"language={detection.language} confidence={detection.confidence:.2f}"
    )

    # Step 2: integration plan
    integrate_cfg = config.get_section("integrate") if hasattr(config, "get_section") else {}
    use_server = ns.use_server_pipeline or bool(integrate_cfg.get("use_server_pipeline"))
    plan = build_integration_plan(target, detection, force=ns.force)

    # Step 3: eval harness
    server_endpoint = None
    if use_server:
        base_url = config.get("base_url") if hasattr(config, "get") else None
        if base_url:
            server_endpoint = f"{base_url.rstrip('/')}/pipeline/jobs"
    harness = build_eval_harness(
        target,
        detection,
        use_server_pipeline=use_server,
        server_pipeline_endpoint=server_endpoint,
    )

    # Step 4: CI
    ci_providers: Optional[List[str]]
    if ns.no_ci:
        ci_providers = []
    elif ns.ci is not None:
        ci_providers = ns.ci
    else:
        ci_providers = ["github", "gitlab"]  # default
    ci_plan = build_ci_plan(target, providers=ci_providers) if ci_providers else None

    # Combine for the user
    summary = {
        "detection": detection.to_dict(),
        "integration": plan.to_dict(),
        "eval_harness": harness.to_dict(),
        "ci": ci_plan.to_dict() if ci_plan else None,
        "use_server_pipeline": use_server,
    }

    if ns.dry_run:
        summary["success"] = True
        summary["dry_run"] = True
        _print(json.dumps(summary, indent=2))
        return summary

    # Autonomy gate: file_write decision across all paths we'll touch.
    all_paths = [c.path for c in plan.changes] + [f["path"] for f in harness.files]
    if ci_plan is not None:
        all_paths += [f["path"] for f in ci_plan.files]
    decision = autonomy.check_action("file_write", paths=all_paths)
    if not decision.allowed:
        _print_err(f"[integrate-eden] BLOCKED: {decision.reason}")
        return {"success": False, "error": decision.reason, "findings": [f.to_dict() for f in decision.findings]}
    if decision.requires_confirmation and not ns.yes:
        msg = (
            f"Integrate Eden into {target}? Will create/modify "
            f"{len(all_paths)} files. Findings: "
            f"{[f.to_dict() for f in decision.findings]}"
        )
        if not autonomy.confirm(decision, msg):
            _print_err("[integrate-eden] cancelled by user")
            return {"success": False, "error": "cancelled by user"}

    # Apply
    from eden.ci_generator import apply_ci_plan
    from eden.eval_harness_generator import apply_harness
    from eden.sdk_integrator import apply_plan

    written: List[str] = []
    written.extend(apply_plan(target, plan))
    written.extend(apply_harness(target, harness))
    if ci_plan is not None:
        written.extend(apply_ci_plan(target, ci_plan))
    autonomy.record_invocation("file_write")

    _print(f"[integrate-eden] wrote {len(written)} file(s):")
    for p in written:
        _print(f"  - {p}")
    _print(
        "[integrate-eden] next steps:\n"
        "  - pip install -r requirements.txt  (adds eden-ai)\n"
        "  - python eden_eval_harness.py     (runs the local eval)\n"
        "  - pytest tests/test_eden_eval.py  (pytest wrapper)"
    )

    summary["written"] = written
    summary["success"] = True
    return summary


# ---------------------------------------------------------------------------
# Stub config (mirrors commands/pr.py stub)
# ---------------------------------------------------------------------------


class _StubConfig:
    raw: dict = {
        "autonomy": {"mode": "approval"},
        "integrate": {"use_server_pipeline": False},
        "rate_limits": {"pipeline_invocations_per_hour": 5},
        "base_url": "http://localhost:8000",
    }

    def get_section(self, name: str) -> dict:
        return dict(self.raw.get(name, {}))

    def get(self, key: str, default: Any = None) -> Any:
        return self.raw.get(key, default)
