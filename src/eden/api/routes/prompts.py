"""Phase I — Prompt management + Playground API routes.

Five routes:

  * ``POST /orgs/{org}/prompts`` — register a new template
  * ``GET  /orgs/{org}/prompts`` — list template names
  * ``GET  /orgs/{org}/prompts/{name}`` — get the latest version
  * ``PATCH /orgs/{org}/prompts/{name}`` — bump to a new version
  * ``POST /orgs/{org}/prompts/{name}/rollback/{version}`` — rollback
  * ``POST /orgs/{org}/prompts/{name}/playground`` — run a template
  * ``POST /orgs/{org}/prompts/{name}/compare`` — compare two models
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.prompts.registry import (
    Playground,
    PlaygroundResult,
    PromptRegistry,
    PromptTemplate,
    default_llm_handler,
)

logger = logging.getLogger(__name__)


router = APIRouter(
    prefix="/orgs/{org_id}/prompts",
    tags=["prompts"],
)


# In-memory registry (Phase I.5 wires Postgres).
_REGISTRY = PromptRegistry()


def _get_user():
    from eden.api.routes.auth import get_current_user
    return get_current_user


# ── Schemas ───────────────────────────────────────────────────────


class PromptTemplateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    system: str = Field(default="", max_length=20_000)
    user: str = Field(default="", max_length=20_000)
    tools: list[dict[str, Any]] = Field(default_factory=list)
    required_params: list[str] = Field(default_factory=list)
    optional_params: list[str] = Field(default_factory=list)
    model: str = Field(default="t1")
    temperature: float = Field(default=0.0, ge=0.0, le=2.0)
    max_tokens: int = Field(default=1_024, ge=1, le=200_000)
    description: str = Field(default="", max_length=2_000)


class PromptTemplateResponse(BaseModel):
    name: str
    system: str
    user: str
    tools: list[dict[str, Any]]
    required_params: list[str]
    optional_params: list[str]
    model: str
    temperature: float
    max_tokens: int
    description: str
    version: int


class PromptListResponse(BaseModel):
    prompts: list[str]  # just the names
    total_count: int


class VersionListResponse(BaseModel):
    name: str
    versions: list[int]


class UpdateTemplateRequest(BaseModel):
    system: str | None = None
    user: str | None = None
    tools: list[dict[str, Any]] | None = None
    required_params: list[str] | None = None
    optional_params: list[str] | None = None
    model: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    description: str | None = None


class PlaygroundRequest(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)
    model: str | None = None


class PlaygroundResponse(BaseModel):
    template_name: str
    template_version: int
    model: str
    response: str
    latency_ms: float
    prompt_tokens: int | None
    completion_tokens: int | None
    cost_usd: float | None
    created_at: str


class CompareRequest(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)
    model_b: str = Field(..., description="The second model to compare against.")


class CompareResponse(BaseModel):
    a: PlaygroundResponse
    b: PlaygroundResponse


# ── Helpers ───────────────────────────────────────────────────────


def _to_response(t: PromptTemplate) -> PromptTemplateResponse:
    return PromptTemplateResponse(**t.to_dict())


def _playground_to_response(r: PlaygroundResult) -> PlaygroundResponse:
    return PlaygroundResponse(**r.to_dict())


# ── Routes ────────────────────────────────────────────────────────


@router.post(
    "",
    response_model=PromptTemplateResponse,
    summary="Register a new prompt template",
)
async def register_template(
    body: PromptTemplateRequest,
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> PromptTemplateResponse:
    template = PromptTemplate(
        name=body.name, system=body.system, user=body.user,
        tools=body.tools, required_params=body.required_params,
        optional_params=body.optional_params,
        model=body.model, temperature=body.temperature,
        max_tokens=body.max_tokens, description=body.description,
    )
    try:
        template = _REGISTRY.register(template)
    except ValueError as exc:
        raise HTTPException(
            status_code=409,
            detail={"error": "already_exists", "detail": str(exc)},
        )
    return _to_response(template)


@router.get(
    "",
    response_model=PromptListResponse,
    summary="List template names",
)
async def list_templates(
    org_id: str = Path(...),
    user: dict = Depends(_get_user()),
) -> PromptListResponse:
    names = _REGISTRY.list_names()
    return PromptListResponse(prompts=names, total_count=len(names))


@router.get(
    "/{name}",
    response_model=PromptTemplateResponse,
    summary="Get the latest version of a template",
)
async def get_template(
    org_id: str = Path(...),
    name: str = Path(...),
    user: dict = Depends(_get_user()),
) -> PromptTemplateResponse:
    t = _REGISTRY.get(name)
    if t is None:
        raise HTTPException(status_code=404, detail="template not found")
    return _to_response(t)


@router.patch(
    "/{name}",
    response_model=PromptTemplateResponse,
    summary="Bump a template to a new version",
)
async def update_template(
    body: UpdateTemplateRequest,
    org_id: str = Path(...),
    name: str = Path(...),
    user: dict = Depends(_get_user()),
) -> PromptTemplateResponse:
    existing = _REGISTRY.get(name)
    if existing is None:
        raise HTTPException(status_code=404, detail="template not found")
    # Build a new version with merged fields.
    new = PromptTemplate(
        name=name,
        system=body.system if body.system is not None else existing.system,
        user=body.user if body.user is not None else existing.user,
        tools=body.tools if body.tools is not None else existing.tools,
        required_params=(
            body.required_params
            if body.required_params is not None
            else existing.required_params
        ),
        optional_params=(
            body.optional_params
            if body.optional_params is not None
            else existing.optional_params
        ),
        model=body.model if body.model is not None else existing.model,
        temperature=(
            body.temperature
            if body.temperature is not None
            else existing.temperature
        ),
        max_tokens=(
            body.max_tokens
            if body.max_tokens is not None
            else existing.max_tokens
        ),
        description=(
            body.description
            if body.description is not None
            else existing.description
        ),
    )
    try:
        new = _REGISTRY.update(new)
    except ValueError as exc:
        raise HTTPException(
            status_code=409,
            detail={"error": "update_failed", "detail": str(exc)},
        )
    return _to_response(new)


@router.get(
    "/{name}/versions",
    response_model=VersionListResponse,
    summary="List all versions of a template",
)
async def list_versions(
    org_id: str = Path(...),
    name: str = Path(...),
    user: dict = Depends(_get_user()),
) -> VersionListResponse:
    versions = _REGISTRY.list_versions(name)
    if not versions:
        raise HTTPException(status_code=404, detail="template not found")
    return VersionListResponse(name=name, versions=versions)


@router.post(
    "/{name}/rollback/{version}",
    response_model=PromptTemplateResponse,
    summary="Rollback a template to a previous version",
)
async def rollback_template(
    org_id: str = Path(...),
    name: str = Path(...),
    version: int = Path(...),
    user: dict = Depends(_get_user()),
) -> PromptTemplateResponse:
    try:
        new = _REGISTRY.rollback(name, version)
    except ValueError as exc:
        raise HTTPException(
            status_code=404,
            detail={"error": "rollback_failed", "detail": str(exc)},
        )
    return _to_response(new)


@router.post(
    "/{name}/playground",
    response_model=PlaygroundResponse,
    summary="Run a template against the LLM",
)
async def playground(
    body: PlaygroundRequest,
    org_id: str = Path(...),
    name: str = Path(...),
    user: dict = Depends(_get_user()),
) -> PlaygroundResponse:
    t = _REGISTRY.get(name)
    if t is None:
        raise HTTPException(status_code=404, detail="template not found")
    # Use the requested model if provided.
    if body.model is not None:
        t = PromptTemplate(
            name=t.name, system=t.system, user=t.user,
            tools=list(t.tools), required_params=list(t.required_params),
            optional_params=list(t.optional_params),
            model=body.model, temperature=t.temperature,
            max_tokens=t.max_tokens, description=t.description,
            version=t.version,
        )
    pg = Playground(default_llm_handler)
    try:
        result = await pg.run(t, body.params)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "compile_failed", "detail": str(exc)},
        )
    return _playground_to_response(result)


@router.post(
    "/{name}/compare",
    response_model=CompareResponse,
    summary="Run a template against two models and return both results",
)
async def compare(
    body: CompareRequest,
    org_id: str = Path(...),
    name: str = Path(...),
    user: dict = Depends(_get_user()),
) -> CompareResponse:
    t = _REGISTRY.get(name)
    if t is None:
        raise HTTPException(status_code=404, detail="template not found")
    pg = Playground(default_llm_handler)
    try:
        a, b = await pg.compare(t, body.params, body.model_b)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={"error": "compare_failed", "detail": str(exc)},
        )
    return CompareResponse(
        a=_playground_to_response(a),
        b=_playground_to_response(b),
    )
