"""API Sandbox routes — free, isolated, auto-reset environment for developers.

Provides endpoints for developers to test Eden APIs without consuming
production quotas or incurring costs. Sandboxes are ephemeral, isolated,
and automatically cleaned up after a TTL.

References: eden-api-developer-platform-architecture.md §9, §10
"""

from __future__ import annotations

import logging
import random
import secrets
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag

logger = logging.getLogger(__name__)
router = APIRouter(
    prefix="/sandbox",
    tags=["sandbox"],
    dependencies=[Depends(require_feature_flag("enable_eval_pipeline"))],
)


# ──────────────────────────────────────────────────────────────────────────
# In-memory sandbox registry (production would use Redis + TTL)
# ──────────────────────────────────────────────────────────────────────────

SANDBOX_TTL_SECONDS = 3600  # 1 hour
_MAX_SANDBOXES_PER_USER = 3


@dataclass
class _SandboxSession:
    """Internal representation of a sandbox session."""

    session_id: str
    api_key: str
    created_at: float
    last_used_at: float
    request_count: int = 0
    request_log: list[dict] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def is_expired(self) -> bool:
        return time.time() - self.last_used_at > SANDBOX_TTL_SECONDS

    def touch(self) -> None:
        self.last_used_at = time.time()


# In-memory store (key: session_id)
_sandbox_registry: dict[str, _SandboxSession] = {}
_api_key_to_session: dict[str, str] = {}


# ──────────────────────────────────────────────────────────────────────────
# Schemas
# ──────────────────────────────────────────────────────────────────────────


class SandboxCreateRequest(BaseModel):
    """Request to create a new sandbox session."""

    name: str | None = Field(None, description="Optional name for the sandbox session")
    ttl_seconds: int | None = Field(None, ge=60, le=7200, description="Custom TTL (60–7200s)")


class SandboxSessionResponse(BaseModel):
    """Response containing sandbox session credentials."""

    session_id: str
    api_key: str
    base_url: str = "https://api.sandbox.eden.ai/v1"
    created_at: str
    expires_at: str
    request_count: int = 0
    max_requests: int = 100


class SandboxStatusResponse(BaseModel):
    """Response with current sandbox session status."""

    session_id: str
    status: str  # active | expired | revoked
    created_at: str
    last_used_at: str
    expires_at: str
    request_count: int
    max_requests: int
    endpoints_available: list[str]


class SandboxExecuteRequest(BaseModel):
    """Request to execute an API call within the sandbox."""

    endpoint: str = Field(..., description="Target endpoint path (e.g. /v1/jobs)")
    method: str = Field("POST", pattern="^(GET|POST|PUT|PATCH|DELETE)$")
    body: dict[str, Any] | None = Field(None, description="Request payload")
    headers: dict[str, str] | None = Field(None, description="Additional headers")


class SandboxExecuteResponse(BaseModel):
    """Response from a sandboxed API execution."""

    status_code: int
    body: dict[str, Any] | str
    headers: dict[str, str]
    duration_ms: int
    sandboxed: bool = True
    warnings: list[str] | None = None


class SandboxRequestLogEntry(BaseModel):
    """A single logged request within a sandbox session."""

    timestamp: str
    method: str
    endpoint: str
    status_code: int
    duration_ms: int


class SandboxRequestLogResponse(BaseModel):
    """Response containing the request log for a sandbox session."""

    session_id: str
    total_requests: int
    entries: list[SandboxRequestLogEntry]


class SandboxResetRequest(BaseModel):
    """Request to reset a sandbox session."""

    preserve_logs: bool = Field(False, description="Keep request logs after reset")


class SandboxResetResponse(BaseModel):
    """Response after resetting a sandbox."""

    session_id: str
    previous_request_count: int
    reset_at: str
    message: str


class SandboxListResponse(BaseModel):
    """Response listing all active sandbox sessions for the current user."""

    sessions: list[SandboxStatusResponse]
    total: int


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _generate_api_key() -> str:
    """Generate a secure sandbox API key."""
    return f"sandbox_{secrets.token_urlsafe(32)}"


def _generate_session_id() -> str:
    """Generate a unique sandbox session ID."""
    return f"sb_{secrets.token_urlsafe(16)}"


def _prune_expired() -> None:
    """Remove expired sandbox sessions from the registry."""
    expired = [
        sid for sid, sess in _sandbox_registry.items() if sess.is_expired
    ]
    for sid in expired:
        sess = _sandbox_registry.pop(sid, None)
        if sess:
            _api_key_to_session.pop(sess.api_key, None)
            logger.info("Pruned expired sandbox session %s", sid)


# ──────────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────────


@router.post(
    "/sessions",
    response_model=SandboxSessionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a sandbox session",
    description="Create a free, isolated sandbox session for testing Eden APIs. "
                "No production quotas are consumed. Sessions auto-expire after 1 hour.",
)
async def create_sandbox(
    request: SandboxCreateRequest,
    user: dict = Depends(get_current_user),
) -> SandboxSessionResponse:
    """Create a new sandbox session for API testing."""
    _prune_expired()

    user_id = user.get("user_id", "anonymous")
    ttl = request.ttl_seconds or SANDBOX_TTL_SECONDS

    # Rate limit: max 3 active sandboxes per user
    user_sessions = [
        s for s in _sandbox_registry.values()
        if s.metadata.get("user_id") == user_id and not s.is_expired
    ]
    if len(user_sessions) >= _MAX_SANDBOXES_PER_USER:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Maximum {_MAX_SANDBOXES_PER_USER} active sandbox sessions allowed. "
                   "Reset or delete an existing session first.",
        )

    session_id = _generate_session_id()
    api_key = _generate_api_key()
    now = time.time()

    session = _SandboxSession(
        session_id=session_id,
        api_key=api_key,
        created_at=now,
        last_used_at=now,
        metadata={
            "user_id": user_id,
            "name": request.name or f"Sandbox {len(user_sessions) + 1}",
            "ttl_seconds": ttl,
        },
    )

    _sandbox_registry[session_id] = session
    _api_key_to_session[api_key] = session_id

    logger.info("Created sandbox session %s for user %s", session_id, user_id)

    return SandboxSessionResponse(
        session_id=session_id,
        api_key=api_key,
        base_url="https://api.sandbox.eden.ai/v1",
        created_at=_fmt_ts(now),
        expires_at=_fmt_ts(now + ttl),
        request_count=0,
        max_requests=100,
    )


@router.get(
    "/sessions/{session_id}",
    response_model=SandboxStatusResponse,
    summary="Get sandbox session status",
)
async def get_sandbox_status(
    session_id: str,
    user: dict = Depends(get_current_user),
) -> SandboxStatusResponse:
    """Retrieve the current status of a sandbox session."""
    _prune_expired()
    session = _sandbox_registry.get(session_id)

    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sandbox session not found or expired",
        )

    # Ownership check
    if session.metadata.get("user_id") != user.get("user_id"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this sandbox session",
        )

    ttl = session.metadata.get("ttl_seconds", SANDBOX_TTL_SECONDS)
    is_expired = session.is_expired

    return SandboxStatusResponse(
        session_id=session_id,
        status="expired" if is_expired else "active",
        created_at=_fmt_ts(session.created_at),
        last_used_at=_fmt_ts(session.last_used_at),
        expires_at=_fmt_ts(session.created_at + ttl),
        request_count=session.request_count,
        max_requests=100,
        endpoints_available=[
            "POST /v1/jobs",
            "GET /v1/jobs/{id}",
            "GET /v1/jobs/{id}/stream",
            "POST /v1/environments",
            "GET /v1/environments/{id}",
            "POST /v1/benchmarks",
            "GET /v1/benchmarks/{id}",
            "POST /v1/datasets",
            "GET /v1/observability/traces",
            "GET /health",
        ],
    )


@router.post(
    "/sessions/{session_id}/execute",
    response_model=SandboxExecuteResponse,
    summary="Execute an API call in the sandbox",
    description="Proxy an API request through the sandbox. Responses are mocked or "
                "returned from a synthetic backend. No real LLM calls are made.",
)
async def execute_sandbox(
    session_id: str,
    request: SandboxExecuteRequest,
    user: dict = Depends(get_current_user),
) -> SandboxExecuteResponse:
    """Execute an API call within a sandboxed environment."""
    _prune_expired()
    session = _sandbox_registry.get(session_id)

    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sandbox session not found or expired",
        )

    if session.metadata.get("user_id") != user.get("user_id"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this sandbox session",
        )

    if session.is_expired:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Sandbox session has expired. Create a new session.",
        )

    if session.request_count >= 100:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Sandbox request limit (100) reached. Reset the session to continue.",
        )

    start = time.perf_counter()
    session.touch()
    session.request_count += 1

    # ── Mocked/sandboxed execution ────────────────────────────────────────
    body, status_code, warnings = _mock_endpoint(
        request.endpoint, request.method, request.body or {}
    )

    duration_ms = int((time.perf_counter() - start) * 1000)

    session.request_log.append({
        "timestamp": _fmt_ts(time.time()),
        "method": request.method,
        "endpoint": request.endpoint,
        "status_code": status_code,
        "duration_ms": duration_ms,
    })

    return SandboxExecuteResponse(
        status_code=status_code,
        body=body,
        headers={"Content-Type": "application/json", "X-Sandboxed": "true"},
        duration_ms=duration_ms,
        sandboxed=True,
        warnings=warnings,
    )


@router.get(
    "/sessions/{session_id}/requests",
    response_model=SandboxRequestLogResponse,
    summary="Get sandbox request log",
)
async def get_request_log(
    session_id: str,
    user: dict = Depends(get_current_user),
) -> SandboxRequestLogResponse:
    """Retrieve the request log for a sandbox session."""
    _prune_expired()
    session = _sandbox_registry.get(session_id)

    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sandbox session not found or expired",
        )

    if session.metadata.get("user_id") != user.get("user_id"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this sandbox session",
        )

    entries = [
        SandboxRequestLogEntry(
            timestamp=e["timestamp"],
            method=e["method"],
            endpoint=e["endpoint"],
            status_code=e["status_code"],
            duration_ms=e["duration_ms"],
        )
        for e in session.request_log
    ]

    return SandboxRequestLogResponse(
        session_id=session_id,
        total_requests=len(entries),
        entries=entries,
    )


@router.post(
    "/sessions/{session_id}/reset",
    response_model=SandboxResetResponse,
    summary="Reset a sandbox session",
)
async def reset_sandbox(
    session_id: str,
    request: SandboxResetRequest,
    user: dict = Depends(get_current_user),
) -> SandboxResetResponse:
    """Reset a sandbox session, clearing all state but keeping the session alive."""
    _prune_expired()
    session = _sandbox_registry.get(session_id)

    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sandbox session not found or expired",
        )

    if session.metadata.get("user_id") != user.get("user_id"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this sandbox session",
        )

    previous_count = session.request_count
    session.request_count = 0
    session.last_used_at = time.time()

    if not request.preserve_logs:
        session.request_log.clear()

    logger.info("Reset sandbox session %s for user %s", session_id, user.get("user_id"))

    return SandboxResetResponse(
        session_id=session_id,
        previous_request_count=previous_count,
        reset_at=_fmt_ts(time.time()),
        message="Sandbox session reset successfully. All quotas restored.",
    )


@router.delete(
    "/sessions/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a sandbox session",
)
async def delete_sandbox(
    session_id: str,
    user: dict = Depends(get_current_user),
) -> None:
    """Permanently delete a sandbox session and all associated data."""
    session = _sandbox_registry.get(session_id)

    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Sandbox session not found",
        )

    if session.metadata.get("user_id") != user.get("user_id"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this sandbox session",
        )

    _sandbox_registry.pop(session_id, None)
    _api_key_to_session.pop(session.api_key, None)
    logger.info("Deleted sandbox session %s for user %s", session_id, user.get("user_id"))


@router.get(
    "/sessions",
    response_model=SandboxListResponse,
    summary="List sandbox sessions",
)
async def list_sandboxes(
    user: dict = Depends(get_current_user),
) -> SandboxListResponse:
    """List all active sandbox sessions for the current user."""
    _prune_expired()
    user_id = user.get("user_id")

    sessions = []
    for sid, sess in _sandbox_registry.items():
        if sess.metadata.get("user_id") == user_id and not sess.is_expired:
            ttl = sess.metadata.get("ttl_seconds", SANDBOX_TTL_SECONDS)
            sessions.append(
                SandboxStatusResponse(
                    session_id=sid,
                    status="active",
                    created_at=_fmt_ts(sess.created_at),
                    last_used_at=_fmt_ts(sess.last_used_at),
                    expires_at=_fmt_ts(sess.created_at + ttl),
                    request_count=sess.request_count,
                    max_requests=100,
                    endpoints_available=[],
                )
            )

    return SandboxListResponse(sessions=sessions, total=len(sessions))


@router.get(
    "/docs",
    summary="Get sandbox API documentation",
)
async def sandbox_docs() -> dict[str, Any]:
    """Return the list of available sandbox endpoints and example requests."""
    return {
        "description": "Eden API Sandbox — free, isolated testing environment",
        "ttl_seconds": SANDBOX_TTL_SECONDS,
        "max_requests_per_session": 100,
        "max_active_sessions": _MAX_SANDBOXES_PER_USER,
        "endpoints": [
            {
                "method": "POST",
                "path": "/sandbox/sessions",
                "description": "Create a new sandbox session",
                "example": {"name": "My test session"},
            },
            {
                "method": "POST",
                "path": "/sandbox/sessions/{id}/execute",
                "description": "Execute a mock API call",
                "example": {
                    "endpoint": "/v1/jobs",
                    "method": "POST",
                    "body": {"description": "A test environment"},
                },
            },
            {
                "method": "GET",
                "path": "/sandbox/sessions/{id}",
                "description": "Get sandbox status",
            },
            {
                "method": "GET",
                "path": "/sandbox/sessions/{id}/requests",
                "description": "View request log",
            },
            {
                "method": "POST",
                "path": "/sandbox/sessions/{id}/reset",
                "description": "Reset sandbox quotas",
            },
            {
                "method": "DELETE",
                "path": "/sandbox/sessions/{id}",
                "description": "Delete sandbox session",
            },
        ],
        "mock_behaviors": {
            "jobs.create": "Returns a synthetic job object with predictable IDs",
            "jobs.stream": "Returns a mocked SSE stream with 6 events",
            "environments.get": "Returns a synthetic environment with sample code",
            "benchmarks.execute": "Returns a synthetic benchmark result (score 0.75–0.95)",
            "datasets.create": "Returns a synthetic dataset with 50 entries",
            "health": "Returns healthy status for all dependencies",
        },
    }


# ──────────────────────────────────────────────────────────────────────────
# Mock endpoint dispatcher
# ──────────────────────────────────────────────────────────────────────────


def _mock_endpoint(
    endpoint: str, method: str, body: dict[str, Any]
) -> tuple[dict[str, Any] | str, int, list[str] | None]:
    """Return a mocked response for a sandboxed API call."""
    normalized = endpoint.lower().rstrip("/")

    def _extract_id_from_path(prefix: str) -> str:
        """Extract an ID from a path like /v1/jobs/job_123 or /v1/jobs/job_123/stream."""
        # Remove prefix and any trailing segments like /stream
        remainder = normalized[len(prefix):].lstrip("/")
        return remainder.split("/")[0] if remainder else "unknown"

    # Jobs
    if normalized == "/v1/jobs" and method == "POST":
        job_id = f"job_sandbox_{secrets.token_hex(6)}"
        return (
            {
                "object": "job",
                "id": job_id,
                "status": "queued",
                "message": "Job queued in sandbox mode (no real LLM calls)",
                "meta": {"request_id": f"req_{secrets.token_hex(8)}", "api_version": "2026-05-29"},
            },
            201,
            ["Sandbox: job creation is simulated. No real environment will be generated."],
        )

    if "/v1/jobs/" in normalized and method == "GET":
        if "/stream" in normalized:
            job_id = _extract_id_from_path("/v1/jobs")
            return (
                {
                    "object": "job_stream",
                    "id": job_id,
                    "events": [
                        {"type": "stage_change", "stage": "design", "at": "2026-05-29T12:00:00Z"},
                        {"type": "stage_change", "stage": "generate", "at": "2026-05-29T12:02:00Z"},
                        {"type": "stage_change", "stage": "validate", "at": "2026-05-29T12:04:00Z"},
                        {"type": "complete", "outcome_tier": "gold", "at": "2026-05-29T12:05:00Z"},
                    ],
                },
                200,
                ["Sandbox: stream events are synthetic."],
            )
        job_id = _extract_id_from_path("/v1/jobs")
        return (
            {
                "object": "job",
                "id": job_id,
                "status": "completed",
                "current_stage": "validate",
                "outcome_tier": "gold",
                "created_at": "2026-05-29T12:00:00Z",
                "updated_at": "2026-05-29T12:05:00Z",
                "stage_history": [
                    {"from": None, "to": "design", "at": "2026-05-29T12:00:00Z"},
                    {"from": "design", "to": "generate", "at": "2026-05-29T12:02:00Z"},
                    {"from": "generate", "to": "validate", "at": "2026-05-29T12:04:00Z"},
                ],
            },
            200,
            None,
        )

    # Environments
    if normalized == "/v1/environments" and method == "POST":
        env_id = f"env_sandbox_{secrets.token_hex(6)}"
        return (
            {
                "object": "environment",
                "id": env_id,
                "description": body.get("description", "Sandbox environment"),
                "framework": body.get("framework", "gymnasium"),
                "language": body.get("language", "python"),
                "code": "# Sandbox environment\\nclass SandboxEnv:\\n    def reset(self):\\n        return {}\\n    def step(self, action):\\n        return {}, 0, False, False, {}",
                "tests": [{"name": "test_reset", "passed": True}],
                "provenance": {"model": "sandbox-mock", "prompt_hash": "sandbox"},
            },
            201,
            ["Sandbox: environment is synthetic. No real code was generated."],
        )

    if "/v1/environments/" in normalized and method == "GET":
        env_id = _extract_id_from_path("/v1/environments")
        return (
            {
                "object": "environment",
                "id": env_id,
                "description": "A sandbox test environment",
                "framework": "gymnasium",
                "language": "python",
                "code": "# Synthetic environment code for sandbox testing\\nclass TestEnv:\\n    pass",
                "tests": [{"name": "test_reset", "passed": True}, {"name": "test_step", "passed": True}],
            },
            200,
            None,
        )

    # Benchmarks
    if normalized == "/v1/benchmarks" and method == "POST":
        bench_id = f"bench_sandbox_{secrets.token_hex(6)}"
        return (
            {
                "object": "benchmark",
                "id": bench_id,
                "name": body.get("name", "Sandbox Benchmark"),
                "status": "created",
            },
            201,
            None,
        )

    if normalized.startswith("/v1/benchmarks/") and "/execute" in normalized and method == "POST":
        score = round(random.uniform(0.75, 0.95), 3)
        return (
            {
                "object": "benchmark_result",
                "id": f"br_sandbox_{secrets.token_hex(6)}",
                "score": score,
                "passed_tests": 42,
                "failed_tests": 3,
                "metrics": {"accuracy": score, "latency_ms": 850},
            },
            200,
            [f"Sandbox: benchmark score is randomised ({score})."],
        )

    # Datasets
    if normalized == "/v1/datasets" and method == "POST":
        ds_id = f"ds_sandbox_{secrets.token_hex(6)}"
        return (
            {
                "object": "dataset",
                "id": ds_id,
                "name": body.get("name", "Sandbox Dataset"),
                "entry_count": 50,
                "format": "jsonl",
            },
            201,
            ["Sandbox: dataset is synthetic with 50 mock entries."],
        )

    # Observability / traces
    if normalized == "/v1/observability/traces" and method == "GET":
        return (
            {
                "object": "list",
                "data": [
                    {
                        "trace_id": f"trace_sandbox_{secrets.token_hex(6)}",
                        "realm": "sandbox",
                        "agent_id": "agent_test",
                        "started_at": "2026-05-29T12:00:00Z",
                        "outcome": "success",
                        "span_count": 12,
                        "duration_ms": 1450,
                    }
                ],
                "meta": {"total": 1, "limit": 100, "offset": 0},
            },
            200,
            None,
        )

    # Health
    if normalized == "/health" and method == "GET":
        return (
            {
                "status": "healthy",
                "version": "sandbox-0.1.0",
                "postgres": "connected",
                "qdrant": "connected",
                "redis": "connected",
                "llm": "ready",
                "sandbox": "ready",
            },
            200,
            ["Sandbox: health check returns synthetic healthy status."],
        )

    # Default: unknown endpoint
    return (
        {
            "error": {
                "type": "invalid_request_error",
                "code": "endpoint_not_implemented_in_sandbox",
                "message": f"Endpoint {method} {endpoint} is not yet mocked in the sandbox.",
                "request_id": f"req_{secrets.token_hex(8)}",
            }
        },
        501,
        ["Sandbox: this endpoint is not yet implemented in the sandbox."],
    )


# ──────────────────────────────────────────────────────────────────────────
# Utilities
# ──────────────────────────────────────────────────────────────────────────


def _fmt_ts(ts: float) -> str:
    """Format a Unix timestamp to ISO 8601 UTC string."""
    return datetime.fromtimestamp(ts, tz=UTC).isoformat().replace("+00:00", "Z")
