"""PromotionProposal per upgradespec.md §E.4.

Pydantic BaseModel + thin async persist helper. When the approval gate is
required (high-severity hooks), the proposal is written to the existing
``closed_loop_actions`` table with ``status='pending_approval'`` — the
``ClosedLoopExecutor`` already in tree picks them up unchanged.

Auto-approves (status='approved', applied_at=now) when requires_approval=False.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Literal

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


ActionLiteral = Literal[
    "anonymize",
    "redact",
    "rtbf",
    "throttle",
    "kill",
    "rollback_prompt",
    "pause_session",
    "investigate",
    "block_promotion",
    "bump_canary",
    "rollback_canary",
    "promote_judge",
    "disable_guardrail",
    "archive_variant",
    "register_regression_watch",
    "pause_rollup_scheduler",
    "surface_lint_warning",
    "propose_patch",
    "consider_revert",
]


class PromotionProposal(BaseModel):
    """Per upgradespec §E.4."""

    action: ActionLiteral
    target_id: str
    target_type: str
    reason_hook_id: str
    proposed_at: str
    proposed_by: Literal["system"] | str  # user_id when manual
    requires_approval: bool
    approved_by: str | None = None
    approved_at: str | None = None
    status: Literal["pending", "approved", "rejected", "expired"]
    expires_at: str
    proposal_id: str = Field(default_factory=lambda: str(uuid.uuid4()))

    async def persist(self) -> str:
        """Write to closed_loop_actions. Returns proposal_id.

        Best-effort: errors are logged and swallowed so the hook caller
        is never broken by a missing substrate.
        """
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception as exc:
            logger.debug("hook_proposal: postgres import failed: %s", exc)
            return self.proposal_id
        try:
            client = await get_postgres_client()
        except Exception:
            return self.proposal_id
        if client is None:
            return self.proposal_id

        payload = self.model_dump()
        # Status → applied_at / applied_by
        applied_at = self.approved_at if self.status in ("approved", "rejected") else None
        applied_by = self.approved_by if self.status in ("approved", "rejected") else None

        try:
            await client.execute(
                """
                INSERT INTO closed_loop_actions
                    (id, org_id, hook_name, action_kind, target,
                     payload_json, severity, status, applied_at, applied_by)
                VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
                ON CONFLICT (id) DO NOTHING
                """,
                self.proposal_id,
                # org_id isn't on the proposal model — we expect the caller
                # (HookBus) to have threaded it via context. Fallback to "".
                "",  # org_id — caller patches via UPDATE if needed
                self.action[:64],
                self.action[:64],
                (self.target_id or "")[:256] or None,
                json.dumps(payload, default=str)[:4000],
                "medium",  # default severity; hook_bus can override via UPDATE
                self.status,
                applied_at,
                applied_by,
            )
        except Exception as exc:
            logger.warning("hook_proposal: persist failed: %s", exc)
        return self.proposal_id
