"""Phase 7.1b — Judges API.

Endpoints:

  POST /orgs/{org_id}/observability/judges/run
      Body: {trace_id, judge_names?, sync?}
      Action: look up the events for the trace, run the registered
              judges on each event, persist to judge_scores, return
              the resulting scores (sync) or a job id (async).

  GET /orgs/{org_id}/observability/judges
      Query: trace_id?, judge_name?, limit?, offset?
      Action: list judge_scores for the tenant, paginated.

  GET /orgs/{org_id}/observability/judges/{judge_run_id}
      Action: fetch one judge_score by id.

There is no async judge tailer yet. Every run executes inline and
returns the scores directly, regardless of the requested ``sync``
value — a ``sync=false`` request is coerced to sync (see
``X-Judges-Sync-Coerced`` response header) rather than 501ing.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    require_judges_run,
    require_path_org_access,
)
from eden.llmops.judges.base import JudgeScore
from eden.llmops.judges.registry import get_judge_registry
from eden.llmops.judges.runner import JudgeRunner
from eden.llmops.judges.schema import (
    JudgeListResponse,
    JudgeRunRequest,
    JudgeRunResponse,
    JudgeScoreResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/observability/judges",
    tags=["judges"],
    dependencies=[Depends(require_path_org_access)],
)

# ── helpers ────────────────────────────────────────────────────────

def _score_to_response(score: JudgeScore) -> JudgeScoreResponse:
    return JudgeScoreResponse(
        judge_name=score.judge_name,
        judge_version=score.judge_version,
        trace_id=score.trace_id,
        span_id=score.span_id,
        score=score.score,
        rationale=score.rationale,
        model=score.model,
        scored_at=score.scored_at,
        latency_ms=score.latency_ms,
        metadata=score.metadata,
    )

# Audit 2026-06-22 B1.20 — module-scope _LightEvent (was redefined each loop iteration).
class _LightEvent:
    __slots__ = (
        "event_id", "trace_id", "span_id", "event_type",
        "payload", "attributes", "tags", "source_format",
        "tenant_id",
    )

async def _fetch_events_for_trace(tenant_id: str, trace_id: str) -> list:
    """Read all telemetry_events for one (tenant, trace) from Postgres.

    Returns a list of ``TelemetryEvent``-shaped dicts. We don't
    reconstruct the full dataclass (the judges only need a few
    fields), but the shape mirrors the dataclass so judge code
    that does ``event.payload`` / ``event.event_type`` works as
    expected.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")
    rows = await client.fetch(
        """
        SELECT event_id, trace_id, span_id, event_type, payload,
               attributes, tags, source_format, tenant_id
        FROM telemetry_events
        WHERE tenant_id = $1 AND trace_id = $2
        ORDER BY timestamp ASC
        """,
        tenant_id,
        trace_id,
    )
    return [dict(r) for r in rows]

# ── POST /run ─────────────────────────────────────────────────────

@router.post("/run", response_model=JudgeRunResponse)
async def run_judges(
    body: JudgeRunRequest,
    response: Response,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> JudgeRunResponse:
    """Run the registered judges on a trace.

    There is no async judge tailer yet, so every run executes inline
    and returns the resulting scores in the response — regardless of
    the requested mode. If the caller asked for ``sync=false`` (i.e.
    "queue this and give me a job id"), we coerce to sync rather than
    501ing: the ``X-Judges-Sync-Coerced`` response header is set to
    ``true`` so callers can detect the coercion, and ``queued``/
    ``job_id`` in the body stay at their "ran inline" defaults
    (``False``/``None``).
    """
    await require_judges_run(org_id, payload)

    if not body.sync:
        logger.info(
            "judges_run_async_coerced_to_sync",
            extra={"org_id": org_id, "trace_id": body.trace_id},
        )
        response.headers["X-Judges-Sync-Coerced"] = "true"

    registry = get_judge_registry()

    # Restrict to the named judges if the caller asked.
    if body.judge_names:
        judges = [
            j
            for name in body.judge_names
            for j in [registry.get(name)]
            if j is not None
        ]
        if not judges:
            raise HTTPException(
                status_code=400,
                detail=f"No registered judges match {body.judge_names!r}",
            )
    else:
        judges = registry.all()

    events = await _fetch_events_for_trace(org_id, body.trace_id)
    if not events:
        return JudgeRunResponse(judge_runs=[], count=0)

    # Lazy-import the LLM client (avoids pulling OpenRouterClient at
    # import time when only judges listing is exercised).
    from eden.llm.client import OpenRouterClient
    try:
        llm_client = OpenRouterClient()
    except Exception:
        llm_client = None

    runner = JudgeRunner(llm_client=llm_client)
    all_scores: list[JudgeScore] = []
    for event in events:
        # Audit 2026-06-22 B1.20 — _LightEvent is module-scope; tenant_id
        # is selected by _fetch_events_for_trace (verified via DB column).
        ev = _LightEvent()
        for f in _LightEvent.__slots__:
            setattr(ev, f, event.get(f))
        applicable = [j for j in judges if j.matches(ev)]
        if not applicable:
            continue
        try:
            scores = await runner.run_for_event(ev, applicable, trace_id=body.trace_id)
        except Exception as exc:
            logger.warning(f"judge run failed for event {event.get('event_id')}: {exc}")
            continue
        all_scores.extend(scores)

    return JudgeRunResponse(
        judge_runs=[_score_to_response(s) for s in all_scores],
        count=len(all_scores),
    )

# ── GET / ──────────────────────────────────────────────────────────

@router.get("", response_model=JudgeListResponse)
async def list_judge_scores(
    org_id: str = Depends(require_path_org_access),
    trace_id: str | None = Query(None),
    judge_name: str | None = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
) -> JudgeListResponse:
    """List judge_scores for the tenant, optionally filtered by trace_id
    and/or judge_name."""
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    where = "tenant_id = $1"
    params: list = [org_id]
    if trace_id:
        params.append(trace_id)
        where += f" AND trace_id = ${len(params)}"
    if judge_name:
        params.append(judge_name)
        where += f" AND judge_name = ${len(params)}"

    rows = await client.fetch(
        f"""
        SELECT judge_run_id, judge_name, judge_version, trace_id, span_id,
               score, rationale, model, scored_at, latency_ms,
               source_event_id, tenant_id
        FROM judge_scores
        WHERE {where}
        ORDER BY scored_at DESC
        LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
        """,
        *params,
        limit,
        offset,
    )
    total = await client.fetchval(
        f"SELECT count(*) FROM judge_scores WHERE {where}", *params
    )
    return JudgeListResponse(
        scores=[
            JudgeScoreResponse(
                judge_run_id=str(r["judge_run_id"]),
                judge_name=r["judge_name"],
                judge_version=r["judge_version"],
                trace_id=r["trace_id"],
                span_id=r["span_id"],
                score=r["score"],
                rationale=r["rationale"],
                model=r["model"],
                scored_at=r["scored_at"],
                latency_ms=r["latency_ms"] or 0.0,
                metadata={"source_event_id": r["source_event_id"]},
            )
            for r in rows
        ],
        total=total or 0,
        limit=limit,
        offset=offset,
    )

# ── GET /{judge_run_id} ────────────────────────────────────────────

@router.get("/{judge_run_id}", response_model=JudgeScoreResponse)
async def get_judge_score(
    org_id: str = Depends(require_path_org_access),
    judge_run_id: str = Path(..., description="The judge score id"),
    user: dict = Depends(get_current_user),
) -> JudgeScoreResponse:
    """Fetch a single judge_score by id."""
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")
    row = await client.fetchrow(
        """
        SELECT judge_run_id, judge_name, judge_version, trace_id, span_id,
               score, rationale, model, scored_at, latency_ms,
               source_event_id, tenant_id
        FROM judge_scores
        WHERE tenant_id = $1 AND judge_run_id = $2
        """,
        org_id,
        judge_run_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="judge score not found")
    return JudgeScoreResponse(
        judge_run_id=str(row["judge_run_id"]),
        judge_name=row["judge_name"],
        judge_version=row["judge_version"],
        trace_id=row["trace_id"],
        span_id=row["span_id"],
        score=row["score"],
        rationale=row["rationale"],
        model=row["model"],
        scored_at=row["scored_at"],
        latency_ms=row["latency_ms"] or 0.0,
        metadata={"source_event_id": row["source_event_id"]},
    )
