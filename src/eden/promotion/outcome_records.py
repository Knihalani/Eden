"""Wave 3 (3.4) — per-kind outcome producers + readers for F41 evidence.

Each of the four tables from migration 169 mirrors ``nudge_outcomes`` so
``EvidenceGate._metrics_from_outcomes`` can return real data for every
PromotionKind. This module owns the SQL both ways:

  * **Producers** record the *decision* at the point it happens (a guardrail
    verdict, a routing classification, a skill application, a PR merge), and
    mark ``outcome_success`` when the outcome becomes known (bypass detected,
    fallback used, issue ignored/resolved, PR reverted).
  * **Readers** aggregate ``outcome_success`` into the 0/1 failure series the
    StatGate consumes (1=failure/stumble, 0=success), split by
    ``applied`` (treatment=the candidate ref, control=everything else in the
    org — mirroring the nudge/prompt_version conventions).

All functions are best-effort: producers never raise into their callers
(the hot paths they hook into must not fail because outcome logging broke);
readers return ``[]`` on any error so the gate holds rather than crashes.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


# ── producers ──────────────────────────────────────────────────────


async def record_guardrail_outcome(
    org_id: str,
    guardrail_id: str,
    *,
    outcome_success: bool | None,
    trace_id: str | None = None,
    metric_delta: dict[str, Any] | None = None,
) -> None:
    """Record a guardrail decision whose correctness became known.

    Called when a bypass is detected (outcome_success=False — the guardrail
    that should have fired didn't) or when a guardrail is promoted/demoted
    through the evidence gate (lifecycle outcome).
    """
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        import json

        await client.execute(
            """
            INSERT INTO guardrail_outcomes
                (org_id, guardrail_id, trace_id, outcome_success, metric_delta)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            """,
            org_id,
            guardrail_id,
            trace_id,
            outcome_success,
            json.dumps(metric_delta or {}),
        )
    except Exception as exc:  # noqa: BLE001 — producer must never raise
        logger.debug("outcome_records: guardrail record failed: %s", exc)


async def record_routing_decision(
    org_id: str,
    agent: str,
    *,
    slot: str | None,
    tier: str,
    heuristic_used: bool,
    fallback_used: bool = False,
) -> None:
    """Record a ModelRouter classification decision.

    ``fallback_used=True`` means the chosen tier had to fall back — the
    router guessed wrong, i.e. outcome_success=False at read time.
    """
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO routing_decisions
                (org_id, agent, slot, tier, heuristic_used, fallback_used,
                 outcome_success)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            org_id,
            agent,
            slot,
            tier,
            heuristic_used,
            fallback_used,
            None if not fallback_used else False,
        )
    except Exception as exc:  # noqa: BLE001 — producer must never raise
        logger.debug("outcome_records: routing record failed: %s", exc)


async def record_skill_outcome(
    org_id: str,
    skill_id: str,
    *,
    issue_id: str | None,
    outcome_success: bool,
    metric_delta: dict[str, Any] | None = None,
) -> None:
    """Record a skill application outcome.

    The flywheel applies a drafted skill when an issue resolves; whether it
    *helped* is the issue's resolution state (resolved=success,
    ignored=failure).
    """
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        import json

        await client.execute(
            """
            INSERT INTO skill_outcomes
                (org_id, skill_id, issue_id, outcome_success, metric_delta)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            """,
            org_id,
            skill_id,
            issue_id,
            outcome_success,
            json.dumps(metric_delta or {}),
        )
    except Exception as exc:  # noqa: BLE001 — producer must never raise
        logger.debug("outcome_records: skill record failed: %s", exc)


async def record_pr_merge(
    org_id: str,
    plan_id: str,
    *,
    pr_number: int | None = None,
) -> None:
    """Record a merged PR; outcome unknown until the guardian reverts it.

    Idempotent via the ``UNIQUE (org_id, plan_id)`` constraint — a
    re-delivered merge event re-stamps the existing row instead of
    accumulating duplicates."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO pr_outcomes (org_id, plan_id, pr_number, merged_at)
            VALUES ($1, $2, $3, now())
            ON CONFLICT (org_id, plan_id)
            DO UPDATE SET merged_at = now(),
                          pr_number = COALESCE(EXCLUDED.pr_number,
                                               pr_outcomes.pr_number)
            """,
            org_id,
            plan_id,
            pr_number,
        )
    except Exception as exc:  # noqa: BLE001 — producer must never raise
        logger.debug("outcome_records: pr merge record failed: %s", exc)


async def mark_pr_reverted(
    org_id: str,
    plan_id: str,
    *,
    pr_number: int | None = None,
) -> None:
    """Flip a merged PR's outcome to failure when the guardian reverts it.

    Single upsert (relies on the ``UNIQUE (org_id, plan_id)`` constraint):
    marks the existing merge row reverted, or records a fresh reverted row
    when the merge was never written (e.g. merged outside the auto-merge
    path but still reverted)."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO pr_outcomes (org_id, plan_id, pr_number,
                                     merged_at, reverted_at, outcome_success)
            VALUES ($1, $2, $3, now(), now(), FALSE)
            ON CONFLICT (org_id, plan_id)
            DO UPDATE SET reverted_at = now(),
                          outcome_success = FALSE,
                          pr_number = COALESCE(EXCLUDED.pr_number,
                                               pr_outcomes.pr_number)
            """,
            org_id,
            plan_id,
            pr_number,
        )
    except Exception as exc:  # noqa: BLE001 — producer must never raise
        logger.debug("outcome_records: pr revert record failed: %s", exc)


# ── readers (1 = failure/stumble, 0 = success) ─────────────────────


async def guardrail_outcome_metrics(
    org_id: str, ref_id: str, *, applied: bool
) -> list[float]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT outcome_success
            FROM guardrail_outcomes
            WHERE org_id = $1
              AND outcome_success IS NOT NULL
              AND ($2 OR guardrail_id = $3)
            ORDER BY recorded_at DESC
            LIMIT 200
            """,
            org_id,
            not applied,  # control = all org rows, treatment = ref only
            ref_id,
        )
        return [0.0 if r["outcome_success"] else 1.0 for r in rows or []]
    except Exception as exc:  # noqa: BLE001
        logger.debug("outcome_records: guardrail metrics failed: %s", exc)
        return []


async def routing_decision_metrics(
    org_id: str, ref_id: str, *, applied: bool
) -> list[float]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT fallback_used, outcome_success
            FROM routing_decisions
            WHERE org_id = $1
              AND ($2 OR agent = $3)
            ORDER BY recorded_at DESC
            LIMIT 200
            """,
            org_id,
            not applied,
            ref_id,
        )
        out: list[float] = []
        for r in rows or []:
            if r.get("outcome_success") is not None:
                out.append(0.0 if r["outcome_success"] else 1.0)
            else:
                # No explicit outcome yet — a fallback means the router
                # guessed wrong (failure); no fallback means success.
                out.append(1.0 if r.get("fallback_used") else 0.0)
        return out
    except Exception as exc:  # noqa: BLE001
        logger.debug("outcome_records: routing metrics failed: %s", exc)
        return []


async def skill_outcome_metrics(
    org_id: str, ref_id: str, *, applied: bool
) -> list[float]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT outcome_success
            FROM skill_outcomes
            WHERE org_id = $1
              AND outcome_success IS NOT NULL
              AND ($2 OR skill_id = $3)
            ORDER BY recorded_at DESC
            LIMIT 200
            """,
            org_id,
            not applied,
            ref_id,
        )
        return [0.0 if r["outcome_success"] else 1.0 for r in rows or []]
    except Exception as exc:  # noqa: BLE001
        logger.debug("outcome_records: skill metrics failed: %s", exc)
        return []


async def pr_merge_outcome_metrics(
    org_id: str, ref_id: str, *, applied: bool
) -> list[float]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT outcome_success
            FROM pr_outcomes
            WHERE org_id = $1
              AND merged_at IS NOT NULL
              AND ($2 OR plan_id = $3)
            ORDER BY recorded_at DESC
            LIMIT 200
            """,
            org_id,
            not applied,
            ref_id,
        )
        # outcome_success stays NULL for merged-but-not-yet-reverted rows:
        # count them as success (the merge held) — revert is the failure.
        out: list[float] = []
        for r in rows or []:
            if r.get("outcome_success") is False:
                out.append(1.0)
            else:
                out.append(0.0)
        return out
    except Exception as exc:  # noqa: BLE001
        logger.debug("outcome_records: pr metrics failed: %s", exc)
        return []


__all__ = [
    "record_guardrail_outcome",
    "record_routing_decision",
    "record_skill_outcome",
    "record_pr_merge",
    "mark_pr_reverted",
    "guardrail_outcome_metrics",
    "routing_decision_metrics",
    "skill_outcome_metrics",
    "pr_merge_outcome_metrics",
]
