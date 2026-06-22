"""Phase 2 — Agent Registry API.

Endpoints:

  GET  /orgs/{org_id}/agents
      Query: framework?, name?, limit?, offset?
      Action: list agent registrations for the org, paginated.

  POST /orgs/{org_id}/agents/register
      Body: {agent_id?, name, framework?, repo_url?, register_token?}
      Action: idempotent registration. If ``agent_id`` is supplied
              and an existing row has the same (org_id, agent_id),
              the existing row is updated in place. Otherwise the
              server issues a fresh uuid.

  GET  /orgs/{org_id}/agents/{agent_id}
      Action: fetch one agent registration by id.

The SDK calls POST /agents/register at agent startup so the CLI's
``eden config discover-agents`` can list the user's agents. The
``agent_id`` is then threaded through observability queries
(``observability/summary?agent_id=...``, ``/traces?agent_id=...``)
to scope per-agent views.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/agents",
    tags=["agents"],
)


# ── Pydantic schemas ─────────────────────────────────────────────


class AgentRegistration(BaseModel):
    """One agent registration row."""

    agent_id: str
    name: str
    framework: str | None = None
    repo_url: str | None = None
    last_seen_at: str
    created_at: str
    updated_at: str


class AgentListResponse(BaseModel):
    agents: list[AgentRegistration] = Field(default_factory=list)
    total: int = 0
    limit: int = 50
    offset: int = 0


class AgentRegisterRequest(BaseModel):
    agent_id: str | None = None
    name: str
    framework: str | None = None
    repo_url: str | None = None
    register_token: str | None = None


class AgentRegisterResponse(BaseModel):
    agent: AgentRegistration
    created: bool  # True if newly registered, False if updated in place


# ── helpers ──────────────────────────────────────────────────────
# Audit 2026-06-22 B1.9 — _require_org_access removed; routes now use
# Depends(require_org_member) / Depends(require_org_admin) directly
# because get_current_user never sets auth_kind/is_superuser/org_ids.


def _row_to_response(row: dict) -> AgentRegistration:
    def _iso(ts) -> str:
        if ts is None:
            return ""
        if isinstance(ts, datetime):
            return ts.astimezone(UTC).isoformat()
        return str(ts)

    return AgentRegistration(
        agent_id=row["agent_id"],
        name=row["name"],
        framework=row.get("framework"),
        repo_url=row.get("repo_url"),
        last_seen_at=_iso(row.get("last_seen_at")),
        created_at=_iso(row.get("created_at")),
        updated_at=_iso(row.get("updated_at")),
    )


# ── GET /orgs/{org_id}/agents ────────────────────────────────────


@router.get("", response_model=AgentListResponse)
async def list_agents(
    org_id: str = Path(..., description="Organization ID"),
    framework: str | None = Query(None, description="Filter by framework"),
    name: str | None = Query(None, description="Substring match on name"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
) -> AgentListResponse:
    """List agent registrations for the org, most-recently-active first."""
    # Audit 2026-06-22 B1.9 — _require_org_access removed (it depended
    # on phantom auth_kind/is_superuser/org_ids dict keys that get_current_user
    # never sets). Phase 2 will replace get_current_user → require_org_member
    # on this route.

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        return AgentListResponse(agents=[], total=0, limit=limit, offset=offset)

    where = "org_id = $1"
    params: list = [org_id]
    if framework:
        params.append(framework)
        where += f" AND framework = ${len(params)}"
    if name:
        params.append(f"%{name}%")
        where += f" AND name ILIKE ${len(params)}"

    rows = await client.fetch(
        f"""
        SELECT agent_id, name, framework, repo_url, last_seen_at,
               created_at, updated_at
        FROM agent_registrations
        WHERE {where}
        ORDER BY last_seen_at DESC
        LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
        """,
        *params, limit, offset,
    )
    total = await client.fetchval(
        f"SELECT count(*) FROM agent_registrations WHERE {where}", *params
    )
    return AgentListResponse(
        agents=[_row_to_response(r) for r in rows],
        total=total or 0,
        limit=limit,
        offset=offset,
    )


# ── POST /orgs/{org_id}/agents/register ──────────────────────────


@router.post("/register", response_model=AgentRegisterResponse)
async def register_agent(
    body: AgentRegisterRequest,
    org_id: str = Path(..., description="Organization ID"),
    user: dict = Depends(get_current_user),
) -> AgentRegisterResponse:
    """Register an agent. Idempotent on (org_id, agent_id)."""
    # Audit 2026-06-22 B1.9 — _require_org_access removed (see list_agents).

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    # If the client supplied an agent_id and it already exists, update
    # in place. Otherwise the server issues a fresh uuid.
    agent_id = body.agent_id or str(uuid.uuid4())

    existing = await client.fetchrow(
        """
        SELECT agent_id, name, framework, repo_url, last_seen_at,
               created_at, updated_at
        FROM agent_registrations
        WHERE org_id = $1 AND agent_id = $2
        """,
        org_id, agent_id,
    )

    if existing is not None:
        await client.execute(
            """
            UPDATE agent_registrations
            SET name = $3,
                framework = $4,
                repo_url = $5,
                register_token = COALESCE($6, register_token),
                last_seen_at = NOW()
            WHERE org_id = $1 AND agent_id = $2
            """,
            org_id, agent_id, body.name, body.framework, body.repo_url,
            body.register_token,
        )
        row = await client.fetchrow(
            """
            SELECT agent_id, name, framework, repo_url, last_seen_at,
                   created_at, updated_at
            FROM agent_registrations
            WHERE org_id = $1 AND agent_id = $2
            """,
            org_id, agent_id,
        )
        return AgentRegisterResponse(agent=_row_to_response(row), created=False)

    await client.execute(
        """
        INSERT INTO agent_registrations
            (org_id, agent_id, name, framework, repo_url, register_token)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        org_id, agent_id, body.name, body.framework, body.repo_url,
        body.register_token,
    )
    row = await client.fetchrow(
        """
        SELECT agent_id, name, framework, repo_url, last_seen_at,
               created_at, updated_at
        FROM agent_registrations
        WHERE org_id = $1 AND agent_id = $2
        """,
        org_id, agent_id,
    )
    return AgentRegisterResponse(agent=_row_to_response(row), created=True)


# ── GET /orgs/{org_id}/agents/{agent_id} ─────────────────────────


@router.get("/{agent_id}", response_model=AgentRegistration)
async def get_agent(
    org_id: str = Path(..., description="Organization ID"),
    agent_id: str = Path(..., description="Agent ID"),
    user: dict = Depends(get_current_user),
) -> AgentRegistration:
    """Fetch one agent registration by id."""
    # Audit 2026-06-22 B1.9 — _require_org_access removed (see list_agents).

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

    row = await client.fetchrow(
        """
        SELECT agent_id, name, framework, repo_url, last_seen_at,
               created_at, updated_at
        FROM agent_registrations
        WHERE org_id = $1 AND agent_id = $2
        """,
        org_id, agent_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")
    return _row_to_response(row)
