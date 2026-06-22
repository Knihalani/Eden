"""Alerts API routes — list and acknowledge alerts (§9.5.1).

GET  /alerts           — list currently-firing alerts (evaluated on demand)
POST /alerts/{id}/ack  — mark an alert as acknowledged (no-op for the
                         in-memory engine; the production version
                         writes to a Redis stream)
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Cookie, Depends
from pydantic import BaseModel

from eden.api.deps import get_current_user
from eden.observability.alerts import evaluate_alerts

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/alerts", tags=["alerts"])


class AlertOut(BaseModel):
    rule_id: str
    severity: str
    title: str
    message: str
    value: float
    threshold: float
    fired_at: str
    labels: dict[str, str] = {}


class AckRequest(BaseModel):
    note: str | None = None


class AckResponse(BaseModel):
    rule_id: str
    acknowledged: bool
    note: str | None = None


@router.get("", response_model=list[AlertOut])
async def list_alerts(
    _user: dict = Depends(get_current_user),  # Audit 2026-06-22 B1.5 — require login
    authorization: str | None = Cookie(None),
) -> list[AlertOut]:
    """Evaluate alert rules against current metrics and return fired
    alerts. Read-only — no DB or audit impact."""
    fired = evaluate_alerts()
    return [AlertOut(**a.to_dict()) for a in fired]


@router.post("/{rule_id}/ack", response_model=AckResponse)
async def ack_alert(
    rule_id: str,
    req: AckRequest,
    _user: dict = Depends(get_current_user),  # Audit 2026-06-22 B1.5 — require login
    authorization: str | None = Cookie(None),
) -> AckResponse:
    """Mark an alert as acknowledged.

    For the in-memory engine this is a no-op (alerts are re-evaluated
    on every read). The production version writes to a Redis
    ``eden_alerts_ack`` stream that the on-call rotation consumes.
    """
    return AckResponse(rule_id=rule_id, acknowledged=True, note=req.note)
