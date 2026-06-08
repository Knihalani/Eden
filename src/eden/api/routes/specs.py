"""Spec and Interview routes for Eden API.

Provides the full interview → spec → job flow:
- POST /specs/interview         — submit a conversational turn
- POST /specs/{id}/generate     — generate spec from completed interview
- POST /specs/{id}/regenerate   — regenerate spec with feedback
- GET  /specs/{spec_id}         — retrieve a spec
- GET  /specs                   — list specs for the authenticated org
- POST /specs/{spec_id}/convert-to-job — convert an approved spec to a pipeline job
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends, Header, Cookie
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.agents.interviewer.agent import InterviewerAgent, InterviewSession, TurnResult
from eden.storage.postgres import get_postgres_client
from eden.pipeline.state import create_initial_state
from eden.pipeline.graph import compile_eden_graph
from eden.api.routes.jobs import _run_pipeline, JobRequest
from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(
    prefix="/specs",
    tags=["specs"],
    dependencies=[Depends(require_feature_flag("enable_eval_pipeline"))],
)

# In-memory session store (production: use Redis)
_interview_sessions: dict[str, InterviewSession] = {}

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class InterviewTurnRequest(BaseModel):
    """Request schema for submitting an interview turn."""
    session_id: Optional[str] = Field(None, description="Existing session ID, or omit to create a new session")
    message: str = Field(..., description="User's message for this turn")


class InterviewTurnResponse(BaseModel):
    """Response schema for an interview turn."""
    session_id: str
    assistant_message: str
    checklist_state: dict
    extracted_fields: list[str]
    next_priority_fields: list[str]
    readiness_score: float
    is_ready_for_spec: bool
    is_complete: bool
    clarification_needed: list[str]
    confidence: float


class SpecGenerateRequest(BaseModel):
    """Request schema for spec generation (optional feedback)."""
    feedback: Optional[str] = Field(None, description="User feedback for regeneration")


class SpecResponse(BaseModel):
    """Response schema for a generated spec."""
    spec_id: str
    session_id: str
    spec_data: dict
    version: int
    status: str
    created_at: str


class SpecListItem(BaseModel):
    """Item in spec list response."""
    spec_id: str
    title: str
    status: str
    created_at: str
    updated_at: str


class SpecListResponse(BaseModel):
    """Response schema for listing specs."""
    specs: list[SpecListItem]
    total: int
    limit: int
    offset: int


class ConvertToJobResponse(BaseModel):
    """Response schema for converting a spec to a job."""
    job_id: str
    status: str
    message: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_org_id(x_org_id: Optional[str], authorization: Optional[str]) -> Optional[str]:
    """Resolve org_id from header or JWT cookie."""
    if x_org_id:
        return x_org_id
    if authorization:
        from eden.api.utils.auth import decode_access_token
        payload = decode_access_token(authorization)
        if payload:
            return payload.get("current_org_id")
    return None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("/interview", response_model=InterviewTurnResponse)
async def submit_interview_turn(
    request: InterviewTurnRequest,
    user: dict = Depends(get_current_user),
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
):
    """Submit a conversational turn in the interview.

    Creates a new session if `session_id` is omitted.
    Returns the assistant's reply, updated checklist state, and readiness score.
    """
    org_id = _resolve_org_id(x_org_id, authorization)
    user_id = user["user_id"]

    # Retrieve or create session
    if request.session_id and request.session_id in _interview_sessions:
        session = _interview_sessions[request.session_id]
    else:
        session = InterviewSession.create(org_id=org_id, user_id=user_id)
        _interview_sessions[session.session_id] = session

    # Process turn
    agent = InterviewerAgent()
    try:
        result: TurnResult = await agent.process_turn(session, request.message)
    except Exception as exc:
        logger.error(f"Interview turn failed for session {session.session_id}: {exc}")
        raise HTTPException(status_code=500, detail="Interview processing failed")

    # Persist updated session
    _interview_sessions[session.session_id] = result.session

    # Collect clarification_needed fields
    clarification_needed = [
        name for name, fs in result.session.checklist_state.fields.items()
        if fs.status.value == "needs_clarification"
    ]

    return InterviewTurnResponse(
        session_id=session.session_id,
        assistant_message=result.response,
        checklist_state=result.session.checklist_state.to_dict(),
        extracted_fields=list(result.extracted_fields.keys()),
        next_priority_fields=result.next_priority_fields,
        readiness_score=result.session.checklist_state.readiness_score,
        is_ready_for_spec=result.ready_for_spec,
        is_complete=result.session.checklist_state.user_marked_complete,
        clarification_needed=clarification_needed,
        confidence=result.session.checklist_state.readiness_score,
    )


@router.post("/{session_id}/generate", response_model=SpecResponse)
async def generate_spec(
    session_id: str,
    user: dict = Depends(get_current_user),
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
):
    """Generate a structured spec from a completed interview session.

    Stores the spec in the database and returns it.
    """
    org_id = _resolve_org_id(x_org_id, authorization)
    user_id = user["user_id"]

    session = _interview_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found")

    agent = InterviewerAgent()
    try:
        spec_data = await agent.generate_spec(session)
    except Exception as exc:
        logger.error(f"Spec generation failed for session {session_id}: {exc}")
        raise HTTPException(status_code=500, detail="Spec generation failed")

    # Persist session update
    _interview_sessions[session_id] = session

    # Derive a title from the spec
    title = "Environment Spec"
    if isinstance(spec_data, dict):
        meta = spec_data.get("meta", {})
        env_class = meta.get("environment_class", "")
        if env_class:
            title = f"{env_class.replace('_', ' ').title()} Environment"
        # Also try user_intent.goal or description
        user_intent = spec_data.get("user_intent", {})
        if user_intent.get("goal"):
            goal = str(user_intent["goal"])[:60]
            title = f"{goal}{'...' if len(str(user_intent['goal'])) > 60 else ''}"

    # Store spec in database
    spec_id = f"spec_{uuid.uuid4().hex[:12]}"
    created_at = datetime.now(timezone.utc).isoformat()

    client = await get_postgres_client()
    await client.create_spec(
        spec_id=spec_id,
        org_id=org_id or "_personal",
        user_id=user_id,
        title=title,
        status="generated",
        generated_spec=spec_data,
    )

    # Update session with spec info
    session.spec = spec_data
    session.status = "spec_generated"
    _interview_sessions[session_id] = session

    return SpecResponse(
        spec_id=spec_id,
        session_id=session_id,
        spec_data=spec_data,
        version=1,
        status="generated",
        created_at=created_at,
    )


@router.post("/{session_id}/regenerate", response_model=SpecResponse)
async def regenerate_spec(
    session_id: str,
    request: SpecGenerateRequest,
    user: dict = Depends(get_current_user),
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
):
    """Regenerate a spec from an interview session, optionally with user feedback.

    Overwrites the previous spec in the database if one exists for this session.
    """
    org_id = _resolve_org_id(x_org_id, authorization)
    user_id = user["user_id"]

    session = _interview_sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Interview session not found")

    agent = InterviewerAgent()
    feedback = request.feedback or "Regenerate with improved clarity and completeness."
    try:
        spec_data = await agent.regenerate_spec(session, feedback)
    except Exception as exc:
        logger.error(f"Spec regeneration failed for session {session_id}: {exc}")
        raise HTTPException(status_code=500, detail="Spec regeneration failed")

    # Persist session update
    _interview_sessions[session_id] = session

    # Derive title
    title = "Environment Spec"
    if isinstance(spec_data, dict):
        meta = spec_data.get("meta", {})
        env_class = meta.get("environment_class", "")
        if env_class:
            title = f"{env_class.replace('_', ' ').title()} Environment"
        user_intent = spec_data.get("user_intent", {})
        if user_intent.get("goal"):
            goal = str(user_intent["goal"])[:60]
            title = f"{goal}{'...' if len(str(user_intent['goal'])) > 60 else ''}"

    # Upsert spec in database (reuse existing spec_id if present)
    spec_id = f"spec_{uuid.uuid4().hex[:12]}"
    created_at = datetime.now(timezone.utc).isoformat()

    client = await get_postgres_client()
    await client.create_spec(
        spec_id=spec_id,
        org_id=org_id or "_personal",
        user_id=user_id,
        title=title,
        status="generated",
        generated_spec=spec_data,
    )

    return SpecResponse(
        spec_id=spec_id,
        session_id=session_id,
        spec_data=spec_data,
        version=2,
        status="generated",
        created_at=created_at,
    )


@router.get("/{spec_id}", response_model=SpecResponse)
async def get_spec(
    spec_id: str,
    user: dict = Depends(get_current_user),
):
    """Retrieve a spec by ID."""
    user_id = user["user_id"]
    client = await get_postgres_client()
    row = await client.get_spec(spec_id, user_id=user_id)

    if not row:
        raise HTTPException(status_code=404, detail="Spec not found")

    spec_data = row.get("generated_spec", {}) or {}
    if isinstance(spec_data, str):
        try:
            spec_data = json.loads(spec_data)
        except json.JSONDecodeError:
            spec_data = {}

    return SpecResponse(
        spec_id=row["spec_id"],
        session_id="",  # Not stored separately; can be enriched later
        spec_data=spec_data,
        version=1,
        status=row.get("status", "unknown"),
        created_at=row.get("created_at", ""),
    )


@router.get("", response_model=SpecListResponse)
async def list_specs(
    status: Optional[str] = None,
    limit: int = 20,
    offset: int = 0,
    user: dict = Depends(get_current_user),
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
):
    """List specs for the authenticated user's org."""
    org_id = _resolve_org_id(x_org_id, authorization)
    user_id = user["user_id"]

    client = await get_postgres_client()
    specs = await client.list_specs(
        org_id=org_id,
        user_id=user_id,
        status=status,
        limit=limit,
        offset=offset,
    )
    total = await client.count_specs(org_id=org_id, user_id=user_id, status=status)

    return SpecListResponse(
        specs=[
            SpecListItem(
                spec_id=s["spec_id"],
                title=s.get("title", "Untitled Spec"),
                status=s.get("status", "unknown"),
                created_at=s.get("created_at", ""),
                updated_at=s.get("updated_at", ""),
            )
            for s in specs
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.post("/{spec_id}/convert-to-job", response_model=ConvertToJobResponse)
async def convert_spec_to_job(
    spec_id: str,
    background_tasks: BackgroundTasks,
    user: dict = Depends(get_current_user),
    x_org_id: Optional[str] = Header(None, alias="X-Org-Id"),
    authorization: Optional[str] = Cookie(None),
):
    """Convert an approved spec into a pipeline job.

    Reads the spec from the database, merges its EDP data into a JobRequest,
    and submits the job to the pipeline.
    """
    org_id = _resolve_org_id(x_org_id, authorization)
    user_id = user["user_id"]

    client = await get_postgres_client()
    spec_row = await client.get_spec(spec_id, user_id=user_id)

    if not spec_row:
        raise HTTPException(status_code=404, detail="Spec not found")

    spec_data = spec_row.get("generated_spec", {}) or {}
    if isinstance(spec_data, str):
        try:
            spec_data = json.loads(spec_data)
        except json.JSONDecodeError:
            spec_data = {}

    # Update spec status
    await client.update_spec_status(spec_id, status="converted_to_job")

    # Build JobRequest from spec data
    # Extract description from spec (EDP schema or fallback)
    description = "Environment generated from spec"
    if isinstance(spec_data, dict):
        user_intent = spec_data.get("user_intent", {})
        if user_intent.get("goal"):
            description = str(user_intent["goal"])
        elif spec_data.get("description"):
            description = str(spec_data["description"])
        elif spec_data.get("meta", {}).get("environment_class"):
            description = f"{spec_data['meta']['environment_class']} environment"

    # Extract tags from spec
    tags: list[str] = []
    if isinstance(spec_data, dict):
        meta = spec_data.get("meta", {})
        env_class = meta.get("environment_class", "")
        if env_class:
            tags.append(env_class)
        obs_mod = meta.get("observation_modality", "")
        if obs_mod:
            tags.append(obs_mod)

    # Build difficulty parameters from spec
    difficulty_parameters: dict = {}
    if isinstance(spec_data, dict):
        env = spec_data.get("environment", {})
        if "difficulty_parameters" in env:
            difficulty_parameters = env["difficulty_parameters"]

    job_request = JobRequest(
        description=description,
        tags=tags,
        difficulty_parameters=difficulty_parameters,
    )

    # Create job record
    job_id = str(uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    await client.upsert_job(
        job_id=job_id,
        request={
            **job_request.model_dump(),
            "spec_id": spec_id,
            "spec_data": spec_data,
        },
        status="pending",
        current_stage="planning",
        created_at=created_at,
        user_id=user_id,
    )

    # Launch pipeline with spec data merged into request
    background_tasks.add_task(
        _run_pipeline,
        job_id=job_id,
        request=job_request,
        user_id=user_id,
        org_id=org_id,
        spec_id=spec_id,
        spec_data=spec_data,
    )

    return ConvertToJobResponse(
        job_id=job_id,
        status="pending",
        message="Job submitted successfully. Use GET /jobs/{job_id} to check status.",
    )
