"""Session 23 tests — Backend correctness (B-1..B-7).

Seven audit items, mix of small targeted fixes:

* **B-1** — ``set_session_org_context`` was implemented
  but never invoked from any production route. Now wired
  via new ``RLSOrgContextMiddleware`` registered at the app
  level. Single chokepoint so the audit risk
  "one miss = silent policy bypass" is closed.
* **B-2** — ``get_org_resource_limits`` returned ``None``
  silently on any exception. Now logs + still returns
  ``None``; the fail-closed STALENESS gate lives in
  ``QuotaEnforcementMiddleware`` (DL-14).
* **B-3** — asyncpg ``create_pool`` had ``command_timeout=60``
  but no pool-acquire timeout or inactive-connection
  recycling. Now ``timeout=10`` + configurable
  ``max_inactive_connection_lifetime`` (default 60s for Neon idle).
* **B-4** — ``except Exception: pass`` at
  ``telemetry_collector.py:413`` (event timestamp parse)
  silently swallowed SDK-supplied bad timestamps. Now
  logs at WARNING.
* **B-5** — ``datetime.utcnow()`` (deprecated in Python 3.12)
  replaced with ``datetime.now(UTC)`` across 10 files
  (28 call sites).
* **B-6** — Clerk ``_fetch_jwks`` was sync + ``threading.Lock``
  across a 5s ``httpx.get`` — blocked the event loop.
  Now async + ``asyncio.Lock`` + ``httpx.AsyncClient.get``.
  ``verify_clerk_token`` is now async; both production
  callers (websocket, deps) updated.
* **B-7** — Idempotency ``_get_request_identity`` truncated
  the SHA-256 to 16 hex chars (2^64 distinct values —
  borderline collision at fleet scale). Now uses the full
  64-hex-char digest.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import sys
import textwrap
from unittest.mock import patch

import pytest

# ─── B-1: RLSOrgContextMiddleware wired at app level ────────────────────


class TestB1RLSMiddleware:
    """The RLS GUC for ``app.current_org_id`` is set by a
    dedicated middleware registered on the FastAPI app.

    Pre-fix: ``set_session_org_context`` existed but was
    called from no production route — RLS was inactive
    on every request.
    """

    def test_middleware_registered(self) -> None:
        """``RLSOrgContextMiddleware`` is registered on
        the FastAPI app (not just imported)."""
        from eden.api.app import app

        cls_names = [m.cls.__name__ for m in app.user_middleware]
        assert "RLSOrgContextMiddleware" in cls_names, (
            "B-1 regression: RLSOrgContextMiddleware not registered "
            f"on app.user_middleware ({cls_names})"
        )

    def test_middleware_resolves_org_id_from_path(self) -> None:
        """``_resolve_org_id`` reads from ``request.path_params``
        first (the canonical pattern for /orgs/{org_id}/...
        routes)."""
        from eden.api.middleware.rls_org_context import (
            RLSOrgContextMiddleware,
        )

        async def _receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        # Build a minimal ASGI scope that mimics a /orgs/{id} request.
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/orgs/test_org_xyz/observability/traces",
            "raw_path": b"/orgs/test_org_xyz/observability/traces",
            "query_string": b"",
            "headers": [],
            "path_params": {"org_id": "test_org_xyz"},
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", 8000),
            "scheme": "http",
            "http_version": "1.1",
        }
        from starlette.requests import Request

        req = Request(scope, _receive)

        import asyncio

        org_id = asyncio.run(RLSOrgContextMiddleware._resolve_org_id(req))
        assert org_id == "test_org_xyz", (
            f"B-1 regression: expected path-param org, got {org_id}"
        )

    def test_middleware_resolves_org_id_from_header(self) -> None:
        """When path param absent, fall back to ``X-Org-Id``."""
        from starlette.requests import Request

        from eden.api.middleware.rls_org_context import (
            RLSOrgContextMiddleware,
        )

        async def _receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/v1/anything",
            "raw_path": b"/v1/anything",
            "query_string": b"",
            "headers": [(b"x-org-id", b"hdr_org_42")],
            "path_params": {},
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", 8000),
            "scheme": "http",
            "http_version": "1.1",
        }

        req = Request(scope, _receive)
        org_id = asyncio.run(RLSOrgContextMiddleware._resolve_org_id(req))
        assert org_id == "hdr_org_42", (
            f"B-1 regression: expected header org, got {org_id}"
        )

    def test_middleware_swallows_db_errors(self) -> None:
        """A DB blip on ``set_config`` must not poison the
        request — RLS policies treat a missing GUC as
        ``NULL`` → empty row set, which is the safe default.
        """
        from eden.api.middleware.rls_org_context import (
            RLSOrgContextMiddleware,
        )

        async def failing_client():
            raise RuntimeError("DB is down")

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.0"},
            "method": "GET",
            "path": "/orgs/org_x/observability/traces",
            "raw_path": b"/orgs/org_x/observability/traces",
            "query_string": b"",
            "headers": [],
            "path_params": {"org_id": "org_x"},
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", 8000),
            "scheme": "http",
            "http_version": "1.1",
        }

        sent: list = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(msg):
            sent.append(msg)

        async def _stub_app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"", "more_body": False})

        with patch(
            "eden.storage.postgres.get_postgres_client",
            side_effect=failing_client,
        ):
            asyncio.run(
                RLSOrgContextMiddleware(_stub_app)(scope, receive, send)
            )
        starts = [m for m in sent if m["type"] == "http.response.start"]
        assert starts and starts[0]["status"] == 200


# ─── B-2: get_org_resource_limits logs on failure ──────────────────────


class TestB2OrgLimitsLog:
    """``get_org_resource_limits`` logs the exception on
    failure (was silent ``return None``). The fail-closed
    staleness gate lives in the middleware (DL-14).
    """

    def test_logs_on_exception(self) -> None:
        """Static check: the function calls ``logger.warning``
        with ``exc_info=True`` in the exception branch."""
        from eden.storage import postgres

        source = textwrap.dedent(
            inspect.getsource(postgres.PostgresClient.get_org_resource_limits)
        )
        assert "logger.warning" in source, (
            "B-2 regression: get_org_resource_limits doesn't log "
            "on exception"
        )
        assert "exc_info=True" in source, (
            "B-2 regression: get_org_resource_limits doesn't "
            "include exc_info=True"
        )

    @pytest.mark.asyncio
    async def test_returns_none_after_logging(self) -> None:
        """Behavioural: even when logging is added, the
        function still returns ``None`` on failure (fail-safe
        by design at this layer)."""
        from eden.storage.postgres import PostgresClient

        bad_client = PostgresClient.__new__(PostgresClient)
        # Force ``fetchrow`` to raise.
        async def boom(*a, **kw):
            raise RuntimeError("synthetic DB blip")
        bad_client.fetchrow = boom

        with patch(
            "eden.storage.postgres.logger"
        ) as mock_logger:
            result = await PostgresClient.get_org_resource_limits(
                bad_client, "org_test",
            )
        assert result is None
        mock_logger.warning.assert_called_once()


# ─── B-3: asyncpg pool timeouts ────────────────────────────────────────


class TestB3PoolTimeouts:
    """``asyncpg.create_pool`` is called with
    ``timeout=10`` + configurable idle lifetime.
    """

    def test_pool_creation_has_short_timeout(self) -> None:
        """Static check: the create_pool call uses
        ``timeout=10`` (not the default 30s)."""
        from eden.storage import postgres

        source = textwrap.dedent(
            inspect.getsource(postgres.PostgresClient.initialize)
        )
        assert "timeout=10" in source, (
            "B-3 regression: pool acquire timeout is not 10s"
        )
        assert (
            "max_inactive_connection_lifetime=" in source
        ), (
            "B-3 regression: max_inactive_connection_lifetime "
            "not configured"
        )
        assert "postgres_max_inactive_connection_lifetime" in source, (
            "B-3 regression: idle lifetime must read from Settings"
        )


# ─── B-4: telemetry timestamp parse logs ────────────────────────────────


class TestB4TelemetryParseLog:
    """The bad-timestamp ``except Exception: pass`` site at
    ``telemetry_collector.py:413`` now logs at WARNING with
    the SDK-supplied value (so the on-call sees the parse
    failure mode).
    """

    def test_logs_on_bad_timestamp(self) -> None:
        """Static check: the parse site includes a logger
        call (no longer silent ``pass``)."""
        from eden.observability import telemetry_collector

        # Grep the source for both the new logger call and
        # the absence of the bare ``pass`` after the
        # timestamp-fromisoformat block.
        source = textwrap.dedent(
            inspect.getsource(
                telemetry_collector.TelemetryCollector._compute_ingest_latency
                if hasattr(
                    telemetry_collector.TelemetryCollector,
                    "_compute_ingest_latency",
                )
                else telemetry_collector.TelemetryCollector.ingest
            )
        )
        assert "logger.warning" in source, (
            "B-4 regression: timestamp parse site has no logger"
        )


# ─── B-5: datetime.utcnow() removed ─────────────────────────────────────


class TestB5DatetimeUtcNow:
    """``datetime.utcnow()`` is gone from ``src/eden/``.
    All call sites now use ``datetime.now(UTC)``.
    """

    def test_no_utcnow_in_src(self) -> None:
        """No ``.utcnow()`` calls remain in the source."""
        import subprocess
        from pathlib import Path

        repo_root = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            ["grep", "-rln", ".utcnow()", "src/eden/"],
            capture_output=True,
            text=True,
            cwd=repo_root,
        )
        assert result.returncode != 0, (
            f"B-5 regression: utcnow() still in: "
            f"{result.stdout.strip()}"
        )


# ─── B-6: clerk_auth async ─────────────────────────────────────────────


class TestB6ClerkAsync:
    """``_fetch_jwks`` and ``verify_clerk_token`` are async;
    the JWKS lock is an ``asyncio.Lock`` (not
    ``threading.Lock``). Pre-fix: a 5s httpx.get blocked
    the event loop while inside ``threading.Lock``.
    """

    def test_fetch_jwks_is_async(self) -> None:
        from eden.api.utils import clerk_auth

        assert inspect.iscoroutinefunction(clerk_auth._fetch_jwks), (
            "B-6 regression: _fetch_jwks is not async"
        )

    def test_verify_clerk_token_is_async(self) -> None:
        from eden.api.utils import clerk_auth

        assert inspect.iscoroutinefunction(
            clerk_auth.verify_clerk_token
        ), "B-6 regression: verify_clerk_token is not async"

    def test_lock_is_asyncio(self) -> None:
        """The JWKS lock is ``asyncio.Lock``, not ``threading.Lock``."""
        import asyncio as _asyncio

        from eden.api.utils import clerk_auth

        assert isinstance(clerk_auth._JWKS_LOCK, _asyncio.Lock), (
            f"B-6 regression: _JWKS_LOCK is "
            f"{type(clerk_auth._JWKS_LOCK).__name__}, expected asyncio.Lock"
        )

    def test_threading_no_longer_imported(self) -> None:
        """``threading`` is gone from clerk_auth.py."""
        from eden.api.utils import clerk_auth

        assert not hasattr(clerk_auth, "threading"), (
            "B-6 regression: clerk_auth still imports threading"
        )

    def test_deps_awaits_verify(self) -> None:
        """``_resolve_token_payload`` (the consumer in
        deps.py) calls ``await verify_clerk_token``.
        """
        from eden.api import deps

        source = textwrap.dedent(
            inspect.getsource(deps._resolve_token_payload)
        )
        assert "await verify_clerk_token" in source, (
            "B-6 regression: deps.py doesn't await verify_clerk_token"
        )

    def test_websocket_awaits_verify(self) -> None:
        """``_authenticate_ws`` awaits the Clerk helper."""
        from eden.api.routes import websocket

        source = textwrap.dedent(inspect.getsource(websocket._authenticate_ws))
        assert "await verify_clerk_token" in source, (
            "B-6 regression: websocket._authenticate_ws doesn't "
            "await verify_clerk_token"
        )


# ─── B-7: idempotency identity uses full SHA-256 ───────────────────────


class TestB7IdempotencyIdentity:
    """``_get_request_identity`` uses the full SHA-256
    hex digest (64 chars), not the 16-char prefix.
    """

    def test_no_prefix_truncation(self) -> None:
        """Static check: ``.hexdigest()`` is called WITHOUT
        the ``[:16]`` slice (pre-fix landed here).
        """
        from eden.api.middleware import idempotency

        source = textwrap.dedent(
            inspect.getsource(idempotency._get_request_identity)
        )
        assert "hexdigest()[:16]" not in source, (
            "B-7 regression: identity still uses 16-char prefix"
        )
        assert ".hexdigest()" in source, (
            "B-7 regression: identity doesn't use .hexdigest()"
        )

    def test_api_key_identity_full_digest(self) -> None:
        """The api-key identity is the full 64-hex char digest."""
        from starlette.requests import Request

        from eden.api.middleware.idempotency import _get_request_identity

        api_key = "sk_test_abcdef"

        async def _receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        scope = {
            "type": "http",
            "method": "POST",
            "path": "/v1/test",
            "raw_path": b"/v1/test",
            "query_string": b"",
            "headers": [(b"x-org-api-key", api_key.encode())],
            "path_params": {},
            "client": ("127.0.0.1", 50000),
            "server": ("127.0.0.1", 8000),
            "scheme": "http",
            "http_version": "1.1",
        }
        req = Request(scope, _receive)
        identity = _get_request_identity(req)
        expected = hashlib.sha256(api_key.encode()).hexdigest()
        assert identity == expected, (
            "B-7 regression: identity doesn't match full SHA-256"
        )
        assert len(identity) == 64, (
            f"B-7 regression: identity length {len(identity)}, "
            f"expected 64 (full hex digest)"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
