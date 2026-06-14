"""Phase 1.7 — Visual Builder Graph Storage (§8.1).

Server-side save / load / list / delete for the React Flow
graphs the user authors in the visual environment builder at
``/builder``. Each graph is keyed by ``(org_id, name)`` and
stored as a JSONB blob so reloads are exact (no lossy
reconstruction from the YAML).

Endpoints:

  GET    /orgs/{org_id}/builder/graphs
         Query: limit?, offset?
         Action: list graphs the current user can read.

  POST   /orgs/{org_id}/builder/graphs
         Body: {name, graph: {nodes, edges}, yaml, agent_id?}
         Action: upsert (org_id, name). Returns the row.

  GET    /orgs/{org_id}/builder/graphs/{name}
         Action: fetch one graph by name.

  DELETE /orgs/{org_id}/builder/graphs/{name}
         Action: delete one graph. The creator (or an org
                 admin) can delete; other members 403.

The portal page uses the LIST + LOAD endpoints as a server-
side fallback when localStorage is empty (cross-browser
workflow). The CLI's ``eden config builder-load <name>`` is
out of scope here — the API is the contract.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/builder/graphs",
    tags=["builder-graphs"],
)


# ── Pydantic schemas ─────────────────────────────────────────────


class BuilderGraph(BaseModel):
    """One row from the ``builder_graphs`` table."""

    id: str
    org_id: str
    user_id: str | None = None
    name: str
    graph: dict
    yaml: str = ""
    agent_id: str | None = None
    created_at: str
    updated_at: str


class BuilderGraphListResponse(BaseModel):
    graphs: list[BuilderGraph] = Field(default_factory=list)
    total: int = 0
    limit: int = 50
    offset: int = 0


class BuilderGraphUpsertRequest(BaseModel):
    """Body for POST /orgs/{org_id}/builder/graphs."""

    name: str = Field(..., min_length=1, max_length=128)
    graph: dict
    yaml: str = ""
    agent_id: str | None = None


class BuilderGraphUpsertResponse(BaseModel):
    graph: BuilderGraph
    created: bool  # True if newly inserted, False if updated in place


# ── helpers ──────────────────────────────────────────────────────


async def _require_org_access(org_id: str, user: dict) -> None:
    """Org-membership check shared with agents.py."""
    if user.get("auth_kind") == "api_key" and user.get("org_id") != org_id:
        raise HTTPException(
            status_code=403, detail="API key not authorized for this org"
        )
    if not user.get("is_superuser", False) and org_id not in user.get(
        "org_ids", []
    ):
        raise HTTPException(
            status_code=403, detail="User is not a member of this org"
        )


def _row_to_response(row: dict) -> BuilderGraph:
    def _iso(ts) -> str:
        if ts is None:
            return ""
        if isinstance(ts, datetime):
            return ts.astimezone(UTC).isoformat()
        return str(ts)

    graph = row.get("graph")
    if isinstance(graph, str):
        # JSONB sometimes round-trips as a string depending on
        # the driver; normalise to dict.
        try:
            graph = json.loads(graph)
        except (TypeError, ValueError):
            graph = {}
    elif graph is None:
        graph = {}

    return BuilderGraph(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        user_id=str(row["user_id"]) if row.get("user_id") else None,
        name=row["name"],
        graph=graph,
        yaml=row.get("yaml", "") or "",
        agent_id=row.get("agent_id"),
        created_at=_iso(row.get("created_at")),
        updated_at=_iso(row.get("updated_at")),
    )


async def _get_client():
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")
    return client


# ── GET /orgs/{org_id}/builder/graphs ─────────────────────────────


@router.get("", response_model=BuilderGraphListResponse)
async def list_builder_graphs(
    org_id: str = Path(...),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
) -> BuilderGraphListResponse:
    """List saved graphs for the org, newest-first."""
    await _require_org_access(org_id, user)
    client = await _get_client()
    rows = await client.fetch(
        """
        SELECT id, org_id, user_id, name, graph, yaml, agent_id,
               created_at, updated_at
        FROM builder_graphs
        WHERE org_id = $1
        ORDER BY updated_at DESC
        LIMIT $2 OFFSET $3
        """,
        uuid.UUID(org_id),
        limit,
        offset,
    )
    total_row = await client.fetchrow(
        "SELECT count(*) AS c FROM builder_graphs WHERE org_id = $1",
        uuid.UUID(org_id),
    )
    total = int(total_row["c"]) if total_row else 0
    return BuilderGraphListResponse(
        graphs=[_row_to_response(r) for r in rows],
        total=total,
        limit=limit,
        offset=offset,
    )


# ── POST /orgs/{org_id}/builder/graphs ────────────────────────────


@router.post("", response_model=BuilderGraphUpsertResponse)
async def upsert_builder_graph(
    org_id: str = Path(...),
    body: BuilderGraphUpsertRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> BuilderGraphUpsertResponse:
    """Create or overwrite a graph keyed by (org_id, name)."""
    await _require_org_access(org_id, user)
    client = await _get_client()

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name must not be empty")

    # Validate the graph shape (must have nodes + edges arrays).
    if "nodes" not in body.graph or "edges" not in body.graph:
        raise HTTPException(
            status_code=400, detail="graph must have 'nodes' and 'edges' arrays"
        )
    if not isinstance(body.graph["nodes"], list) or not isinstance(
        body.graph["edges"], list
    ):
        raise HTTPException(
            status_code=400, detail="'nodes' and 'edges' must be arrays"
        )

    user_id = user.get("user_id")
    user_id_uuid = uuid.UUID(user_id) if user_id else None

    # Check whether the row exists before the upsert so we can
    # return the `created` flag without relying on the
    # ``(xmax = 0)`` trick (which is incompatible with some
    # driver / proxy setups that strip system columns).
    existing = await client.fetchrow(
        "SELECT id FROM builder_graphs WHERE org_id = $1 AND name = $2",
        uuid.UUID(org_id),
        name,
    )
    was_new = existing is None

    rows = await client.fetch(
        """
        INSERT INTO builder_graphs (
            org_id, user_id, name, graph, yaml, agent_id,
            created_at, updated_at
        )
        VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW(), NOW())
        ON CONFLICT (org_id, name) DO UPDATE
        SET graph = EXCLUDED.graph,
            yaml = EXCLUDED.yaml,
            agent_id = EXCLUDED.agent_id,
            updated_at = NOW()
        RETURNING id, org_id, user_id, name, graph, yaml, agent_id,
                  created_at, updated_at
        """,
        uuid.UUID(org_id),
        user_id_uuid,
        name,
        json.dumps(body.graph),
        body.yaml,
        body.agent_id,
    )
    if not rows:
        raise HTTPException(status_code=500, detail="Upsert returned no rows")
    row = rows[0]
    return BuilderGraphUpsertResponse(
        graph=_row_to_response(row),
        created=was_new,
    )


# ── GET /orgs/{org_id}/builder/graphs/{name} ──────────────────────


@router.get("/{name}", response_model=BuilderGraph)
async def get_builder_graph(
    org_id: str = Path(...),
    name: str = Path(..., min_length=1, max_length=128),
    user: dict = Depends(get_current_user),
) -> BuilderGraph:
    """Fetch one graph by name."""
    await _require_org_access(org_id, user)
    client = await _get_client()
    row = await client.fetchrow(
        """
        SELECT id, org_id, user_id, name, graph, yaml, agent_id,
               created_at, updated_at
        FROM builder_graphs
        WHERE org_id = $1 AND name = $2
        """,
        uuid.UUID(org_id),
        name,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Graph not found")
    return _row_to_response(row)


# ── DELETE /orgs/{org_id}/builder/graphs/{name} ───────────────────


@router.delete("/{name}")
async def delete_builder_graph(
    org_id: str = Path(...),
    name: str = Path(..., min_length=1, max_length=128),
    user: dict = Depends(get_current_user),
) -> dict:
    """Delete a graph. The creator (or an org admin) can delete;
    other members 403."""
    await _require_org_access(org_id, user)
    client = await _get_client()
    row = await client.fetchrow(
        "SELECT user_id FROM builder_graphs WHERE org_id = $1 AND name = $2",
        uuid.UUID(org_id),
        name,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Graph not found")
    is_admin = bool(user.get("is_superuser", False)) or user.get("role") in (
        "admin",
        "owner",
    )
    is_creator = (
        row.get("user_id") is not None
        and str(row["user_id"]) == user.get("user_id")
    )
    if not (is_admin or is_creator):
        raise HTTPException(
            status_code=403,
            detail="Only the creator or an org admin can delete this graph",
        )
    await client.execute(
        "DELETE FROM builder_graphs WHERE org_id = $1 AND name = $2",
        uuid.UUID(org_id),
        name,
    )
    return {"deleted": True, "name": name}
