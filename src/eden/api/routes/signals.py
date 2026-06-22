"""Phase Q — Plain English Signals API routes.

Three routes:

  * ``POST /orgs/{org}/signals`` — create a signal from NL
  * ``GET  /orgs/{org}/signals`` — list signals
  * ``POST /orgs/{org}/signals/{id}/match`` — test a value
  * ``POST /orgs/{org}/signals/cluster`` — group similar signals
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.routes.auth import get_current_user
from eden.services.cat2_intel.signals import (
    CompiledRule,
    NLSignal,
    SignalClusterer,
    compile_signal,
    match_signal,
    signal_signature,
)
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/orgs/{org_id}/signals",
    tags=["signals"],
)


# ── Schemas ───────────────────────────────────────────────────────


class CreateSignalRequest(BaseModel):
    description: str = Field(
        ..., min_length=3, max_length=2_000,
        description="Plain-English signal description.",
    )
    enabled: bool = True


class CompiledRuleResponse(BaseModel):
    metric: str
    op: str
    threshold: float
    window_hours: int
    scope: dict[str, str]
    keywords: list[str]


class SignalResponse(BaseModel):
    id: str
    org_id: str
    description: str
    rule: CompiledRuleResponse
    enabled: bool
    created_by: str | None
    cluster_id: str | None
    match_count: int
    created_at: str
    updated_at: str


class SignalListResponse(BaseModel):
    signals: list[SignalResponse]


class MatchRequest(BaseModel):
    value: float


class MatchResponse(BaseModel):
    matched: bool
    rule: CompiledRuleResponse


class ClusterRequest(BaseModel):
    similarity_threshold: float = Field(default=0.4, ge=0.0, le=1.0)


class ClusterResponse(BaseModel):
    clusters: dict[str, list[str]]  # cluster_id → [signal_id, ...]


# ── Helpers ───────────────────────────────────────────────────────





def _signal_to_response(s: NLSignal) -> SignalResponse:
    return SignalResponse(
        id=s.id, org_id=s.org_id,
        description=s.description,
        rule=CompiledRuleResponse(
            metric=s.rule.metric, op=s.rule.op,
            threshold=s.rule.threshold,
            window_hours=s.rule.window_hours,
            scope=s.rule.scope,
            keywords=s.rule.keywords,
        ),
        enabled=s.enabled,
        created_by=s.created_by,
        cluster_id=s.cluster_id,
        match_count=0,
        created_at=s.created_at,
        updated_at=s.updated_at,
    )


# ── Routes ────────────────────────────────────────────────────────


@router.post(
    "",
    response_model=SignalResponse,
    summary="Create a signal from a plain-English description",
)
async def create_signal(
    body: CreateSignalRequest,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> SignalResponse:
    user_id = str(user.get("id") or user.get("user_id") or user.get("sub"))
    rule = compile_signal(body.description)
    signal_id = str(uuid.uuid4())
    cluster_id = signal_signature(body.description)
    pg = await get_postgres_client()
    await pg.execute(
        """
        INSERT INTO nl_signals
            (id, org_id, description, rule, enabled,
             created_by, cluster_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        signal_id, org_id, body.description,
        _json_dumps(rule.to_dict()), body.enabled,
        user_id or None, cluster_id,
    )
    # Read back.
    row = await pg.fetchrow(
        """
        SELECT id, org_id, description, rule, enabled,
               created_by, cluster_id, match_count,
               created_at, updated_at
        FROM nl_signals WHERE id = $1
        """,
        signal_id,
    )
    if row is None:
        raise HTTPException(status_code=500, detail="signal vanished after insert")
    return _signal_to_response(_row_to_signal(row))


@router.get(
    "",
    response_model=SignalListResponse,
    summary="List signals for an org",
)
async def list_signals(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> SignalListResponse:
    pg = await get_postgres_client()
    rows = await pg.fetch(
        """
        SELECT id, org_id, description, rule, enabled,
               created_by, cluster_id, match_count,
               created_at, updated_at
        FROM nl_signals
        WHERE org_id = $1
        ORDER BY created_at DESC
        LIMIT 200
        """,
        org_id,
    )
    return SignalListResponse(
        signals=[_signal_to_response(_row_to_signal(r)) for r in rows],
    )


@router.post(
    "/{signal_id}/match",
    response_model=MatchResponse,
    summary="Test a numeric value against a signal's rule",
)
async def match_signal_route(
    body: MatchRequest,
    org_id: str = Path(...),
    signal_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> MatchResponse:
    pg = await get_postgres_client()
    row = await pg.fetchrow(
        """
        SELECT id, org_id, description, rule, enabled,
               created_by, cluster_id, match_count,
               created_at, updated_at
        FROM nl_signals
        WHERE id = $1 AND org_id = $2
        """,
        signal_id, org_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="signal not found")
    signal = _row_to_signal(row)
    matched = match_signal(signal.rule, body.value)
    return MatchResponse(
        matched=matched,
        rule=CompiledRuleResponse(
            metric=signal.rule.metric, op=signal.rule.op,
            threshold=signal.rule.threshold,
            window_hours=signal.rule.window_hours,
            scope=signal.rule.scope,
            keywords=signal.rule.keywords,
        ),
    )


@router.post(
    "/cluster",
    response_model=ClusterResponse,
    summary="Group semantically similar signals",
)
async def cluster_signals_route(
    body: ClusterRequest,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> ClusterResponse:
    pg = await get_postgres_client()
    rows = await pg.fetch(
        """
        SELECT id, org_id, description, rule, enabled,
               created_by, cluster_id, match_count,
               created_at, updated_at
        FROM nl_signals
        WHERE org_id = $1
        """,
        org_id,
    )
    signals = [_row_to_signal(r) for r in rows]
    clusterer = SignalClusterer(similarity_threshold=body.similarity_threshold)
    mapping = clusterer.cluster(signals)
    # Invert mapping: cluster_id → [signal_id, ...]
    clusters: dict[str, list[str]] = {}
    for sid, cid in mapping.items():
        clusters.setdefault(cid, []).append(sid)
    return ClusterResponse(clusters=clusters)


# ─- Helpers used by the routes ───────────────────────────────────


def _json_dumps(obj: Any) -> str:
    import json
    return json.dumps(obj, default=str, separators=(",", ":"))


def _row_to_signal(row: dict[str, Any]) -> NLSignal:
    rule_dict = row.get("rule")
    if isinstance(rule_dict, str):
        import json
        rule_dict = json.loads(rule_dict)
    rule = CompiledRule(
        metric=rule_dict.get("metric", "custom"),
        op=rule_dict.get("op", "=="),
        threshold=float(rule_dict.get("threshold", 0.0)),
        window_hours=int(rule_dict.get("window_hours", 24)),
        scope=rule_dict.get("scope", {}),
        keywords=rule_dict.get("keywords", []),
    )
    return NLSignal(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        description=str(row.get("description", "")),
        rule=rule,
        enabled=bool(row.get("enabled", True)),
        created_by=str(row["created_by"]) if row.get("created_by") else None,
        created_at=str(row.get("created_at", "")),
        updated_at=str(row.get("updated_at", "")),
        cluster_id=str(row["cluster_id"]) if row.get("cluster_id") else None,
    )
