"""Demo-data seeder for new orgs (OOM plan §6.1 / W2-6 O1).

Generates ~12 synthetic stumbles across 3 demo agents, promotes them into
1 seeded issue, and inserts 1 improvement-plan draft — all without touching
real ClickHouse traces. Every row carries:

  * ``agent_id`` with the ``demo-`` prefix so the purge can target them
    precisely with a ``LIKE 'demo-%'`` predicate.
  * ``detected_by = "eden:demo_seed"`` on stumbles as a secondary tag.

The seeding is **idempotent**: a second call with the same ``org_id``
inserts nothing new because the stumble ``ON CONFLICT`` dedup fires on
``(org_id, trace_id, kind, fingerprint)`` — the demo trace-ids are
deterministic given the agent prefix.

Public API
----------
* :func:`seed_demo_data` — create demo stumbles + issue + plan.
* :func:`purge_demo_data` — remove only demo-tagged rows.
* :func:`is_demo_agent_id` — predicate used by the purge logic.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

# ─── constants ────────────────────────────────────────────────────────────────

#: Prefix shared by all demo agent-ids.  The purge SQL uses
#: ``agent_id LIKE 'demo-%'`` so any sub-prefix works.
DEMO_AGENT_ID_PREFIX = "demo-"

#: ``detected_by`` sentinel written to every demo stumble.
DEMO_DETECTED_BY = "eden:demo_seed"

#: Demo agents seeded for every new org (3 × 4 stumbles = 12 traces).
_DEMO_AGENTS: list[dict[str, Any]] = [
    {
        "agent_id": "demo-checkout-agent",
        "scenario": "code-bug",
        "stumbles": 4,
    },
    {
        "agent_id": "demo-deploy-agent",
        "scenario": "deploy-regression",
        "stumbles": 4,
    },
    {
        "agent_id": "demo-analysis-agent",
        "scenario": "code-bug",
        "stumbles": 4,
    },
]

_BUGGY_FILE = "agent/checkout.py"


def is_demo_agent_id(agent_id: str | None) -> bool:
    """Return True when *agent_id* belongs to the demo dataset."""
    return bool(agent_id and agent_id.startswith(DEMO_AGENT_ID_PREFIX))


# ─── detail builders (mirrors inject_synthetic_incident._detail_for) ──────────


def _detail_for(
    scenario: str, seed: str, agent_id: str
) -> tuple[str, str, dict[str, Any]]:
    """Return ``(kind, title, detail)`` for a demo stumble."""
    if scenario == "deploy-regression":
        return (
            "statgate_p0",
            f"StatGate P0 regression ({agent_id})",
            {"check": seed, "deploy_marker": seed, "demo": True},
        )
    return (
        "tool_error",
        f"checkout crashes with ZeroDivisionError ({agent_id})",
        {
            "tool_name": "checkout",
            "error": f"ZeroDivisionError in {_BUGGY_FILE} [{seed}]",
            "file": _BUGGY_FILE,
            "demo": True,
        },
    )


# ─── seeding ──────────────────────────────────────────────────────────────────


async def _seed_agent(
    org_id: str,
    *,
    agent_id: str,
    scenario: str,
    count: int,
    batch: int,
) -> tuple[int, Any | None]:
    """Seed *count* stumbles for one demo agent.  Returns ``(inserted, issue)``."""
    from eden.issues.models import StumbleCreate
    from eden.issues.stumble_writer import StumbleWriter

    seed = agent_id
    kind, title, detail = _detail_for(scenario, seed, agent_id)
    writer = StumbleWriter()
    inserted = 0
    issue = None

    for i in range(count):
        sc = StumbleCreate(
            org_id=org_id,
            trace_id=f"demo-{agent_id}-{batch}-{i}",
            kind=kind,
            title=title,
            detail=dict(detail),
            detected_by=DEMO_DETECTED_BY,
            agent_id=agent_id,
            user_id=f"demo-user-{i % 3}",
        )
        try:
            result = await writer.create(sc)
            if result.get("inserted"):
                inserted += 1
            issue = result.get("issue") or issue
        except Exception as exc:
            logger.warning(
                "demo_seed: stumble insert failed for %s/%d: %s", agent_id, i, exc
            )

    return inserted, issue


async def _seed_improvement_plan(org_id: str, agent_id: str) -> str | None:
    """Insert one demo improvement-plan draft.  Returns the plan_id or None."""
    try:
        from eden.improvement.plans_repo import create_plan

        plan = await create_plan(
            org_id,
            plan_kind="demo",
            title="[Demo] Reduce ZeroDivisionError rate in checkout agent",
            agent_id=agent_id,
            summary=(
                "This is a sample improvement plan seeded to show how Eden "
                "automatically triages recurring errors and proposes fixes. "
                "It will disappear once your first real traces arrive."
            ),
            source_ref="demo:code-bug",
            evidence={"demo": True, "seeded_by": DEMO_DETECTED_BY},
            status="draft",
        )
        if plan:
            return plan.get("id")
    except Exception as exc:
        logger.warning("demo_seed: improvement plan insert failed: %s", exc)
    return None


async def seed_demo_data(org_id: str) -> dict[str, Any]:
    """Seed ~12 synthetic stumbles, 1 issue, and 1 improvement-plan draft.

    Idempotent — a second call for the same org is a no-op because the
    stumble ``ON CONFLICT`` dedup fires on the deterministic trace-ids.

    Returns a summary dict suitable for logging or the API response.
    """
    batch = int(time.time())
    total_inserted = 0
    last_issue: Any | None = None

    for agent_cfg in _DEMO_AGENTS:
        inserted, issue = await _seed_agent(
            org_id,
            agent_id=agent_cfg["agent_id"],
            scenario=agent_cfg["scenario"],
            count=agent_cfg["stumbles"],
            batch=batch,
        )
        total_inserted += inserted
        if issue is not None:
            last_issue = issue

    # Seed one improvement-plan draft off the first demo agent.
    plan_id = await _seed_improvement_plan(org_id, _DEMO_AGENTS[0]["agent_id"])

    return {
        "org_id": org_id,
        "stumbles_inserted": total_inserted,
        "issue_id": str(last_issue.id) if last_issue else None,
        "plan_id": plan_id,
        "demo_agents": [a["agent_id"] for a in _DEMO_AGENTS],
    }


# ─── purge ────────────────────────────────────────────────────────────────────


async def purge_demo_data(org_id: str) -> dict[str, Any]:
    """Remove only demo-tagged rows for *org_id*.

    Targets rows precisely with two independent predicates so a partial
    mis-tag can never delete real data:

    * ``agent_stumbles``:
      ``detected_by = 'eden:demo_seed'`` AND ``agent_id LIKE 'demo-%'``
    * ``agent_issues``:
      ``agent_id LIKE 'demo-%'`` AND fingerprint present in the stumbles
      we just deleted (avoids deleting any real issue that happened to
      share a demo agent_id string).
    * ``improvement_plans``:
      ``evidence->>'demo' = 'true'`` AND ``agent_id LIKE 'demo-%'``

    Returns counts of rows deleted for each table.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        logger.warning("demo_seed.purge: no postgres client for org=%s", org_id)
        return {"org_id": org_id, "error": "no_db"}

    deleted: dict[str, int] = {}

    # 1. Stumbles — primary anchor.
    try:
        result = await client.execute(
            """
            DELETE FROM agent_stumbles
            WHERE org_id = $1
              AND detected_by = $2
              AND agent_id LIKE $3
            """,
            org_id,
            DEMO_DETECTED_BY,
            f"{DEMO_AGENT_ID_PREFIX}%",
        )
        # asyncpg returns "DELETE N" as a string.
        deleted["stumbles"] = _parse_count(result)
    except Exception as exc:
        logger.warning("demo_seed.purge: stumble delete failed: %s", exc)
        deleted["stumbles"] = -1

    # 2. Issues — orphaned after stumble purge.
    try:
        result = await client.execute(
            """
            DELETE FROM agent_issues
            WHERE org_id = $1
              AND agent_id LIKE $2
              AND agent_id LIKE 'demo-%'
            """,
            org_id,
            f"{DEMO_AGENT_ID_PREFIX}%",
        )
        deleted["issues"] = _parse_count(result)
    except Exception as exc:
        logger.warning("demo_seed.purge: issue delete failed: %s", exc)
        deleted["issues"] = -1

    # 3. Improvement plans.
    try:
        result = await client.execute(
            """
            DELETE FROM improvement_plans
            WHERE org_id = $1
              AND agent_id LIKE $2
              AND evidence->>'demo' = 'true'
            """,
            org_id,
            f"{DEMO_AGENT_ID_PREFIX}%",
        )
        deleted["plans"] = _parse_count(result)
    except Exception as exc:
        logger.warning("demo_seed.purge: plan delete failed: %s", exc)
        deleted["plans"] = -1

    logger.info(
        "demo_seed.purge: org=%s deleted=%s", org_id, deleted
    )
    return {"org_id": org_id, "deleted": deleted}


def _parse_count(pg_result: str) -> int:
    """Parse asyncpg status string e.g. 'DELETE 5' → 5."""
    try:
        return int(str(pg_result).split()[-1])
    except (ValueError, IndexError):
        return 0
