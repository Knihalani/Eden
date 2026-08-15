"""Demo-data seeding route (OOM plan §6.1 / W2-6 O1).

Exposes a single internal endpoint:

    POST /v1/internal/onboarding/{org_id}/seed-demo

**Auth**: org-admin required (403 otherwise).
**Guard**: same ``_require_onboarding_v2_enabled`` kill-switch used by
the existing onboarding routes — returns 503 when the flag is off.
**Idempotency**: the underlying seeder is idempotent; re-calling returns
the same counts (the stumble ``ON CONFLICT`` dedup fires on the
deterministic demo trace-ids).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, Path

from eden.api.deps import get_current_user, require_org_admin
from eden.api.utils.redact import redact_all
from eden.api.routes.onboarding import _require_onboarding_v2_enabled

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/v1/internal/onboarding/{org_id}",
    tags=["onboarding"],
    dependencies=[Depends(get_current_user), Depends(_require_onboarding_v2_enabled)],
)


@router.post("/seed-demo")
async def seed_demo(
    org_id: str = Path(...),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Seed ~12 synthetic traces + 1 issue + 1 improvement-plan draft.

    All seeded rows carry ``agent_id LIKE 'demo-%'`` and
    ``detected_by = 'eden:demo_seed'`` for precise purge.  The endpoint
    is idempotent: re-calling it returns the same result.

    Raises 403 when the caller is not an org admin.
    Raises 503 when ``onboarding_state_machine_v2_enabled`` is False.
    """
    from eden.onboarding.demo_seed import seed_demo_data

    result = await seed_demo_data(org_id)
    logger.info(
        "onboarding_seed: seeded org=%s stumbles=%d issue=%s plan=%s",
        org_id,
        result.get("stumbles_inserted", 0),
        result.get("issue_id"),
        result.get("plan_id"),
    )
    return {"status": "ok", "feature": "onboarding_seed", "data": result}


# ── fire-and-forget helper used by the Clerk webhook ─────────────────────────


async def _fire_and_forget_seed(org_id: str) -> None:
    """Spawn demo seeding as a background task; never raises."""
    async def _seed() -> None:
        try:
            from eden.onboarding.demo_seed import seed_demo_data

            result = await seed_demo_data(org_id)
            logger.info(
                "onboarding_seed: background seed complete org=%s result=%s",
                org_id,
                result,
            )
        except Exception as exc:
            logger.warning(
                "onboarding_seed: background seed failed org=%s: %s",
                org_id,
                redact_all(str(exc)),
            )

    asyncio.ensure_future(_seed())
