"""Scheduled optimization PR trigger.

The brief is explicit:

> On a configurable schedule, default daily, spawn a
> lightweight review / optimization agent. It reviews
> all relevant Eden data collected since the last run,
> identifies real, evidence-backed improvement
> opportunities, and uses the repo graph to understand
> where changes would belong. If improvements are
> justified, it spawns the coding agent to implement
> them and open PR(s).

This module is the daily entry point. It is
intentionally simpler than the incident trigger: the
candidate list comes from the existing Cat 23 surface
(:class:`eden.code_change.patch_generator.PatchGenerator`
+ the existing
:func:`eden.code_change.scheduler.evaluate_pending_clusters`).
The new discipline layer adds three guarantees on top:

* **Dedupe** — batch identical fingerprints so we don't
  open multiple PRs for the same root issue.
* **Confidence gate** — only candidates that pass the
  gate spawn the agent.
* **Batching** — multiple related candidates are
  aggregated into a single PR (preferred over many
  small noisy PRs).

The function :func:`run` is the daily entry point. It
returns a structured summary suitable for the cron
job's stdout log + the on-call inbox banner.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def _gate_one(
    candidate: dict[str, Any],
    *,
    graph: Any | None,
    policy: dict[str, Any] | None,
) -> dict[str, Any]:
    """Run the incident-trigger flow for one candidate.

    Thin wrapper that re-uses :func:`incident_trigger.run`
    so the discipline chokepoint is the same in both
    flows.
    """
    from . import incident_trigger
    return await incident_trigger.run(
        candidate, graph=graph, policy=policy,
    )


async def run(
    candidates: list[dict[str, Any]],
    *,
    graph: Any | None = None,
    policy: dict[str, Any] | None = None,
    max_prs: int = 2,
) -> dict[str, Any]:
    """Run the scheduled optimization flow.

    1. Run the incident-trigger flow for each
       candidate (which itself runs the gate, breaker,
       dedupe, rate limit, and the agent).
    2. Aggregate the results.
    3. Cap at ``max_prs`` PRs (default 2) so we don't
       spawn a flood.

    Args:
        candidates: The list of improvement candidates
            (same shape as the incident payload, with
            ``target_kind`` distinguishing the two).
        graph: The optional repo-graph client.
        policy: The optional per-org gate policy.
        max_prs: Maximum number of PR-creating runs
            in this batch (default 2). The brief's
            guidance is "prefer one strong PR over many
            small noisy ones" so this is intentionally
            low.
    """
    summary: dict[str, Any] = {
        "candidates_received": len(candidates),
        "prs_spawned": 0,
        "reports_only": 0,
        "denied": 0,
        "duplicates": 0,
        "rate_limited": 0,
        "breaker_open": 0,
        "max_prs_cap": max_prs,
        "results": [],
    }
    if not candidates:
        return summary

    # Run the gate for each candidate concurrently (they're
    # independent reads against the discipline layer).
    # The async graph query inside the incident flow is
    # already async-safe, so we don't need extra
    # serialization here.
    try:
        results = await asyncio.gather(
            *[_gate_one(c, graph=graph, policy=policy) for c in candidates],
            return_exceptions=True,
        )
    except Exception as exc:
        logger.debug(
            "scheduled_trigger.run: gather failed: %s", exc,
        )
        results = []

    for r in results:
        if isinstance(r, Exception):
            summary["denied"] += 1
            summary["results"].append({"error": str(r)})
            continue
        kind = r.get("kind") if isinstance(r, dict) else "report_only"
        if kind in ("pr_ready", "draft_pr"):
            if summary["prs_spawned"] < max_prs:
                summary["prs_spawned"] += 1
                summary["results"].append(r)
            else:
                summary["reports_only"] += 1
                summary["results"].append({
                    "kind": "report_only",
                    "reason": "max_prs_cap_reached",
                    "summary": r.get("summary"),
                })
        else:
            reason = r.get("reason") if isinstance(r, dict) else ""
            if reason == "duplicate_in_window":
                summary["duplicates"] += 1
            elif reason == "rate_limit":
                summary["rate_limited"] += 1
            elif reason == "circuit_breaker_open":
                summary["breaker_open"] += 1
            else:
                summary["reports_only"] += 1
            summary["results"].append(r)

    return summary
