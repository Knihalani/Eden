"""Phase Q — Plain English Signals API routes.

Three routes:

  * ``POST /orgs/{org}/signals`` — create a signal from NL
  * ``GET  /orgs/{org}/signals`` — list signals
  * ``POST /orgs/{org}/signals/{id}/match`` — test a value
  * ``POST /orgs/{org}/signals/cluster`` — group similar signals
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.routes.auth import get_current_user
from eden.api.utils.safe_error import safe_detail
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


class SeedDefaultsRequest(BaseModel):
    profile: str = Field(
        default="standard",
        description="minimal | standard | advanced",
    )


class SeedDefaultsResponse(BaseModel):
    count: int
    skipped: int
    profile: str
    signal_ids: list[str] = Field(default_factory=list)


# ── Helpers ───────────────────────────────────────────────────────


_SELECT_COLS = """
    id, org_id, description, rule, enabled,
    created_by, cluster_id, match_count,
    created_at, updated_at
"""


def _is_missing_relation(exc: BaseException) -> bool:
    """True when Postgres says ``nl_signals`` (or a dep) is missing."""
    msg = str(exc).lower()
    return (
        "nl_signals" in msg
        and (
            "does not exist" in msg
            or "undefinedtable" in msg
            or getattr(exc, "sqlstate", None) == "42P01"
        )
    ) or (
        getattr(exc, "sqlstate", None) == "42P01"
    )


def _signal_to_response(s: NLSignal, *, match_count: int = 0) -> SignalResponse:
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
        match_count=match_count,
        created_at=s.created_at,
        updated_at=s.updated_at,
    )


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, default=str, separators=(",", ":"))


def _ts(value: Any) -> str:
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _row_to_signal(row: Any) -> tuple[NLSignal, int]:
    """Convert a DB row to ``(NLSignal, match_count)``.

    Defensive against null/malformed ``rule`` JSONB so a single bad
    row cannot take down ``GET /signals`` (LP-13).
    """
    raw = row["rule"] if hasattr(row, "__getitem__") else None
    if hasattr(row, "get"):
        raw = row.get("rule", raw)

    rule_dict: dict[str, Any]
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            parsed = {}
        rule_dict = parsed if isinstance(parsed, dict) else {}
    elif isinstance(raw, dict):
        rule_dict = raw
    else:
        rule_dict = {}

    scope_raw = rule_dict.get("scope") or {}
    scope = (
        {str(k): str(v) for k, v in scope_raw.items()}
        if isinstance(scope_raw, dict)
        else {}
    )
    keywords_raw = rule_dict.get("keywords") or []
    keywords = (
        [str(k) for k in keywords_raw]
        if isinstance(keywords_raw, list)
        else []
    )

    try:
        threshold = float(rule_dict.get("threshold", 0.0) or 0.0)
    except (TypeError, ValueError):
        threshold = 0.0
    try:
        window_hours = int(rule_dict.get("window_hours", 24) or 24)
    except (TypeError, ValueError):
        window_hours = 24

    rule = CompiledRule(
        metric=str(rule_dict.get("metric") or "custom"),
        op=str(rule_dict.get("op") or "=="),
        threshold=threshold,
        window_hours=window_hours,
        scope=scope,
        keywords=keywords,
    )

    def _get(key: str, default: Any = None) -> Any:
        if hasattr(row, "get"):
            return row.get(key, default)
        try:
            return row[key]
        except (KeyError, TypeError, IndexError):
            return default

    match_count_raw = _get("match_count", 0)
    try:
        match_count = int(match_count_raw or 0)
    except (TypeError, ValueError):
        match_count = 0

    created_by = _get("created_by")
    cluster_id = _get("cluster_id")
    signal = NLSignal(
        id=str(_get("id", "")),
        org_id=str(_get("org_id", "")),
        description=str(_get("description", "") or ""),
        rule=rule,
        enabled=bool(_get("enabled", True)),
        created_by=str(created_by) if created_by else None,
        created_at=_ts(_get("created_at", "")),
        updated_at=_ts(_get("updated_at", "")),
        cluster_id=str(cluster_id) if cluster_id else None,
    )
    return signal, match_count


# ── Routes ────────────────────────────────────────────────────────


@router.post(
    "/seed-defaults",
    response_model=SeedDefaultsResponse,
    summary="Seed the F35 default signal library for this org",
)
async def seed_default_signals(
    body: SeedDefaultsRequest = SeedDefaultsRequest(),
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> SeedDefaultsResponse:
    """Idempotent seed of the default NL signal library (F35)."""
    from eden.signals.defaults import seed_org_signals

    profile = body.profile or "standard"
    if profile not in ("minimal", "standard", "advanced"):
        raise HTTPException(status_code=400, detail="profile must be minimal|standard|advanced")
    user_id = str(user.get("id") or user.get("user_id") or user.get("sub") or "") or None
    try:
        result = await seed_org_signals(org_id, profile=profile, created_by=user_id)
    except Exception as exc:
        logger.exception("seed_default_signals failed org_id=%s", org_id)
        if _is_missing_relation(exc):
            raise HTTPException(
                status_code=503,
                detail="Signals storage unavailable (nl_signals migration pending)",
            ) from None
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Signals unavailable"),
        ) from None
    return SeedDefaultsResponse(
        count=result.count,
        skipped=result.skipped,
        profile=result.profile,
        signal_ids=list(result.signal_ids or []),
    )


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
    user_id = str(user.get("id") or user.get("user_id") or user.get("sub") or "")
    rule = compile_signal(body.description)
    signal_id = str(uuid.uuid4())
    cluster_id = signal_signature(body.description)
    try:
        pg = await get_postgres_client()
        await pg.execute(
            """
            INSERT INTO nl_signals
                (id, org_id, description, rule, enabled,
                 created_by, cluster_id)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
            """,
            signal_id, org_id, body.description,
            _json_dumps(rule.to_dict()), body.enabled,
            user_id or None, cluster_id,
        )
        row = await pg.fetchrow(
            f"""
            SELECT {_SELECT_COLS}
            FROM nl_signals WHERE id = $1
            """,
            signal_id,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("create_signal failed org_id=%s", org_id)
        if _is_missing_relation(exc):
            raise HTTPException(
                status_code=503,
                detail="Signals storage unavailable (nl_signals migration pending)",
            ) from None
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Signals unavailable"),
        ) from None

    if row is None:
        raise HTTPException(status_code=500, detail="signal vanished after insert")
    signal, match_count = _row_to_signal(row)
    return _signal_to_response(signal, match_count=match_count)


@router.get(
    "",
    response_model=SignalListResponse,
    summary="List signals for an org",
)
async def list_signals(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> SignalListResponse:
    # Auth dependency still runs; unused locals keep the signature
    # consistent with sibling org-scoped routes.
    _ = user
    try:
        pg = await get_postgres_client()
        rows = await pg.fetch(
            f"""
            SELECT {_SELECT_COLS}
            FROM nl_signals
            WHERE org_id = $1
            ORDER BY created_at DESC
            LIMIT 200
            """,
            org_id,
        )
    except Exception as exc:
        logger.exception("list_signals failed org_id=%s", org_id)
        # Missing table / transient DB → empty list (not 500) so the
        # Vercel proxy does not amplify FastAPI 500s (LP-13 / LP-21).
        if _is_missing_relation(exc):
            return SignalListResponse(signals=[])
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Signals unavailable"),
        ) from None

    signals: list[SignalResponse] = []
    for r in rows:
        try:
            signal, match_count = _row_to_signal(r)
            signals.append(_signal_to_response(signal, match_count=match_count))
        except Exception:
            logger.exception(
                "list_signals skipping malformed row org_id=%s", org_id,
            )
    return SignalListResponse(signals=signals)


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
    _ = user
    try:
        pg = await get_postgres_client()
        row = await pg.fetchrow(
            f"""
            SELECT {_SELECT_COLS}
            FROM nl_signals
            WHERE id = $1 AND org_id = $2
            """,
            signal_id, org_id,
        )
    except Exception as exc:
        logger.exception(
            "match_signal failed org_id=%s signal_id=%s", org_id, signal_id,
        )
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Signals unavailable"),
        ) from None

    if row is None:
        raise HTTPException(status_code=404, detail="signal not found")
    signal, _match_count = _row_to_signal(row)
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
    _ = user
    try:
        pg = await get_postgres_client()
        rows = await pg.fetch(
            f"""
            SELECT {_SELECT_COLS}
            FROM nl_signals
            WHERE org_id = $1
            """,
            org_id,
        )
    except Exception as exc:
        logger.exception("cluster_signals failed org_id=%s", org_id)
        if _is_missing_relation(exc):
            return ClusterResponse(clusters={})
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Signals unavailable"),
        ) from None

    signals: list[NLSignal] = []
    for r in rows:
        try:
            signal, _ = _row_to_signal(r)
            signals.append(signal)
        except Exception:
            logger.exception(
                "cluster_signals skipping malformed row org_id=%s", org_id,
            )
    clusterer = SignalClusterer(similarity_threshold=body.similarity_threshold)
    mapping = clusterer.cluster(signals)
    clusters: dict[str, list[str]] = {}
    for sid, cid in mapping.items():
        clusters.setdefault(cid, []).append(sid)
    return ClusterResponse(clusters=clusters)
