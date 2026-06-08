"""Pytest fixtures and configuration for Eden test suite."""

import asyncio
import json
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from eden.api.utils.auth import hash_password
from eden.config import Settings, get_settings
from eden.llm.client import CircuitBreaker, LLMResponse, OpenRouterClient, UsageStats
from eden.storage.postgres import PostgresClient


# Pre-compute a valid bcrypt hash for the test user so that verify_password
# works correctly in integration tests.
_TEST_USER_PASSWORD = "correct-password"
_TEST_USER_HASH = hash_password(_TEST_USER_PASSWORD)


# ─────────────────────────────────────────────────────────────────────────────
# Event-loop policy (required for pytest-asyncio with FastAPI)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def event_loop():
    """Create an instance of the default event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


# ─────────────────────────────────────────────────────────────────────────────
# Settings fixture (test-safe overrides)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def test_settings() -> Settings:
    """Return test-safe settings that override production defaults."""
    return Settings(
        jwt_secret="test-jwt-secret-do-not-use-in-production-ever",
        debug=True,
        postgres_host="localhost",
        postgres_db="eden_test",
        postgres_user="eden_test",
        postgres_password="eden_test",
        openrouter_api_key="test-api-key",
        qdrant_host="localhost",
        qdrant_port=6333,
        cors_origins="*",
    )


@pytest.fixture(autouse=True)
def patch_settings(test_settings: Settings):
    """Automatically patch get_settings() to return test-safe settings.

    Also patch the module-level settings imported by auth utils so that
    JWT creation/verification uses the test secret regardless of import-time
    caching.
    """
    with patch("eden.config.get_settings", return_value=test_settings):
        with patch("eden.api.utils.auth.settings", test_settings):
            with patch("eden.api.utils.rate_limit.settings", test_settings):
                yield


# ─────────────────────────────────────────────────────────────────────────────
# Mock LLM client fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def mock_llm_response() -> LLMResponse:
    """Return a standard mock LLM response."""
    return LLMResponse(
        content='{"result": "success"}',
        usage=UsageStats(
            prompt_tokens=100,
            completion_tokens=50,
            total_tokens=150,
            cost=0.001,
        ),
        model="test-model",
        finish_reason="stop",
    )


@pytest.fixture
def mock_llm_client(mock_llm_response: LLMResponse) -> MagicMock:
    """Return a mock LLM client with pre-configured async responses."""
    client = MagicMock(spec=OpenRouterClient)
    client.call = MagicMock(return_value=mock_llm_response)
    client.acall = AsyncMock(return_value=mock_llm_response)
    client.get_total_usage = MagicMock(return_value=UsageStats())
    client.get_circuit_status = MagicMock(return_value={"state": "closed"})
    client.MODEL_SLOTS = {
        "reasoning": MagicMock(primary="test-reasoning", fallback=[], max_tokens=50000),
        "code": MagicMock(primary="test-code", fallback=[], max_tokens=15000),
        "fast": MagicMock(primary="test-fast", fallback=[], max_tokens=30000),
    }
    return client


@pytest.fixture
def mock_llm_client_factory(mock_llm_response: LLMResponse):
    """Factory for creating mock LLM clients with custom responses."""
    def _factory(content: str = None, usage: UsageStats = None, model: str = None):
        client = MagicMock(spec=OpenRouterClient)
        resp = LLMResponse(
            content=content or mock_llm_response.content,
            usage=usage or mock_llm_response.usage,
            model=model or mock_llm_response.model,
            finish_reason="stop",
        )
        client.call = MagicMock(return_value=resp)
        client.acall = AsyncMock(return_value=resp)
        client.get_total_usage = MagicMock(return_value=usage or UsageStats())
        client.get_circuit_status = MagicMock(return_value={"state": "closed"})
        return client
    return _factory


# ─────────────────────────────────────────────────────────────────────────────
# Mock Postgres fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def mock_postgres_client() -> MagicMock:
    """Return a fully mocked Postgres client."""
    client = MagicMock(spec=PostgresClient)

    # Core query methods
    client.fetch = AsyncMock(return_value=[])
    client.fetchval = AsyncMock(return_value=None)
    client.execute = AsyncMock(return_value="OK")

    # Job persistence
    client.upsert_job = AsyncMock(return_value=True)
    client.get_job = AsyncMock(return_value=None)
    client.update_job_status = AsyncMock(return_value=True)
    client.list_jobs = AsyncMock(return_value=[])
    client.count_jobs = AsyncMock(return_value=0)
    client.update_job_stage_history = AsyncMock(return_value=True)

    # Checkpoint blobs
    client.insert_checkpoint_blob = AsyncMock(return_value=True)
    client.get_checkpoint_blobs = AsyncMock(return_value=[])
    client.get_checkpoint_blob = AsyncMock(return_value=None)

    # Spec persistence
    client.create_spec = AsyncMock(return_value=True)
    client.get_spec = AsyncMock(return_value=None)
    client.list_specs = AsyncMock(return_value=[])
    client.count_specs = AsyncMock(return_value=0)
    client.update_spec_status = AsyncMock(return_value=True)
    client.delete_spec = AsyncMock(return_value=True)

    # User / auth
    # Mutable test state that tests can override via side_effect injection
    _test_user_2fa_enabled = False
    _test_user_2fa_secret = None

    async def _fetchrow(query, *args):
        # Simple pattern-matching for auth queries
        if "users WHERE email" in query:
            email = args[0] if args else ""
            if email == "test@example.com":
                return {
                    "id": "user-123",
                    "email": email,
                    "password_hash": _TEST_USER_HASH,
                    "name": "Test User",
                    "two_factor_enabled": _test_user_2fa_enabled,
                    "two_factor_secret": _test_user_2fa_secret,
                    "preferred_org_id": None,
                }
            return None
        if "users WHERE id" in query:
            user_id = args[0] if args else ""
            return {
                "id": user_id,
                "email": "test@example.com",
                "name": "Test User",
                "two_factor_enabled": _test_user_2fa_enabled,
                "two_factor_secret": _test_user_2fa_secret,
                "preferred_org_id": None,
            }
        if "org_members" in query and "role" in query:
            return {"role": "owner", "name": "Test Org", "slug": "test-org", "owner_id": "user-123", "archived_at": None}
        if "two_factor_enforced" in query:
            return {"two_factor_enforced": False}
        # Password reset token lookup
        if "password_reset_token" in query:
            return None  # Default: no token found
        return None

    client.fetchrow = AsyncMock(side_effect=_fetchrow)

    async def _fetch(query, *args):
        if "organizations" in query and "org_members" in query:
            return [
                {"id": "org-123", "name": "Test Org", "slug": "test-org", "role": "owner"},
            ]
        if "org_members" in query and "two_factor_enabled" in query:
            return [
                {"id": "user-123", "email": "test@example.com", "name": "Test User",
                 "two_factor_enabled": False, "joined_at": None, "last_active_at": None},
            ]
        return []

    client.fetch = AsyncMock(side_effect=_fetch)

    return client


@pytest.fixture(autouse=True)
def patch_postgres(mock_postgres_client: MagicMock):
    """Patch get_postgres_client to return the mock."""
    with patch("eden.storage.postgres.get_postgres_client", return_value=mock_postgres_client):
        yield mock_postgres_client


# ─────────────────────────────────────────────────────────────────────────────
# Mock service fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def patch_email_service():
    """Patch email service to prevent real SMTP calls."""
    mock_service = MagicMock()
    mock_service.send_email = AsyncMock(return_value=True)
    with patch("eden.services.email_service.get_email_service", return_value=mock_service):
        # invitation_service is the canonical caller; auth.py doesn't import
        # get_email_service directly, so patching there used to AttributeError.
        with patch("eden.services.invitation_service.get_email_service", return_value=mock_service):
            yield mock_service


@pytest.fixture(autouse=True)
def patch_invite_service():
    """Patch invitation service to prevent real token verification."""
    with patch("eden.api.routes.auth.verify_invite_token", return_value=None):
        with patch("eden.services.invitation_service.verify_invite_token", return_value=None):
            yield


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI TestClient
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def api_client(patch_postgres, patch_settings) -> TestClient:
    """Return a FastAPI TestClient with mocked dependencies.

    The app is imported *inside* the fixture so that any module-level
    get_settings() calls inside eden.api.app happen while patches are
    already active, preventing production settings from being cached.
    """
    from eden.api.app import app
    return TestClient(app)


# ─────────────────────────────────────────────────────────────────────────────
# Auth helpers
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def auth_token(test_settings: Settings) -> str:
    """Return a valid JWT auth token for test user."""
    from eden.api.utils.auth import create_access_token
    return create_access_token(data={"sub": "user-123", "email": "test@example.com"})


@pytest.fixture
def auth_headers(auth_token: str) -> dict[str, str]:
    """Return headers with the auth cookie set."""
    return {"Cookie": f"authorization={auth_token}"}


@pytest.fixture
def authenticated_client(api_client: TestClient, auth_token: str) -> TestClient:
    """Return a TestClient with auth cookie pre-set."""
    api_client.cookies.set("authorization", auth_token)
    return api_client


@pytest.fixture
def mock_interviewer_agent():
    """Mock InterviewerAgent to prevent real LLM calls in spec tests."""
    mock_session = MagicMock()
    mock_session.session_id = "test-session-123"
    mock_session.checklist_state = MagicMock()
    mock_session.checklist_state.to_dict.return_value = {"readiness_score": 0.5}
    mock_session.checklist_state.readiness_score = 0.5
    mock_session.checklist_state.user_marked_complete = False
    mock_session.checklist_state.fields = {}
    mock_session.status = "active"
    mock_session.spec = None

    mock_result = MagicMock()
    mock_result.response = "Could you tell me more about the agents you need?"
    mock_result.session = mock_session
    mock_result.extracted_fields = {}
    mock_result.next_priority_fields = ["agent_count", "observation_space"]
    mock_result.ready_for_spec = False

    mock_agent = MagicMock()
    mock_agent.process_turn = AsyncMock(return_value=mock_result)
    mock_agent.generate_spec = AsyncMock(return_value={
        "meta": {"environment_class": "agent_sandbox", "novelty_assessment": "standard"},
        "environment": {"observation_space": {"type": "Box"}, "action_space": {"type": "Discrete", "n": 4}},
    })
    mock_agent.regenerate_spec = AsyncMock(return_value={
        "meta": {"environment_class": "agent_sandbox", "novelty_assessment": "standard"},
        "environment": {"observation_space": {"type": "Box"}, "action_space": {"type": "Discrete", "n": 4}},
    })

    with patch("eden.api.routes.specs.InterviewerAgent", return_value=mock_agent):
        with patch("eden.agents.interviewer.agent.InterviewerAgent", return_value=mock_agent):
            yield mock_agent


# ─────────────────────────────────────────────────────────────────────────────
# Sample data fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def sample_job_request() -> dict:
    """Return a minimal valid job request payload."""
    return {
        "description": "A simple CartPole-like environment with shaped rewards",
        "tags": ["gymnasium", "classic_control"],
        "difficulty_parameters": {},
    }


@pytest.fixture
def sample_spec_data() -> dict:
    """Return a sample spec document for testing."""
    return {
        "meta": {
            "environment_class": "agent_sandbox",
            "observation_modality": "continuous",
            "novelty_assessment": "standard",
            "design_confidence": 0.85,
        },
        "user_intent": {
            "goal": "Create a tool-use evaluation environment",
            "constraints": ["deterministic", "fast_reset"],
        },
        "environment": {
            "observation_space": {"type": "Dict", "spaces": {"position": "Box"}},
            "action_space": {"type": "Discrete", "n": 4},
            "reward_structure": {"type": "sparse"},
        },
    }


@pytest.fixture
def sample_edp() -> dict:
    """Return a sample Environment Design Proposal."""
    return {
        "meta": {
            "environment_class": "agent_sandbox",
            "novelty_assessment": "standard",
            "design_confidence": 0.85,
        },
        "environment": {
            "observation_space": {"type": "Box", "shape": [4]},
            "action_space": {"type": "Discrete", "n": 2},
            "reward_structure": {"type": "dense"},
        },
    }
