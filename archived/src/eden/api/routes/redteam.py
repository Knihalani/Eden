"""Phase L — red-team probe API routes.

Three routes:

  * ``GET  /orgs/{org}/redteam/probes``     — list available probes
  * ``POST /orgs/{org}/redteam/probe``      — run a single probe
  * ``POST /orgs/{org}/redteam/scan``       — run the full suite
  * ``GET  /orgs/{org}/redteam/findings``   — list past findings
"""

from __future__ import annotations

import ipaddress
import logging
import os
import socket
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from eden.api.deps import require_org_member, require_path_org_access
from eden.redteam.findings_store import FindingsStore
from eden.redteam.probes import (
    PROBE_CATALOGUE,
    AgentInvoker,
    Probe,
    ProbeRunner,
    ProbeRunResult,
    list_probes,
)

logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/orgs/{org_id}/redteam",
    tags=["redteam"],
    dependencies=[
        Depends(require_org_member),
        Depends(require_path_org_access),
    ],
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
    target_endpoint: str | None = Field(
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
    target_endpoint: str | None = Field(
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


def _validate_target_endpoint(url: str) -> None:
    """Reject SSRF-prone target endpoints (https-only, no private IPs).

    Mirrors ``webhook_delivery._assert_public_ip`` / webhook URL
    checks: HTTPS only, no userinfo, DNS must resolve, every
    resolved address must be public. Ambiguous / unresolved hosts
    fail closed. Optional ``EDEN_REDTEAM_ENDPOINT_ALLOWLIST``
    (comma-separated hostnames) further restricts targets when set.
    """
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="target_endpoint must use HTTPS",
        )
    if parsed.username is not None or parsed.password is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="target_endpoint must not include userinfo",
        )
    host = parsed.hostname
    if not host:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="target_endpoint must include a hostname",
        )
    allowlist_raw = os.environ.get("EDEN_REDTEAM_ENDPOINT_ALLOWLIST", "").strip()
    if allowlist_raw:
        allowed = {h.strip().lower() for h in allowlist_raw.split(",") if h.strip()}
        if host.lower() not in allowed:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="target_endpoint host is not in EDEN_REDTEAM_ENDPOINT_ALLOWLIST",
            )
    # Literal IP host — check directly. Hostname — resolve all A/AAAA.
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        ips = [literal]
    else:
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="target_endpoint hostname could not be resolved",
            ) from exc
        if not infos:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="target_endpoint hostname could not be resolved",
            )
        ips = []
        for info in infos:
            ip_str = info[4][0]
            try:
                ips.append(ipaddress.ip_address(ip_str))
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="target_endpoint hostname resolved to a non-IP address",
                ) from exc
    for ip in ips:
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="target_endpoint must point to a public IP address",
            )


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
        _validate_target_endpoint(req.target_endpoint)
        try:
            import httpx
        except ImportError as exc:
            raise HTTPException(
                status_code=503,
                detail={
                    "error": "missing_dependency",
                    "detail": f"httpx is required for target_endpoint: {exc}",
                },
            ) from exc

        async def _invoker(prompt: str) -> str:
            # Re-check at call time (DNS rebind / TOCTOU).
            _validate_target_endpoint(req.target_endpoint)
            async with httpx.AsyncClient(
                timeout=30,
                follow_redirects=False,
                trust_env=False,
            ) as client:
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
    org_id: str = Depends(require_path_org_access),
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
    org_id: str = Depends(require_path_org_access),
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
    from eden.storage.postgres import get_postgres_client

    pg = await get_postgres_client()
    store = FindingsStore(pg) if pg is not None else None
    runner = ProbeRunner()
    result = await runner.run_probe(
        probe, target=invoker, target_label=body.target_label,
    )
    if store is not None:
        for finding in result.findings:
            await store.insert(org_id, finding)
    return _result_to_response(result)


@router.post(
    "/scan",
    response_model=ScanResponse,
    summary="Run a full red-team scan",
)
async def run_scan_route(
    body: ScanRequest,
    org_id: str = Depends(require_path_org_access),
) -> ScanResponse:
    invoker = _resolve_invoker(body)
    from eden.storage.postgres import get_postgres_client

    pg = await get_postgres_client()
    store = FindingsStore(pg) if pg is not None else None
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
    if store is not None:
        for run in results:
            for finding in run.findings:
                await store.insert(org_id, finding)
    return ScanResponse(runs=[_result_to_response(r) for r in results])


@router.get(
    "/findings",
    response_model=FindingsListResponse,
    summary="List past red-team findings",
)
async def list_findings_route(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    only_failures: bool = Query(default=False),
    severity: str | None = Query(default=None, pattern="^(low|medium|high|critical)$"),
    probe_name: str | None = Query(default=None),
) -> FindingsListResponse:
    from eden.storage.postgres import get_postgres_client

    pg = await get_postgres_client()
    if pg is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database unavailable",
        )
    store = FindingsStore(pg)
    rows, total = await store.list_for_org(
        org_id,
        limit=limit,
        offset=offset,
        only_failures=only_failures,
        severity=severity,
        probe_name=probe_name,
    )
    return FindingsListResponse(
        findings=[FindingResponse(**row) for row in rows],
        total=total,
        limit=limit,
        offset=offset,
    )
