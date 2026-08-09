"""Intelligence Gap — Time-Travel Debugging (Cat 20, v1.3) routes.

Real implementations (2026-06-11):

* ``POST /fork``    — branch a trace at step N, producing
  a new ``fork_id`` that inherits the cached payload of
  steps 1..N-1.
* ``POST /replay``  — serve steps 1..N-1 from cache
  (0 tokens, 0 ms) and execute step N live through the
  AIGateway; emit the side-by-side diff + the
  tokens_saved / cost_saved_usd metrics.
* ``GET  /diff/{fork_id}/{replay_id}`` — side-by-side
  comparison of the original and replayed timelines.
* ``GET  /forks``   — list the org's forks for a given
  parent trace (the "forks of this trace" panel).

Gates:
* ``intelligence_gap_v0`` umbrella flag
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth

See ``docs/observability-gap/20-time-travel-debugging.md``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag, require_path_org_access
from eden.time_travel._common import _json_dumps, _upsert_fork_branch

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/time-travel",
    tags=["intelligence-time-travel"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


# ─── Schemas ───────────────────────────────────────────────────────


class ForkRequest(BaseModel):
    parent_trace_id: str = Field(..., description="The trace being forked.")
    fork_at_step: int = Field(
        ...,
        description="The step index to fork at. " "Steps 1..fork_at_step-1 are served from cache.",
    )
    name: str = Field(..., description="Customer-facing fork name.")
    parent_fork_id: str | None = Field(
        None,
        description="NULL for the first fork; non-NULL for fork-of-fork.",
    )
    edits: dict[str, Any] | None = Field(
        None,
        description="Per-step edits (format: step_<n>.<key>).",
    )


class RecordSnapshotRequest(BaseModel):
    """Body for ``POST /record`` (Phase A.7).

    Records a snapshot of ``trace_id`` so a later ``POST /fork`` can
    branch from it. The snapshot is stored in the same
    ``trace_fork_branches`` table as a synthetic fork with
    ``fork_at_step = -1`` (sentinel for "record only, no replay yet").
    """

    trace_id: str = Field(..., min_length=1, max_length=128)
    label: str | None = Field(None, max_length=128)
    parent_fork_id: str | None = Field(
        None,
        description="NULL for the first fork; non-NULL for fork-of-fork.",
    )
    edits: dict[str, Any] | None = Field(
        None,
        description="Per-step edits (format: step_<n>.<key>).",
    )


class ReplayRequest(BaseModel):
    fork_id: str = Field(..., description="The fork's customer-facing id.")
    edits: dict[str, Any] = Field(
        default_factory=dict,
        description="Per-step edits (format: step_<n>.<key>).",
    )


# ─── Routes ────────────────────────────────────────────────────────


@router.post("/record")
async def record_snapshot(
    org_id: str = Depends(require_path_org_access),
    body: RecordSnapshotRequest = Body(...),
) -> dict[str, Any]:
    """Record a snapshot of ``trace_id`` so it can be replayed later.

    Stores a row in ``trace_fork_branches`` with ``fork_at_step = -1``
    (sentinel meaning "recording only, not yet replayed"). The portal's
    ``timeTravelApi.record`` method calls this — before this endpoint
    existed, the "Record snapshot" button on /inspector was a no-op.

    Returns ``{snapshot_id, trace_id, label, created_at}``. The
    snapshot_id is what a later ``POST /fork`` would reference as
    ``parent_fork_id`` to branch from.
    """
    import uuid as _uuid
    from datetime import UTC, datetime

    from eden.storage.postgres import get_postgres_client

    if await get_postgres_client() is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    snapshot_id = f"ttrec_{_uuid.uuid4().hex[:16]}"
    label = body.label or f"snapshot:{body.trace_id}"
    try:
        await _upsert_fork_branch(
            org_id=org_id,
            fork_id=snapshot_id,
            parent_trace_id=body.trace_id,
            parent_fork_id=body.parent_fork_id,
            fork_at_step=-1,
            name=label,
            edits_json=_json_dumps(body.edits or {}),
        )
    except AttributeError as exc:
        raise HTTPException(status_code=503, detail="Postgres unavailable") from exc
    except Exception as exc:
        msg = str(exc).lower()
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(status_code=400, detail="Invalid organization id") from exc
        if "foreign key" in msg:
            raise HTTPException(status_code=404, detail="Organization not found") from exc
        raise HTTPException(status_code=503, detail="Failed to record snapshot") from exc
    created_at = datetime.now(UTC)
    return {
        "snapshot_id": snapshot_id,
        "trace_id": body.trace_id,
        "label": body.label,
        "created_at": created_at.isoformat(),
        "status": "ok",
        "live": True,
    }


@router.post("/fork")
async def fork(
    org_id: str = Depends(require_path_org_access),
    body: ForkRequest = Body(...),
) -> dict[str, Any]:
    """Branch a trace at step N, producing a new fork_id.

    The :class:`TraceForker` writes one row to
    ``trace_fork_branches`` with the fork metadata. The
    replayer serves steps 1..N-1 from cache when the
    parent has cacheable steps.
    """
    from eden.time_travel import TraceForker

    return await TraceForker().fork(
        org_id,
        parent_trace_id=body.parent_trace_id,
        fork_at_step=body.fork_at_step,
        name=body.name,
        parent_fork_id=body.parent_fork_id,
        edits=body.edits,
    )


@router.post("/replay")
async def replay(
    org_id: str = Depends(require_path_org_access),
    body: ReplayRequest = Body(...),
) -> dict[str, Any]:
    """Replay the fork with per-step edits.

    The "killer query" per the appendix. Serves steps
    1..N-1 from cache (0 tokens, 0 ms) and executes step
    N live through the AIGateway. Emits the side-by-side
    diff + the tokens_saved / cost_saved_usd metrics.
    """
    from eden.config import get_settings

    if not getattr(get_settings(), "time_travel_replay_enabled", False):
        # Disabled 2026-07-30. This endpoint never re-executed anything:
        # the recorder stores no prompt content, so the replayer
        # short-circuits and hands back the ORIGINAL response hash while
        # reporting re_executed=True. Answering 503 is strictly better
        # than answering confidently and wrongly — a user who sees an
        # unchanged hash concludes their prompt edit had no effect.
        # See config.time_travel_replay_enabled and
        # docs/ops/disabled-features.md.
        raise HTTPException(
            status_code=503,
            detail=(
                "Time-travel replay is temporarily disabled while the "
                "recorder is fixed to persist prompt content. Forks and "
                "recorded timelines are unaffected."
            ),
        )

    from eden.time_travel import TraceReplayer

    return await TraceReplayer().replay_from(
        org_id,
        fork_id=body.fork_id,
        edits=body.edits,
    )


@router.get("/diff/{fork_id}/{replay_id}")
async def diff(
    org_id: str = Depends(require_path_org_access),
    fork_id: str = Path(...),
    replay_id: str = Path(...),
) -> dict[str, Any]:
    """Side-by-side comparison of the original and replayed timelines.

    The :class:`ReplayDiff` reads from
    ``trace_fork_branches`` + the parent trace's
    ``telemetry_events`` + the replay's
    ``trace_replay_steps`` rows and renders the per-step
    + per-key diff.
    """
    from eden.time_travel import ReplayDiff

    return await ReplayDiff().diff(
        org_id,
        fork_id=fork_id,
        replay_id=replay_id,
    )


@router.get("/forks")
async def list_forks(
    org_id: str = Depends(require_path_org_access),
    parent_trace_id: str = Query(..., description="The parent trace id."),
) -> dict[str, Any]:
    """List the org's forks for a given parent trace.

    The "forks of this trace" panel. Sorted by
    ``created_at DESC`` (newest first).
    """
    from eden.storage.postgres import get_postgres_client
    from eden.time_travel._common import _list_forks_for_trace

    if await get_postgres_client() is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    try:
        forks = await _list_forks_for_trace(parent_trace_id=parent_trace_id, org_id=org_id)
    except AttributeError as exc:
        raise HTTPException(status_code=503, detail="Postgres unavailable") from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Failed to list forks") from exc
    # Always return the live envelope shape (mirrors the
    # rest of the intelligence surface).
    return {
        "status": "ok",
        "feature": "TraceForker",
        "live": True,
        "data": {
            "parent_trace_id": parent_trace_id,
            "forks": forks,
            "n_forks": len(forks),
        },
    }


@router.get("/steps")
async def list_parent_steps(
    org_id: str = Depends(require_path_org_access),
    parent_trace_id: str = Query(..., description="The parent trace id."),
) -> dict[str, Any]:
    """List recorded ``agent.step`` rows for a trace (Cat 20 timeline).

    Powers the portal Time travel scrubber so fork_at uses the same
    indices the replayer walks, and surfaces cacheable / replayable
    status for each step across a whole agent run.
    """
    from eden.storage.postgres import get_postgres_client
    from eden.time_travel._common import (
        _get_parent_steps,
        _step_has_replayable_prompt,
    )

    if await get_postgres_client() is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    try:
        steps = await _get_parent_steps(
            parent_trace_id=parent_trace_id, org_id=org_id
        )
    except AttributeError as exc:
        raise HTTPException(status_code=503, detail="Postgres unavailable") from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Failed to list steps") from exc

    serialized: list[dict[str, Any]] = []
    n_replayable = 0
    n_cacheable = 0
    for step in steps:
        _payload = step.get("payload")
        payload = _payload if isinstance(_payload, dict) else {}
        _request = payload.get("request")
        request = _request if isinstance(_request, dict) else {}
        _attrs = step.get("attributes")
        attrs = _attrs if isinstance(_attrs, dict) else {}
        _response = payload.get("response")
        response = _response if isinstance(_response, dict) else {}
        cacheable = bool(attrs.get("cacheable"))
        replayable = _step_has_replayable_prompt(step)
        if cacheable:
            n_cacheable += 1
        if replayable:
            n_replayable += 1
        model = request.get("model") or response.get("model") or ""
        prompt = request.get("prompt") or payload.get("prompt") or ""
        prompt_preview = ""
        if isinstance(prompt, str) and prompt.strip():
            prompt_preview = prompt.strip()[:240]
        elif isinstance(request.get("messages"), list) and request["messages"]:
            first = request["messages"][0]
            if isinstance(first, dict):
                content = first.get("content")
                if isinstance(content, str):
                    prompt_preview = content.strip()[:240]
        serialized.append(
            {
                "step_index": int(step.get("step_index") or 0),
                "event_id": step.get("event_id"),
                "span_id": step.get("span_id"),
                "timestamp": step.get("timestamp"),
                "duration_ms": step.get("duration_ms"),
                "model": model or None,
                "cacheable": cacheable,
                "replayable": replayable,
                "response_hash": step.get("response_hash") or "",
                "tokens_used": int(response.get("tokens_used") or 0),
                "cost_usd": float(response.get("cost_usd") or 0.0),
                "prompt_preview": prompt_preview or None,
            }
        )

    return {
        "status": "ok",
        "feature": "TraceRecorder",
        "live": True,
        "data": {
            "parent_trace_id": parent_trace_id,
            "steps": serialized,
            "n_steps": len(serialized),
            "n_cacheable": n_cacheable,
            "n_replayable": n_replayable,
            "ready_for_live_replay": n_replayable > 0,
        },
    }
