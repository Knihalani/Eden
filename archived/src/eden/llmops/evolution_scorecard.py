"""Evolution scorecard metrics — shipped with the API package.

Kept in ``eden.llmops`` (not ``bench/``) so production containers can serve
``GET /orgs/{id}/improve/scorecard`` without copying the bench tree into the
Docker image. ``bench.evolution.scorecard`` re-exports this module for the
nightly evolution runner.

Honesty: this is a **synthetic process-gate microbench** (inject budget +
hot-path p95), not org production KPIs. ``org_id`` is unused on purpose.
"""

from __future__ import annotations

import time
from typing import Any

from eden.config import get_settings
from eden.llmops.inject_budget import InjectBudget, InjectItem
from eden.nudges.engine import microbench_evaluate_sync
from eden.nudges.trigger_eval import evaluate_trigger


def run_scorecard(suite: str = "smoke") -> dict[str, Any]:
    t0 = time.perf_counter()
    settings = get_settings()
    budget = InjectBudget()
    items = [
        InjectItem(source="ledger", ref_id="1", text="a" * 2000, priority=1.0),
        InjectItem(source="artifact", ref_id="2", text="b" * 2000, priority=2.0),
    ]
    packed = budget.pack(items)
    hot = microbench_evaluate_sync(iterations=2000 if suite == "full" else 1000)
    trigger_ok = evaluate_trigger(
        {"all": [{"event": "tool_call", "tool": "grep", "min_repeats": 2}]},
        {
            "recent_tool_calls": [
                {"tool_name": "grep"},
                {"tool_name": "grep"},
            ]
        },
    )
    failed = (
        packed.tokens > settings.inject_budget_hard_tokens
        or hot["p95_ms"] >= 5.0
    )
    metrics: dict[str, Any] = {
        "suite": suite,
        "inject_tokens": packed.tokens,
        "inject_truncated": packed.truncated,
        "hard_cap": settings.inject_budget_hard_tokens,
        "soft_cap": settings.inject_budget_soft_tokens,
        "hot_path_llm_invoked": False,
        "hot_path_p95_ms": hot["p95_ms"],
        "trigger_dsl_ok": trigger_ok,
        "elapsed_ms": (time.perf_counter() - t0) * 1000,
    }
    if suite == "full":
        metrics["full_suite"] = True
        # Placeholders — not org production lift/cost; omit fake 0.0 KPIs.
        metrics["lift_gate_pp"] = None
        metrics["cost_gate_usd"] = None
    return {
        "metrics": metrics,
        "failed": failed,
        "synthetic": True,
        "kind": "process_gate_microbench",
        "disclaimer": (
            "Synthetic engineering microbench / process gate — "
            "not org production KPIs."
        ),
    }
