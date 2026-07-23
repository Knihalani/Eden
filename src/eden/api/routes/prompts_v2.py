"""Prompts API — D.9 (§C.2) prompt versioning endpoints.

Routes:

* ``GET  /orgs/{org_id}/prompts`` — list the per-org prompt registry.
* ``POST /orgs/{org_id}/prompts`` — create a new prompt entry.
* ``GET  /orgs/{org_id}/prompts/{name}`` — read a prompt + version timeline.
* ``POST /orgs/{org_id}/prompts/{name}/versions`` — create a new
  version (auto-increments ``version``, fires auto-eval when
  ``auto_eval_on_save=true``).
* ``GET  /orgs/{org_id}/prompts/{name}/versions/{v}`` — read a
  single version.
* ``GET  /orgs/{org_id}/prompts/{name}/versions/{v}/eval-runs`` —
  list eval runs for the version.
* ``GET  /orgs/{org_id}/prompts/{name}/pins`` — env pins (dev/staging/prod).
* ``PUT  /orgs/{org_id}/prompts/{name}/pins/{env}`` — pin/deploy a version.
* ``POST /orgs/{org_id}/prompts/{name}/rollback`` — rollback env pin.

Note: there is an existing ``prompts`` router (the Cat 9 prompt
detection surface) — this file uses the ``prompts_v2`` module
name to avoid the import collision. The prefix is identical
(``/orgs/{org_id}/prompts``) so the spec-aligned API contract is
preserved.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.prompts.deploy import (
    CANONICAL_ENVS,
    PromptDeployService,
    normalize_env,
)
from eden.services.prompt_versioning import PromptService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/prompts",
    tags=["prompts-v2"],
    dependencies=[Depends(get_current_user), Depends(require_path_org_access)],
)


class CreatePromptRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: str | None = Field(default=None, max_length=2048)
    tags: list[str] = Field(default_factory=list)
    auto_eval_on_save: bool = False


class CreateVersionRequest(BaseModel):
    template: str = Field(..., min_length=1)
    model: str = Field(..., min_length=1, max_length=64)
    params: dict[str, Any] = Field(default_factory=dict)
    variables: list[str] = Field(default_factory=list)
    change_note: str | None = Field(default=None, max_length=2048)


class PinEnvRequest(BaseModel):
    version: int = Field(..., ge=1)


class RollbackRequest(BaseModel):
    env: str = Field(default="prod")


def _serialize_env_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key, value in list(out.items()):
        if hasattr(value, "isoformat"):
            out[key] = value.isoformat()
        elif hasattr(value, "hex"):  # UUID
            out[key] = str(value)
    return out


@router.get("")
async def list_prompts(
    org_id: str = Depends(require_path_org_access),
    limit: int = Query(100, ge=1, le=500),
) -> dict[str, Any]:
    """List the per-org prompt registry."""
    prompts = await PromptService().list_prompts(org_id, limit=limit)
    return {
        "status": "ok",
        "feature": "prompts_v2",
        "live": True,
        "data": {"prompts": prompts, "count": len(prompts)},
    }


@router.post("")
async def create_prompt(
    org_id: str = Depends(require_path_org_access),
    body: CreatePromptRequest = Body(...),
) -> dict[str, Any]:
    """Create a new prompt entry in the registry."""
    prompt = await PromptService().create_prompt(
        org_id,
        name=body.name,
        description=body.description,
        tags=body.tags,
        auto_eval_on_save=body.auto_eval_on_save,
    )
    return {
        "status": "ok",
        "feature": "prompts_v2",
        "live": True,
        "data": prompt or {},
    }


@router.get("/{name}")
async def get_prompt(
    org_id: str = Depends(require_path_org_access),
    name: str = Path(...),
) -> dict[str, Any]:
    """Read a prompt + its version timeline."""
    prompt = await PromptService().get_prompt(org_id, name)
    if prompt is None:
        return {
            "status": "not_found",
            "feature": "prompts_v2",
            "live": False,
            "message": f"Prompt {name!r} not found",
            "data": None,
        }
    versions = await PromptService().list_versions(org_id, name)
    return {
        "status": "ok",
        "feature": "prompts_v2",
        "live": True,
        "data": {"prompt": prompt, "versions": versions},
    }


@router.post("/{name}/versions")
async def create_version(
    org_id: str = Depends(require_path_org_access),
    name: str = Path(...),
    body: CreateVersionRequest = Body(...),
) -> dict[str, Any]:
    """Create a new version of the prompt."""
    version = await PromptService().create_version(
        org_id,
        name,
        template=body.template,
        model=body.model,
        params=body.params,
        variables=body.variables,
        change_note=body.change_note,
    )
    return {
        "status": "ok",
        "feature": "prompts_v2",
        "live": True,
        "data": version or {},
    }


@router.get("/{name}/versions/{version}")
async def get_version(
    org_id: str = Depends(require_path_org_access),
    name: str = Path(...),
    version: int = Path(...),
) -> dict[str, Any]:
    """Read a single version."""
    v = await PromptService().get_version(org_id, name, version)
    if v is None:
        return {
            "status": "not_found",
            "feature": "prompts_v2",
            "live": False,
            "message": f"Version {version} of {name!r} not found",
            "data": None,
        }
    return {
        "status": "ok",
        "feature": "prompts_v2",
        "live": True,
        "data": v,
    }


@router.get("/{name}/versions/{version}/eval-runs")
async def list_eval_runs(
    org_id: str = Depends(require_path_org_access),
    name: str = Path(...),
    version: int = Path(...),
    limit: int = Query(20, ge=1, le=100),
) -> dict[str, Any]:
    """List auto-eval runs for the version."""
    v = await PromptService().get_version(org_id, name, version)
    if v is None:
        return {
            "status": "not_found",
            "feature": "prompts_v2",
            "live": False,
            "message": f"Version {version} of {name!r} not found",
            "data": None,
        }
    runs = await PromptService().list_eval_runs(
        org_id, v["id"], limit=limit
    )
    return {
        "status": "ok",
        "feature": "prompts_v2",
        "live": True,
        "data": {"eval_runs": runs, "count": len(runs)},
    }


@router.get("/{name}/pins")
async def get_pins(
    org_id: str = Depends(require_path_org_access),
    name: str = Path(...),
) -> dict[str, Any]:
    """Return env pins for a prompt (canonical: dev / staging / prod)."""
    environments = await PromptDeployService().list_environments(org_id, name)
    pins: dict[str, int] = {}
    for row in environments:
        key = normalize_env(str(row.get("env") or ""))
        if key in CANONICAL_ENVS and row.get("version") is not None:
            pins[key] = int(row["version"])
    return {
        "pins": pins,
        "environments": [_serialize_env_row(r) for r in environments],
    }


@router.put("/{name}/pins/{env}")
async def put_pin(
    org_id: str = Depends(require_path_org_access),
    name: str = Path(...),
    env: str = Path(...),
    body: PinEnvRequest = Body(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Pin (deploy) a prompt version to an environment."""
    canonical = normalize_env(env)
    if canonical not in CANONICAL_ENVS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid env {env!r}. Canonical: {list(CANONICAL_ENVS)}",
        )
    result = await PromptDeployService().deploy(
        org_id,
        prompt_name=name,
        env=canonical,
        version=body.version,
        deployed_by=str(user.get("user_id") or ""),
    )
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to deploy prompt pin",
        )
    return {
        "status": "ok",
        "feature": "prompts_v2",
        "live": True,
        "data": result,
    }


@router.post("/{name}/rollback")
async def rollback_pin(
    org_id: str = Depends(require_path_org_access),
    name: str = Path(...),
    body: RollbackRequest | None = Body(default=None),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Rollback an env pin to the previous discoverable version (default: prod)."""
    env = normalize_env((body.env if body else None) or "prod")
    if env not in CANONICAL_ENVS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid env {env!r}. Canonical: {list(CANONICAL_ENVS)}",
        )
    try:
        result = await PromptDeployService().rollback(
            org_id,
            prompt_name=name,
            env=env,
            deployed_by=str(user.get("user_id") or ""),
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    return {
        "status": "ok",
        "feature": "prompts_v2",
        "live": True,
        "data": result,
    }
