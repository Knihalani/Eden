"""Pytest fixtures and configuration for Eden test suite."""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

# Pre-existing passlib 1.7.4 + bcrypt 5.x incompatibility: passlib's
# ``_finalize_backend_mixin`` runs a wrap-bug-detection probe that
# calls ``bcrypt.hashpw`` with a >72-byte secret, which bcrypt 5.x
# rejects. The probe is a one-time diagnostic, not a security check.
# We no-op the finalize step so the password hash step (in our auth
# helpers) can run during tests.
import passlib.handlers.bcrypt as _bcrypt_mod  # noqa: E402

if hasattr(_bcrypt_mod, "_BcryptCommon"):
    @classmethod  # type: ignore[misc]
    def _noop_finalize(cls, backend, dryrun):  # noqa: ARG001
        return True

    _bcrypt_mod._BcryptCommon._finalize_backend_mixin = _noop_finalize  # type: ignore[assignment]

    # bcrypt 5.x removed the ``__about__`` attribute; passlib 1.7.4
    # still reads it. Provide a minimal shim.
    try:
        import bcrypt as _bcrypt_pkg  # noqa: E402

        if not hasattr(_bcrypt_pkg, "__about__"):
            class _AboutShim:
                __version__ = getattr(_bcrypt_pkg, "__version__", "5.x")
            _bcrypt_pkg.__about__ = _AboutShim  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from eden.api.utils.auth import hash_password
from eden.config import Settings, get_settings
from eden.llm.client import CircuitBreaker, LLMResponse, OpenRouterClient, UsageStats
from eden.storage.postgres import PostgresClient

# Pre-compute a valid bcrypt hash for the test user so that verify_password
# works correctly in integration tests.
_TEST_USER_PASSWORD = "correct-password"
_TEST_USER_HASH = hash_password(_TEST_USER_PASSWORD)


# ─────────────────────────────────────────────────────────────────────────────
# Event-loop policy
# ─────────────────────────────────────────────────────────────────────────────
# pytest-asyncio 0.26+ manages the event loop itself and warns when
# a user-provided ``event_loop`` fixture overrides its policy. The
# previous session-scoped override (here) caused cross-test loop
# pollution: a test that called ``asyncio.run`` or hung up a
# pending task would leave the loop in an inconsistent state, and
# later tests would observe coroutines as "never awaited". Letting
# pytest-asyncio own the loop (function-scoped, default) eliminates
# that class of failure.


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
        # Disable Redis in the rate-limit middleware so it falls
        # back to the in-memory bucket immediately rather than
        # attempting a connection that fails the whole request.
        # Pre-fix the integration suite required a running Redis
        # on localhost:6379; the test_settings redis_url default
        # is ``redis://localhost:6379/0`` and the middleware's
        # from_url() surfaced a ConnectionError before the route
        # ever ran.
        redis_url="",
        # The 413 test sends a 1.1 MiB body and expects the
        # ingestion route to reject it. The production cap is
        # 5 MiB; tighten it to 1 MiB for the integration suite
        # so the test exercises the actual guard logic.
        ingestion_max_body_bytes=1_000_000,
    )


@pytest.fixture(autouse=True)
def patch_settings(test_settings: Settings):
    """Automatically patch get_settings() to return test-safe settings.

    Also patch the module-level settings imported by auth utils so that
    JWT creation/verification uses the test secret regardless of import-time
    caching.

    Also patches the module-level settings cached at import time by
    the rate-limit middleware (``tenant_rate_limit.py:30`` reads
    ``get_settings()`` at module load, so the autouse fixture's
    patch on the function doesn't reach the cached attribute).
    """
    with patch("eden.config.get_settings", return_value=test_settings):
        with patch("eden.api.utils.auth.settings", test_settings):
            try:
                with patch("eden.api.utils.rate_limit.settings", test_settings, create=True):
                    pass
            except (AttributeError, ModuleNotFoundError):
                pass
            # Override the cached ``settings`` attribute on every
            # middleware module that captured ``get_settings()`` at
            # import time. tenant_rate_limit.py:30 is the worst
            # offender — without this the middleware hits
            # ``localhost:6379`` even though test_settings.redis_url=""
            try:
                from eden.api.middleware import tenant_rate_limit as _trl

                _trl.settings = test_settings
                # Drop the per-instance Redis client cache so the
                # middleware re-reads the (now-empty) redis_url on
                # the next request.
                for _mw in (
                    getattr(_trl, "_middleware_instances", None) or []
                ):
                    _mw._redis = False  # sentinel: skip Redis entirely
            except Exception:
                pass
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
        # Test extensions: tests can append ``(query_substr, row)``
        # tuples to ``client._fetchrow_overrides`` to override the
        # default behaviour for specific queries. We pop the first
        # match so a single test can chain several overrides and
        # the rest fall back to the conftest defaults.
        overrides = getattr(client, "_fetchrow_overrides", None)
        if overrides:
            for i, (needle, row) in enumerate(list(overrides)):
                if needle in query:
                    overrides.pop(i)
                    return row
        # INSERTs with RETURNING: the conftest's consumer modules
        # expect a row back. The route does ``row["id"]`` so we
        # always return a deterministic synthetic id derived from
        # the query + first arg (so multiple INSERTs in one test
        # each get their own id).
        if "INSERT INTO" in query and "RETURNING" in query:
            seed = f"{query}::{args[0] if args else ''}"
            return {
                "id": f"row-{abs(hash(seed)) % 10**10:010d}",
            }
        # Simple pattern-matching for auth queries
        if "users WHERE email" in query:
            email = args[0] if args else ""
            if email == "test@example.com":
                return {
                    "id": "user-123",
                    "email": email,
                    "password_hash": _TEST_USER_HASH,
                    "name": "Test User",
                    "failed_login_count": 0,
                    "locked_until": None,
                    "last_failed_login_at": None,
                    "token_version": 1,
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
                "token_version": 1,
                "two_factor_enabled": _test_user_2fa_enabled,
                "two_factor_secret": _test_user_2fa_secret,
                "preferred_org_id": None,
            }
        # June 22 2026: ``get_user_by_id`` now resolves by either
        # ``id`` (UUID) or ``clerk_id`` (TEXT, Clerk's string id),
        # so the WHERE clause uses ``::text`` cast for parameterised
        # lookup. The conftest's existing ``users WHERE id`` substring
        # match above doesn't catch this — add the explicit match
        # for the new clause shape. The default test user still has
        # the same synthetic row regardless of which column we look
        # up by, so we return the same shape.
        if "users WHERE id::text" in query or "users WHERE clerk_id::text" in query:
            user_id = args[0] if args else ""
            return {
                "id": user_id if user_id else "user-123",
                "email": "test@example.com",
                "name": "Test User",
                "two_factor_enabled": _test_user_2fa_enabled,
                "two_factor_secret": _test_user_2fa_secret,
                "preferred_org_id": None,
                "clerk_id": user_id if "clerk_id" in query else None,
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
    # ``_fetchrow_overrides`` is a per-test queue of (needle, row)
    # pairs that takes precedence over the default side_effect
    # handlers in ``_fetchrow``. Tests extend this list to inject
    # custom rows for specific queries without losing the
    # conftest's default auth + org-membership lookups.
    client._fetchrow_overrides = []

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

    # ``async with client.acquire() as conn`` — PostgresClient.acquire
    # is an async generator in production. Tests use it via the
    # ``conn`` reference for fetchrow/execute/transaction. Provide a
    # real async-CM so the test fixtures don't surface
    # "coroutine never awaited" warnings when consumers do
    # ``async with client.acquire()``.
    @asynccontextmanager
    async def _acquire():
        conn = AsyncMock()
        conn.transaction = _noop_acm
        yield conn

    @asynccontextmanager
    async def _noop_acm():
        yield None

    client.acquire = _acquire

    return client


@pytest.fixture(autouse=True)
def patch_postgres(mock_postgres_client: MagicMock):
    """Patch get_postgres_client to return the mock.

    The auth and other routes do ``from eden.storage.postgres import
    get_postgres_client`` which captures the function reference at
    import time. A naive ``patch("eden.storage.postgres.get_postgres_client")``
    only swaps the attribute on the source module — the route's
    local binding still points at the real (DB-connecting) function,
    so the integration tests would talk to a real asyncpg connection.

    To fix this, we additionally patch ``get_postgres_client`` in
    every module that imports it at module level. We discover the
    consumer modules by AST-walking the eden source tree at fixture-
    setup time. Only top-level imports count (function-local imports
    are not module attributes and would cause ``AttributeError`` on
    patch). The discovery is cached so this stays O(1) on subsequent
    tests.
    """
    import ast
    import os
    from contextlib import ExitStack

    consumer_attr = "_patch_postgres_consumers"
    if not hasattr(patch_postgres, consumer_attr):
        src_root = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "src",
            "eden",
        )
        consumers: set[str] = set()
        for dirpath, _dirs, files in os.walk(src_root):
            for f in files:
                if not f.endswith(".py"):
                    continue
                full = os.path.join(dirpath, f)
                with open(full, encoding="utf-8", errors="ignore") as fh:
                    try:
                        src = fh.read()
                    except Exception:
                        continue
                try:
                    tree = ast.parse(src, filename=full)
                except SyntaxError:
                    continue
                found = False
                for node in tree.body:
                    if not isinstance(node, ast.ImportFrom):
                        continue
                    if node.module != "eden.storage.postgres":
                        continue
                    for alias in node.names:
                        if alias.name == "get_postgres_client":
                            found = True
                            break
                    if found:
                        break
                if not found:
                    continue
                rel = os.path.relpath(full, os.path.dirname(src_root))
                mod = rel[:-3].replace(os.sep, ".")
                if mod.endswith(".__init__"):
                    mod = mod[: -len(".__init__")]
                consumers.add(mod)
        # Source module itself (so any future `eden.storage.postgres.get_postgres_client()`
        # call site also sees the patch).
        consumers.add("eden.storage.postgres")
        setattr(patch_postgres, consumer_attr, consumers)

    consumers = getattr(patch_postgres, consumer_attr)
    stack = ExitStack()
    # Patch each consumer module's `get_postgres_client` attribute.
    # We ``import_module`` first so the parent package has the
    # submodule as an attribute (``patch`` walks the dotted path and
    # raises AttributeError if any segment isn't already an attribute
    # of the parent module). Empty ``__init__.py`` files in this
    # project mean submodules are not auto-registered.
    import importlib
    for mod_name in consumers:
        try:
            importlib.import_module(mod_name)
        except Exception:
            # If the module can't be imported (transitive dep missing
            # in the test env, etc.), skip it — the test will surface
            # the real failure mode.
            continue
        stack.enter_context(
            patch(
                f"{mod_name}.get_postgres_client",
                AsyncMock(return_value=mock_postgres_client),
            )
        )
    try:
        yield mock_postgres_client
    finally:
        stack.close()


# ─────────────────────────────────────────────────────────────────────────────
# Mock service fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def patch_email_service():
    """Patch email service to prevent real SMTP calls."""
    mock_service = MagicMock()
    mock_service.send_email = AsyncMock(return_value=True)
    with patch("eden.services.email_service.get_email_service", return_value=mock_service):
        # invitation_service is the canonical caller. The legacy auth
        # router may also reference get_email_service in 7.0 — guarded with
        # ``create=True`` and try/except so the autouse fixture doesn't
        # crash on either shape.
        try:
            with patch("eden.services.invitation_service.get_email_service", return_value=mock_service):
                yield mock_service
        except (AttributeError, ModuleNotFoundError):
            pass


@pytest.fixture(autouse=True)
def patch_invite_service():
    """Patch invitation service to prevent real token verification."""
    with patch("eden.services.invitation_service.verify_invite_token", return_value=None):
        try:
            with patch("eden.api.routes.auth.verify_invite_token", return_value=None, create=True):
                yield
        except (AttributeError, ModuleNotFoundError):
            yield


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI TestClient
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def reset_rate_limit():
    """Reset the :class:`TenantRateLimitMiddleware` buckets per test.

    The middleware stores per-tenant token buckets in a
    process-global dict; without this reset, the Nth integration
    test in a session gets 429'd even though its own request count
    is well below the 60 req / 60s limit (every previous test
    consumed from the same bucket).

    Audit 2026-06-23: this fixture unblocks the gateway streaming
    + completion tests that were silently failing on CI with
    ``429 Too Many Requests``. The ``reset_buckets`` hook was added
    to the middleware in the same audit.

    Implementation: FastAPI stores middleware specs in
    ``app.user_middleware`` but the live instance is only built
    lazily when ``app.middleware_stack`` is constructed. We poke
    ``middleware_stack`` once to force the build, then walk it to
    find the live :class:`TenantRateLimitMiddleware` and reset it.

    Also resets the per-IP / per-email auth limiters in
    :mod:`eden.api.utils.rate_limit` so cross-test pollution on the
    login/signup/forgot-password buckets doesn't leak.
    """
    from eden.api.app import app
    try:
        # Force middleware_stack to build (lazy).
        _ = app.middleware_stack
        stack = app.middleware_stack
        # middleware_stack is a chain of ``ServerErrorMiddleware``,
        # ``[_Middleware]``, ``ExceptionMiddleware``, ``Router``.
        # Walk it and reset every TenantRateLimitMiddleware found.
        node = stack
        seen: set[int] = set()
        while node is not None and id(node) not in seen:
            seen.add(id(node))
            if (
                hasattr(node, "reset_buckets")
                and node.__class__.__name__ == "TenantRateLimitMiddleware"
            ):
                node.reset_buckets()
            # ASGI middleware chains via .app
            node = getattr(node, "app", None)
    except Exception:
        pass

    # Reset the per-IP / per-email auth limiters used by the
    # /auth/login, /auth/signup, /auth/forgot-password endpoints.
    try:
        from eden.api.utils.rate_limit import (
            login_email_limiter,
            login_limiter,
            password_reset_limiter,
            signup_limiter,
            totp_disable_limiter,
            totp_setup_limiter,
            totp_verify_limiter,
        )
        for limiter in (
            login_limiter,
            login_email_limiter,
            signup_limiter,
            password_reset_limiter,
            totp_verify_limiter,
            totp_setup_limiter,
            totp_disable_limiter,
        ):
            limiter._buckets.clear()
    except Exception:
        pass
    yield


@pytest.fixture
def api_client(patch_postgres, patch_settings) -> TestClient:
    """Return a FastAPI TestClient with mocked dependencies.

    The app is imported *inside* the fixture so that any module-level
    get_settings() calls inside eden.api.app happen while patches are
    already active, preventing production settings from being cached.

    Pre-sets the ``authorization`` cookie so the default-deny
    middleware accepts the request (it inspects the request scope
    BEFORE FastAPI dep-overrides take effect). Tests that need a
    different auth state can call ``client.cookies.clear()``
    themselves.
    """
    from eden.api.app import app
    client = TestClient(app)
    client.cookies.set("authorization", "test-token-for-default-deny")
    return client


# ─────────────────────────────────────────────────────────────────────────────
# Auth helpers
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def auth_token(test_settings: Settings) -> str:
    """Return a valid JWT auth token for test user."""
    from eden.api.utils.auth import create_access_token
    return create_access_token(
        data={"sub": "user-123", "email": "test@example.com"},
        token_version=1,
    )


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
def unauthenticated_client(api_client: TestClient) -> TestClient:
    """Return a TestClient with no auth cookie set.

    Tests that exercise auth gates (e.g. ``GET /export/destinations``
    without a cookie) can use this fixture to assert 401 responses
    without manually clearing the cookie on the shared ``api_client``.
    """
    api_client.cookies.clear()
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
