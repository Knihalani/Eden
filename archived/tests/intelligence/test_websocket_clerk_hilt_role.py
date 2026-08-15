"""S-8 + S-9 WebSocket auth + HILT role enforcement tests.

Two related fixes from the per-session fix-everything plan:

* **S-8** — ``_authenticate_ws`` used to only accept Eden-issued
  ``?token=`` JWTs and the ``access_token`` cookie. The portal now
  uses Clerk session JWTs (June 2026 cutover); without Clerk
  verification here, every Clerk-authed browser hits ``4001
  Authentication required``. The fix mirrors
  ``eden.api.deps._resolve_token_payload``: try ``verify_clerk_token``
  first, fall back to ``decode_access_token``.

* **S-9** — ``_ws_receive_commands`` used to forward ``approve`` and
  ``reject`` to the HILT controller for any authenticated caller. The
  audit requires only ``admin`` / ``owner`` of the job's org to drive
  those two commands; everyone else gets a ``command_ack`` with
  ``status="forbidden"``.

These tests pin both contracts using a stub WebSocket and patched
postgres + Clerk + decoder. S-10 (Cloudflare provider init) lives in
``test_edge_fanout_cloudflare.py``.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── helpers ──────────────────────────────────────────────────────
class _StubWebSocket:
    """Bare-bones WebSocket stub that captures what the route tried to
    send. ``receive_text`` is filled in by each test (one message per
    poll). ``close`` records the close code so the test can assert
    the auth-rejection path.
    """

    def __init__(self, token: str | None = None) -> None:
        self.query_params: dict[str, str] = {"token": token} if token else {}
        self.cookies: dict[str, str] = {}
        self.headers: dict[str, str] = {}
        self.sent: list[Any] = []
        self.closed_with: tuple[int, str] | None = None
        self._accept_called = False
        self._accept_subprotocol: str | None = None
        self.client_state = 0  # CONNECTING (matches starlette WebSocketState.CONNECTING)

    async def accept(self, subprotocol: str | None = None) -> None:
        self._accept_called = True
        self._accept_subprotocol = subprotocol

    async def send_json(self, payload: Any) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed_with = (code, reason)


# ─── S-8: _authenticate_ws accepts Clerk JWTs ─────────────────────
class TestS8ClerkJWTAuth:
    @pytest.mark.asyncio
    async def test_clerk_token_resolves_to_user_dict(self) -> None:
        from eden.api.routes.websocket import _authenticate_ws

        ws = _StubWebSocket(token="clerk_session_jwt_abc")
        clerk_payload = {"sub": "user_clerk_42", "email": "u@e.com", "name": "U"}

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token",
            return_value=clerk_payload,
        ):
            user = await _authenticate_ws(ws)

        assert user is not None
        assert user["user_id"] == "user_clerk_42"
        assert user["email"] == "u@e.com"

    @pytest.mark.asyncio
    async def test_clerk_returns_none_falls_through_to_legacy(self) -> None:
        """When Clerk isn't configured, verify_clerk_token returns
        None and we fall back to ``decode_access_token``.
        """
        from eden.api.routes.websocket import _authenticate_ws

        ws = _StubWebSocket(token="legacy_eden_jwt_xyz")
        legacy_payload = {"sub": "user_legacy_99", "email": "l@e.com", "name": "L"}

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token", return_value=None,
        ):
            with patch(
                "eden.api.utils.auth.decode_access_token",
                return_value=legacy_payload,
            ):
                user = await _authenticate_ws(ws)

        assert user is not None
        assert user["user_id"] == "user_legacy_99"

    @pytest.mark.asyncio
    async def test_clerk_takes_precedence_over_legacy(self) -> None:
        """If both paths could resolve the token, Clerk wins — the
        portal is the dominant auth path.
        """
        from eden.api.routes.websocket import _authenticate_ws

        ws = _StubWebSocket(token="any_token")
        clerk_payload = {"sub": "user_clerk", "email": "c@e.com"}
        legacy_payload = {"sub": "user_legacy", "email": "l@e.com"}

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token",
            return_value=clerk_payload,
        ) as clerk_mock:
            with patch(
                "eden.api.utils.auth.decode_access_token",
                return_value=legacy_payload,
            ) as legacy_mock:
                user = await _authenticate_ws(ws)

        assert user["user_id"] == "user_clerk"
        clerk_mock.assert_called_once()
        # Legacy must NOT be tried when Clerk succeeds.
        legacy_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_token_returns_none(self) -> None:
        from eden.api.routes.websocket import _authenticate_ws

        ws = _StubWebSocket(token=None)
        ws.cookies = {}
        user = await _authenticate_ws(ws)
        assert user is None

    @pytest.mark.asyncio
    async def test_legacy_path_still_works(self) -> None:
        """Pre-cutover callers using the access_token cookie still
        authenticate when Clerk is misconfigured.
        """
        from eden.api.routes.websocket import _authenticate_ws

        ws = _StubWebSocket(token=None)
        ws.cookies = {"access_token": "eden_jwt_cookie"}
        legacy_payload = {"sub": "user_cookie_1", "email": "k@e.com"}

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token", return_value=None,
        ):
            with patch(
                "eden.api.utils.auth.decode_access_token",
                return_value=legacy_payload,
            ):
                user = await _authenticate_ws(ws)

        assert user is not None
        assert user["user_id"] == "user_cookie_1"


# ─── Subprotocol auth (audit 2026-07-03) ──────────────────────────
class TestSubprotocolAuth:
    """``Sec-WebSocket-Protocol: eden-auth-<base64url-token>`` is the
    PREFERRED auth path on the upgrade request — query-param tokens
    leak into Vercel/Northflank edge access logs and are being
    phased out. Cookie auth remains as a back-compat path.

    The server must pick ``eden-auth-...`` on accept() so the WS
    upgrade handshake completes.
    """

    def _encode(self, token: str) -> str:
        import base64 as _b64

        return (
            "eden-auth-"
            + _b64.urlsafe_b64encode(token.encode()).rstrip(b"=").decode()
        )

    @pytest.mark.asyncio
    async def test_subprotocol_token_authenticates(self) -> None:
        from eden.api.routes.websocket import _authenticate_ws

        ws = _StubWebSocket(token=None)
        # No query-param, no cookie — only the subprotocol header.
        ws.headers = {
            "sec-websocket-protocol": (
                f"{self._encode('clerk_session_jwt_sub')}, eden-ws-v1"
            ),
        }
        clerk_payload = {"sub": "user_sub_1", "email": "s@e.com"}

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token",
            return_value=clerk_payload,
        ) as verify_mock:
            user = await _authenticate_ws(ws)

        assert user is not None
        assert user["user_id"] == "user_sub_1"
        # The base64url-decoded value must be the raw token, not the
        # wrapped form — Clerk verifies the actual JWT.
        assert verify_mock.call_args.args[0] == "clerk_session_jwt_sub"

    @pytest.mark.asyncio
    async def test_subprotocol_takes_precedence_over_query_param(self) -> None:
        """If both are present, the subprotocol wins (it's the secure path)."""
        from eden.api.routes.websocket import _authenticate_ws

        ws = _StubWebSocket(token="query_param_token")
        ws.headers = {
            "sec-websocket-protocol": self._encode("subprotocol_token"),
        }
        clerk_payload = {"sub": "user_sub_2", "email": "s@e.com"}

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token",
            return_value=clerk_payload,
        ) as verify_mock:
            user = await _authenticate_ws(ws)

        assert user["user_id"] == "user_sub_2"
        assert verify_mock.call_args.args[0] == "subprotocol_token"

    @pytest.mark.asyncio
    async def test_subprotocol_malformed_falls_through_to_query_param(self) -> None:
        """A garbage b64 suffix must not poison the upgrade; fall back
        to the legacy ``?token=`` path so a buggy client can still
        authenticate.
        """
        from eden.api.routes.websocket import _authenticate_ws

        ws = _StubWebSocket(token="legacy_query_token")
        # Trailing junk that doesn't base64-decode to utf-8.
        ws.headers = {
            "sec-websocket-protocol": "eden-auth-!!!not-base64!!!",
        }
        clerk_payload = {"sub": "user_legacy_q", "email": "l@e.com"}

        with patch(
            "eden.api.utils.clerk_auth.verify_clerk_token",
            return_value=clerk_payload,
        ):
            user = await _authenticate_ws(ws)

        assert user["user_id"] == "user_legacy_q"

    @pytest.mark.asyncio
    async def test_accept_echoes_subprotocol(self) -> None:
        """The WS spec requires the server to echo the chosen subprotocol
        on accept(). Without it, the browser closes the connection.
        """
        from eden.api.routes.websocket import _accept_with_subprotocol

        ws = _StubWebSocket()
        ws.headers = {
            "sec-websocket-protocol": (
                f"{self._encode('token_xyz')}, eden-ws-v1"
            ),
        }
        chosen = await _accept_with_subprotocol(ws)
        assert ws._accept_called is True
        assert ws._accept_subprotocol is not None
        assert ws._accept_subprotocol.startswith("eden-auth-")
        assert chosen == ws._accept_subprotocol

    @pytest.mark.asyncio
    async def test_accept_without_subprotocol_works(self) -> None:
        """Legacy clients without a subprotocol header still connect."""
        from eden.api.routes.websocket import _accept_with_subprotocol

        ws = _StubWebSocket()
        ws.headers = {}
        chosen = await _accept_with_subprotocol(ws)
        assert ws._accept_called is True
        assert ws._accept_subprotocol is None
        assert chosen is None


# ─── S-9: HILT approve / reject role gate ─────────────────────────
class TestS9HILTRoleGate:
    """Drive ``_ws_receive_commands`` through one cmd iteration by
    setting ``websocket.receive_text`` to return one message then
    raising WebSocketDisconnect (clean exit).
    """

    @pytest.fixture(autouse=True)
    def _clear_cache(self):
        """The role cache lives in module scope; clear between tests."""
        from eden.api.routes import websocket as ws_mod
        ws_mod._user_role_cache.clear()
        yield
        ws_mod._user_role_cache.clear()

    @pytest.mark.asyncio
    async def test_approve_as_admin_passes_through(self) -> None:
        from starlette.websockets import WebSocketDisconnect

        from eden.api.routes.websocket import _ws_receive_commands

        ws = _StubWebSocket()
        hilt = MagicMock()
        hilt.handle_command = AsyncMock(return_value=None)
        user = {"user_id": "user-admin-1", "email": "a@e.com"}

        # The receive loop must consume ONE message then exit.
        async def _receive_text():
            ws.received = True
            return '{"type": "approve", "id": "prop-1"}'

        ws.receive_text = _receive_text
        # Stop the loop after the first command by raising Disconnect.

        call_count = {"n": 0}

        async def _receive_then_disconnect():
            call_count["n"] += 1
            if call_count["n"] == 1:
                return '{"type": "approve", "id": "prop-1"}'
            raise WebSocketDisconnect()

        ws.receive_text = _receive_then_disconnect

        with patch(
            "eden.api.routes.websocket._hilt_privileged_for_job",
            AsyncMock(return_value=True),
        ):
            await _ws_receive_commands(ws, "job-1", hilt, user)

        # Hilt was called with APPROVE.
        hilt.handle_command.assert_any_call(
            "APPROVE", payload={"proposal_id": "prop-1"},
        )
        # Ack was "ok" — find it among sent.
        acks = [m for m in ws.sent if m.get("command") == "approve"]
        assert any(a.get("status") == "ok" for a in acks), acks

    @pytest.mark.asyncio
    async def test_approve_as_non_admin_returns_forbidden(self) -> None:
        from starlette.websockets import WebSocketDisconnect

        from eden.api.routes.websocket import _ws_receive_commands

        ws = _StubWebSocket()
        hilt = MagicMock()
        hilt.handle_command = AsyncMock(return_value=None)
        user = {"user_id": "user-member-1", "email": "m@e.com"}

        call_count = {"n": 0}

        async def _receive_then_disconnect():
            call_count["n"] += 1
            if call_count["n"] == 1:
                return '{"type": "approve", "id": "prop-1"}'
            raise WebSocketDisconnect()

        ws.receive_text = _receive_then_disconnect

        with patch(
            "eden.api.routes.websocket._hilt_privileged_for_job",
            AsyncMock(return_value=False),
        ):
            await _ws_receive_commands(ws, "job-1", hilt, user)

        # Hilt was NEVER called.
        for call in hilt.handle_command.call_args_list:
            assert call.args[0] != "APPROVE"
        # Ack was forbidden.
        acks = [m for m in ws.sent if m.get("command") == "approve"]
        assert any(a.get("status") == "forbidden" for a in acks), acks

    @pytest.mark.asyncio
    async def test_reject_as_member_returns_forbidden(self) -> None:
        from starlette.websockets import WebSocketDisconnect

        from eden.api.routes.websocket import _ws_receive_commands

        ws = _StubWebSocket()
        hilt = MagicMock()
        hilt.handle_command = AsyncMock(return_value=None)
        user = {"user_id": "user-viewer-1", "email": "v@e.com"}

        call_count = {"n": 0}

        async def _receive_then_disconnect():
            call_count["n"] += 1
            if call_count["n"] == 1:
                return '{"type": "reject", "id": "prop-2"}'
            raise WebSocketDisconnect()

        ws.receive_text = _receive_then_disconnect

        with patch(
            "eden.api.routes.websocket._hilt_privileged_for_job",
            AsyncMock(return_value=False),
        ):
            await _ws_receive_commands(ws, "job-1", hilt, user)

        for call in hilt.handle_command.call_args_list:
            assert call.args[0] != "REJECT"
        acks = [m for m in ws.sent if m.get("command") == "reject"]
        assert any(a.get("status") == "forbidden" for a in acks), acks

    @pytest.mark.asyncio
    async def test_pause_remains_open_to_all_authenticated(self) -> None:
        """Non-privileged users can still drive pause / resume / step /
        inject — only approve/reject are gated.
        """
        from starlette.websockets import WebSocketDisconnect

        from eden.api.routes.websocket import _ws_receive_commands

        ws = _StubWebSocket()
        hilt = MagicMock()
        hilt.handle_command = AsyncMock(return_value=None)
        user = {"user_id": "user-member-1", "email": "m@e.com"}

        call_count = {"n": 0}

        async def _receive_then_disconnect():
            call_count["n"] += 1
            if call_count["n"] == 1:
                return '{"type": "pause"}'
            raise WebSocketDisconnect()

        ws.receive_text = _receive_then_disconnect

        # NO role patch — pause must not trigger the role lookup.
        with patch(
            "eden.api.routes.websocket._hilt_privileged_for_job",
            AsyncMock(return_value=False),
        ) as role_check:
            await _ws_receive_commands(ws, "job-1", hilt, user)

        hilt.handle_command.assert_any_call("PAUSE", payload={"type": "pause"})
        role_check.assert_not_called()

    @pytest.mark.asyncio
    async def test_no_user_short_circuits_to_false(self) -> None:
        from eden.api.routes.websocket import _hilt_privileged_for_job

        assert await _hilt_privileged_for_job(None, "job-1") is False
        assert await _hilt_privileged_for_job({}, "job-1") is False
        assert await _hilt_privileged_for_job({"user_id": ""}, "job-1") is False
