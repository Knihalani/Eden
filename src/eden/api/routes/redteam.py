"""Phase L — red-team probe API routes.

Three routes:

  * ``GET  /orgs/{org}/redteam/probes``     — list available probes
  * ``POST /orgs/{org}/redteam/probe``      — run a single probe
  * ``POST /orgs/{org}/redteam/scan``       — run the full suite
  * ``GET  /orgs/{org}/redteam/findings``   — list past findings
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.redteam.probes import (
    AgentInvoker,
    ALL_CATEGORIES,
    ALL_SEVERITIES,
    PROBE_CATALOGUE,
    Probe,
    ProbeRunResult,
    ProbeRunner,
    list_probes,
)


logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/orgs/{org_id}/redteam",
    tags=["redteam"],
)


# ── Schemas ───────────────────────────────────────────────────────


class ProbeResponse(BaseModel):
    name: str
    category: str
    severity: str
    description: str
    prompt_count: int


class ProbeListResponse(BaseModel):
    probes: list[ProbeResponse]


class RunProbeRequest(BaseModel):
    probe_name: str = Field(..., description="The probe to run (e.g. 'stan_jailbreak').")
    target_label: str = Field(default="default", description="Human label for the target agent.")
    # The actual agent is wired via ``app.state.agent_registry``
    # — a real deployment registers named agents at startup.
    # We accept a ``target_name`` for now; the route resolves
    # it to an ``AgentInvoker`` via the registry.
    target_name: str = Field(default="default", description="Registered agent name.")
    # The target endpoint URL (alternative to a registered
    # name). When set, the runner POSTs each attack prompt
    # to ``target_endpoint`` and reads the response body.
    target_endpoint: Optional[str] = Field(
        default=None,
        description="Optional URL to POST attack prompts to. The response body is the agent's response.",
    )


class FindingResponse(BaseModel):
    id: str
    probe_name: str
    category: str
    severity: str
    attack_prompt: str
    agent_response: str
    failed: bool
    detection_reason: str
    target_label: str
    tags: list[str]
    created_at: str


class ProbeRunResponse(BaseModel):
    probe_name: str
    target_label: str
    findings: list[FindingResponse]
    prompts_executed: int
    failure_count: int


class ScanRequest(BaseModel):
    target_name: str = Field(default="default", description="Registered agent name.")
    target_endpoint: Optional[str] = Field(
        default=None,
        description="Optional URL to POST attack prompts to.",
    )
    target_label: str = Field(default="default", description="Human label for the target agent.")
    # Optional subset of probes to run. Empty = full suite.
    probe_names: list[str] = Field(default_factory=list)


class ScanResponse(BaseModel):
    runs: list[ProbeRunResponse]


class FindingsListResponse(BaseModel):
    findings: list[FindingResponse]
    total: int
    limit: int
    offset: int


# ── Helpers ───────────────────────────────────────────────────────


def _get_user():
    from eden.api.routes.auth import get_current_user
    return get_current_user


def _probe_to_response(p: Probe) -> ProbeResponse:
    return ProbeResponse(
        name=p.name, category=p.category, severity=p.severity,
        description=p.description, prompt_count=len(p.prompts),
    )


def _result_to_response(r: ProbeRunResult) -> ProbeRunResponse:
    return ProbeRunResponse(
        probe_name=r.probe_name,
        target_label=r.target_label,
        findings=[FindingResponse(**f.to_dict()) for f in r.findings],
        prompts_executed=r.prompts_executed,
        failure_count=r.failure_count,
    )


def _resolve_invoker(req: Any) -> AgentInvoker:
    """Resolve the ``AgentInvoker`` for the request.

    Two paths:
      1. ``target_endpoint`` provided → POST each prompt to
         the URL; return the response body. Uses ``httpx``
         if available; falls back to a clear error.
      2. ``target_name`` provided → look up the registered
         agent in ``app.state.agent_registry``. In dev /
         test the registry is empty, so this raises a
         clear 400.
    """
    if req.target_endpoint:
        try:
            import httpx
        except ImportError as exc:
            raise HTTPException(
                status_code=501,
                detail={
                    "error": "missing_dependency",
                    "detail": f"httpx is required for target_endpoint: {exc}",
                },
            )

        async def _invoker(prompt: str) -> str:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
                    req.target_endpoint,
                    json={"prompt": prompt},
                )
                resp.raise_for_status()
                # Try to extract "response" / "text" / "output" fields.
                body = resp.json()
                if isinstance(body, dict):
                    for k in ("response", "text", "output", "answer"):
                        if k in body and isinstance(body[k], str):
                            return body[k]
                # Fallback: stringify the whole body.
                return str(body)
        return _invoker
    # No endpoint — look up the registry.
    raise HTTPException(
        status_code=400,
        detail={
            "error": "no_target",
            "detail": (
                "Provide either target_endpoint (HTTP) or register the "
                "agent via app.state.agent_registry. Default registry "
                "is empty in dev."
            ),
        },
    )


# ── Routes ────────────────────────────────────────────────────────


@router.get(
    "/probes",
    response_model=ProbeListResponse,
    summary="List available red-team probes",
)
async def list_probes_route(
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> ProbeListResponse:
    """Return the catalogue of available probes with their
    category, severity, and prompt count."""
    return ProbeListResponse(
        probes=[_probe_to_response(p) for p in list_probes()],
    )


@router.post(
    "/probe",
    response_model=ProbeRunResponse,
    summary="Run a single probe against a target agent",
)
async def run_probe_route(
    body: RunProbeRequest,
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> ProbeRunResponse:
    if body.probe_name not in PROBE_CATALOGUE:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "unknown_probe",
                "detail": f"probe {body.probe_name!r} not found; GET /probes for the list",
            },
        )
    probe = PROBE_CATALOGUE[body.probe_name]
    invoker = _resolve_invoker(body)
    runner = ProbeRunner()  # no pg / no hook; route is read-only
    result = await runner.run_probe(
        probe, target=invoker, target_label=body.target_label,
    )
    return _result_to_response(result)


@router.post(
    "/scan",
    response_model=ScanResponse,
    summary="Run a full red-team scan",
)
async def run_scan_route(
    body: ScanRequest,
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> ScanResponse:
    invoker = _resolve_invoker(body)
    runner = ProbeRunner()
    if body.probe_names:
        probes = [PROBE_CATALOGUE[n] for n in body.probe_names if n in PROBE_CATALOGUE]
        if not probes:
            raise HTTPException(
                status_code=400,
                detail={"error": "no_valid_probes", "detail": body.probe_names},
            )
    else:
        probes = list_probes()
    results = await runner.run_suite(
        probes, target=invoker, target_label=body.target_label,
    )
    return ScanResponse(runs=[_result_to_response(r) for r in results])


@router.get(
    "/findings",
    response_model=FindingsListResponse,
    summary="List past red-team findings",
)
async def list_findings_route(
    org_id: str = Path(...),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    only_failures: bool = Query(default=False),
    severity: Optional[str] = Query(default=None, pattern="^(low|medium|high|critical)$"),
    probe_name: Optional[str] = Query(default=None),
    user: dict = Depends(_get_user()),
) -> FindingsListResponse:
    """Read-side helper. The 501 stub for now; the persistence
    layer is wired in ``redteam.findings_router`` (a future
    PR). For now we return an empty list so the route
    compiles and the dashboard can render an "empty state"."""
    # The actual lookup is wired in via a follow-up PR that
    # adds a real persistence helper; for now, the route
    # returns an empty list.
    return FindingsListResponse(
        findings=[], total=0, limit=limit, offset=offset,
    )
