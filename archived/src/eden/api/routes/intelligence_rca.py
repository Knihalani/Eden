"""Intelligence Gap — RCA & Incidents (Cat 2) routes.

Tier-aware reads: trace events are fetched via
:func:`eden.insights.rca._common._fetch_trace_events`, which serves hot
Postgres within ``warm_days`` and cold-archive rehydrate past that window
(OPT-61 / cold tier).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel, Field

from eden.api.deps import (
    get_current_user,
    require_feature_flag,
    require_org_admin,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.insights.incidents.clusterer import IncidentClusterer, IncidentStore
from eden.insights.rca._common import (
    _fetch_trace_events,
    _not_found_envelope,
    _ok_envelope,
    _resolve_incident_cluster,
    event_is_failure,
)
from eden.insights.rca.analyzer import RootCauseAnalyzer
from eden.services.observability import get_a2a_service

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/rca",
    tags=["intelligence-rca"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

_rca = RootCauseAnalyzer()
_clusterer = IncidentClusterer()
_store = IncidentStore()
_a2a = get_a2a_service()

#: Bound on how many delegation hops ``_fetch_delegation_ancestors`` will
#: walk. A misbehaving/duplicated ``a2a_links`` row could otherwise create
#: an unbounded (or cyclic) walk; ``_fetch_delegation_ancestors`` also
#: guards against revisiting a trace_id, but the depth cap is a cheap
#: belt-and-suspenders bound on cost (each hop is a DB round-trip + an
#: events fetch).
_MAX_DELEGATION_DEPTH = 5


class ClusterRequest(BaseModel):
    window: str = "24h"
    min_cluster_size: int = 3


class ResolveIncidentRequest(BaseModel):
    note: str = Field(default="", max_length=2000)


@router.post("/{trace_id}/analyze")
async def analyze(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _rca.categorize(org_id, trace_id)


@router.get("/{trace_id}/explain")
async def explain(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    return await _rca.explain(org_id, trace_id)


def _event_error_type(ev: dict[str, Any]) -> str | None:
    et_col = ev.get("error_type")
    if isinstance(et_col, str) and et_col.strip():
        return et_col
    err = ev.get("error")
    if isinstance(err, dict):
        t = err.get("type")
        return str(t) if t is not None else None
    return None


def _event_delegation_info(ev: dict[str, Any]) -> dict[str, Any] | None:
    """Extract A2A delegation hints carried on one event's ``attributes``.

    The A2A auto-instrumentation SDK (``eden.sdk.a2a.wrap_a2a_invocation`` /
    ``build_a2a_attributes``) merges ``parent_agent_span_id`` +
    ``child_agent_trace_id`` + an ``a2a.*`` sub-document into the active
    span's ``attributes`` JSON at ingest time (see migration 058 +
    ``TelemetryEvent.parent_agent_span_id``/``child_agent_trace_id`` for the
    dedicated ``telemetry_events`` columns those same values are also
    persisted to). ``_fetch_trace_events``'s column set does not select
    those dedicated columns, so ``attributes`` is the only per-event place
    this data is available to route code — this mirrors the field-access
    pattern used elsewhere in this module (e.g. the PII/prompt-injection
    sniff reads ``ev.get("attributes")`` the same way).

    Returns ``None`` when the event carries no delegation metadata (the
    overwhelming majority of spans, which aren't A2A call boundaries).
    """
    attrs = ev.get("attributes")
    if not isinstance(attrs, dict):
        return None
    parent_agent_span_id = attrs.get("parent_agent_span_id")
    child_agent_trace_id = attrs.get("child_agent_trace_id")
    a2a = attrs.get("a2a")
    a2a = a2a if isinstance(a2a, dict) else {}
    if not (parent_agent_span_id or child_agent_trace_id or a2a):
        return None
    return {
        "parent_agent_span_id": (
            str(parent_agent_span_id) if parent_agent_span_id is not None else None
        ),
        "child_agent_trace_id": (
            str(child_agent_trace_id) if child_agent_trace_id is not None else None
        ),
        "parent_agent_id": a2a.get("parent_agent_id"),
        "child_agent_id": a2a.get("child_agent_id"),
        "invocation_type": a2a.get("invocation_type"),
    }


async def _fetch_delegation_ancestors(
    org_id: str,
    trace_id: str,
    *,
    max_depth: int = _MAX_DELEGATION_DEPTH,
) -> list[dict[str, Any]]:
    """Walk the ``a2a_links`` parent chain upward from ``trace_id``.

    This is deliberately distinct from the within-trace ``parent_span_id``
    tree ``_build_causal_chain`` walks: each hop here is a real *cross-trace*
    delegation edge recorded by the A2A SDK (a row in ``a2a_links``, written
    by ``eden.sdk.a2a.wrap_a2a_invocation`` via
    ``A2ALinkService.register_link``) — i.e. "this trace's root agent was
    invoked by span X in some OTHER agent's trace".

    For each ancestor hop we also re-fetch that ancestor trace's own events
    (thin — we only need span structure, not payload bodies) so we can tell
    whether the *parent agent's* delegating span itself shows a failure as a
    consequence of the child's failure, i.e. whether the blast radius
    propagated upward through the delegation chain rather than staying
    contained to the child trace.

    Best-effort: any DB/service failure yields ``[]`` (matches the rest of
    this module's "never 500 the RCA view over a telemetry gap" posture).
    Bounded by ``max_depth`` hops and guarded against cycles — a
    duplicated/misrouted link row could otherwise loop forever.
    """
    ancestors: list[dict[str, Any]] = []
    seen_trace_ids: set[str] = {trace_id}
    current_trace_id = trace_id

    for _ in range(max_depth):
        try:
            links = await _a2a.get_links_for_trace(current_trace_id, org_id=org_id)
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("rca_chain: get_links_for_trace failed: %s", redact_all(str(exc)))
            break

        parent_links = links.get("parent") or []
        if not parent_links:
            break
        # A trace can in principle have >1 inbound delegation row (retries,
        # re-parenting); earliest-created (``ORDER BY created_at ASC`` in
        # ``get_links_for_trace``) wins so the chain is deterministic.
        link = parent_links[0]
        parent_trace_id = link.get("parent_trace_id")
        parent_span_id = link.get("parent_span_id")
        if not parent_trace_id or parent_trace_id in seen_trace_ids:
            break
        seen_trace_ids.add(parent_trace_id)

        try:
            parent_events = await _fetch_trace_events(
                org_id, parent_trace_id, thin=True
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("rca_chain: ancestor events fetch failed: %s", redact_all(str(exc)))
            parent_events = []

        delegating_span_failed = False
        delegating_span_error_type: str | None = None
        for pev in parent_events:
            if str(pev.get("span_id")) == str(parent_span_id):
                delegating_span_failed = event_is_failure(pev)
                delegating_span_error_type = _event_error_type(pev)
                break

        ancestors.append(
            {
                "trace_id": str(parent_trace_id),
                "span_id": str(parent_span_id) if parent_span_id else None,
                "parent_agent_id": link.get("parent_agent_id"),
                "child_agent_id": link.get("child_agent_id"),
                "invocation_type": link.get("invocation_type"),
                "response_status": link.get("response_status"),
                "error_kind": link.get("error_kind"),
                # Did the PARENT agent's own delegating span also fail —
                # i.e. did this child's failure propagate upward?
                "delegating_span_failed": delegating_span_failed,
                "delegating_span_error_type": delegating_span_error_type,
            }
        )
        current_trace_id = str(parent_trace_id)

    return ancestors


def _cross_agent_root_cause(
    trace_id: str,
    local_root_cause_span_id: str | None,
    delegation_chain: list[dict[str, Any]],
) -> dict[str, Any]:
    """Pick the outermost ancestor whose delegating span also failed.

    ``delegation_chain`` is ordered immediate-parent-first. Walk it outward
    (toward the root agent) while each hop's delegating span still shows a
    failure — the last such hop is the furthest point the blast radius
    reaches, i.e. the practical "start of the incident" from a debugging
    engineer's point of view. Stops (and falls back to the local trace's own
    ``root_cause_span_id``) at the first ancestor whose delegating span did
    *not* fail, or immediately if there's no delegation chain at all.
    """
    origin_trace_id = trace_id
    origin_span_id = local_root_cause_span_id
    for hop in delegation_chain:
        if not hop.get("delegating_span_failed"):
            break
        origin_trace_id = hop["trace_id"]
        origin_span_id = hop["span_id"]
    return {"trace_id": origin_trace_id, "span_id": origin_span_id}


def _build_causal_chain(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Turn an ordered trace-event list into a deep-linkable causal chain.

    ``_fetch_trace_events`` already returns events ordered by ``timestamp``
    ascending, so index order *is* execution order. Each node carries the
    ``span_id`` / ``parent_span_id`` a UI needs to deep-link, plus an
    ``implicated`` flag set when the step errored. ``implicated_span_ids`` is
    the ordered, de-duplicated list of failing spans; ``root_cause_span_id``
    is the first failure (earliest-failure-wins).

    Honest limitation: ordering is *temporal*, and implication is "this span
    errored", not a proven data-dependency graph — ``parent_span_id`` is
    surfaced so the UI can render the actual span tree.
    """
    chain: list[dict[str, Any]] = []
    implicated: list[str] = []
    for step, ev in enumerate(events):
        span_id = ev.get("span_id")
        span_id = str(span_id) if span_id is not None else None
        failed = event_is_failure(ev)
        chain.append(
            {
                "step": step,
                "span_id": span_id,
                "parent_span_id": (
                    str(ev.get("parent_span_id"))
                    if ev.get("parent_span_id") is not None
                    else None
                ),
                "agent_id": ev.get("agent_id"),
                "event_type": ev.get("event_type"),
                "name": ev.get("name"),
                "outcome": ev.get("outcome"),
                "error_type": _event_error_type(ev),
                "implicated": failed,
                "delegation": _event_delegation_info(ev),
            }
        )
        if failed and span_id and span_id not in implicated:
            implicated.append(span_id)
    return {
        "causal_chain": chain,
        "implicated_span_ids": implicated,
        "root_cause_span_id": implicated[0] if implicated else None,
        "span_count": len(chain),
    }


@router.get("/{trace_id}/chain")
async def rca_chain(
    org_id: str = Depends(require_path_org_access),
    trace_id: str = Path(...),
) -> dict[str, Any]:
    """Per-trace RCA chain: implicated span_ids + ordered causal chain.

    Reuses the same ``RootCauseAnalyzer`` engine as ``/analyze`` for the
    failure category/confidence, then overlays the deep-linkable span chain
    derived from the trace's telemetry events so a UI can jump straight to
    the implicated spans.

    Also walks *cross-agent* delegation links (``a2a_links``, populated by
    ``eden.sdk.a2a.wrap_a2a_invocation``) upward from this trace so a
    failing child-agent span's causal chain doesn't stop at the edge of its
    own trace: ``delegation_chain`` is the ordered (immediate-parent-first)
    list of ancestor agent hops, and ``cross_agent_root_cause`` names the
    furthest-back ancestor whose own delegating span also failed — i.e. the
    practical start of the incident when a failure cascades through a
    delegation chain rather than staying contained to one agent's trace.

    Fetches the trace's events once (full column set — the engine's rule
    table needs ``payload``/``attributes``, so we can't use the ``thin``
    variant here) and passes them into ``categorize`` so it doesn't re-run
    the same query a second time within this request.
    """
    events = await _fetch_trace_events(org_id, trace_id)
    if not events:
        return _not_found_envelope(_rca.name, trace_id=trace_id)

    # Reuse the engine for classification (category / confidence / signals),
    # passing the events we already fetched to avoid a redundant re-fetch.
    categorized = await _rca.categorize(org_id, trace_id, events=events)
    cat_data = categorized.get("data") or {}

    chain = _build_causal_chain(events)
    delegation_chain = await _fetch_delegation_ancestors(org_id, trace_id)
    cross_agent_root_cause = _cross_agent_root_cause(
        trace_id, chain.get("root_cause_span_id"), delegation_chain
    )
    return _ok_envelope(
        _rca.name,
        {
            "trace_id": trace_id,
            "category": cat_data.get("category"),
            "confidence": cat_data.get("confidence"),
            "signals": cat_data.get("signals", []),
            **chain,
            "delegation_chain": delegation_chain,
            "cross_agent_root_cause": cross_agent_root_cause,
        },
    )


@router.post("/incidents/cluster")
async def cluster(
    org_id: str = Depends(require_path_org_access),
    body: ClusterRequest = Body(...),
) -> dict[str, Any]:
    return await _clusterer.cluster(
        org_id,
        window=body.window,
        min_cluster_size=body.min_cluster_size,
    )


@router.get("/incidents/{cluster_id}/summarize")
async def summarize_cluster(
    org_id: str = Depends(require_path_org_access),
    cluster_id: str = Path(...),
) -> dict[str, Any]:
    return await _clusterer.summarize(org_id, cluster_id)


@router.post("/incidents/{cluster_id}/resolve")
async def resolve_incident(
    org_id: str = Depends(require_path_org_access),
    cluster_id: str = Path(...),
    body: ResolveIncidentRequest = Body(default_factory=ResolveIncidentRequest),
    _admin: dict = Depends(require_org_admin),
) -> dict[str, Any]:
    """Mark an incident cluster as resolved."""
    result = await _resolve_incident_cluster(
        org_id, cluster_id, note=body.note or "Marked resolved via portal"
    )
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Incident cluster not found",
        )
    return result


@router.get("/incidents")
async def list_incidents(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(50, ge=1, le=200),
    severity: str | None = None,
) -> dict[str, Any]:
    return await _store.list(org_id, limit=limit, severity=severity)
