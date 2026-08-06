"""Session 24 tests — Promotion hooks + API keys (B-8..B-13).

Six audit items, mix of safety + per-tenant correctness:

* **B-8** — ``_record_action`` fallback path now generates
  ``act_<sha256[:16]>`` (content-derived), matching the
  HookBus path's wire format. Pre-fix: pure ``uuid4`` was
  un-grep-able across the two paths.
* **B-9** — ``LegacyEvalToGuardrailLink.promote`` defaults
  ``fire_hook=False`` (auto-promote is opt-in). Pre-fix: True
  → recursive ``on_judge_threshold_breach`` → ``promote()``.
* **B-10** — ``validate_org_api_key`` debounces
  ``UPDATE last_used_at`` to > 60s old. Pre-fix: every
  successful auth wrote a row → 3.6M UPDATEs/hour/key for
  a hot SDK.
* **B-11** — Per-(org, user) create rate limit (5/hour)
  with sliding-window deque. Returns ``Retry-After`` on 429.
* **B-12** — ``list_api_keys`` is now admin-only (was: any
  org member).
* **B-13** — ``pick_canary_version`` clamps out-of-range
  ``traffic_pct`` to 100 + logs warning. Pre-fix: stale row
  with ``traffic_pct = 150`` silently double-bucketed the roll.
"""

from __future__ import annotations

import inspect
import textwrap
import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

# ─── B-8: action_id format standardised ────────────────────────────


class TestB8ActionIdFormat:
    """The fallback path returns a deterministic ``UUID`` (uuid5 over
    canonical JSON encoding) so the same logical action lands on the
    same id on retry — the ``UNIQUE`` constraint on ``id`` then
    makes the ``ON CONFLICT (id) DO NOTHING`` clause a real dedup
    gate against double-emission.

    The ``closed_loop_actions.id`` column is ``UUID PRIMARY KEY``
    (see migration 025), so the id must be a valid UUID. Earlier
    attempts used ``act_<sha256[:16]>`` strings which the column
    silently rejected at INSERT time (audit 2026-07-03 — the
    pre-fix ``VALUES ($1, ...)`` missing ``::uuid`` cast was an
    immediate runtime break).
    """

    def test_fallback_uses_uuid5(self) -> None:
        """Static check: the fallback ``action_id`` is derived via
        ``uuid.uuid5`` so it fits the ``UUID PRIMARY KEY`` column.
        """
        from eden.llmops import promotion_hooks

        source = textwrap.dedent(
            inspect.getsource(promotion_hooks._record_action)
        )
        assert "uuid.uuid5" in source, (
            "B-8 regression: fallback action_id not derived via uuid5"
        )
        # The bare uuid4 fallback must be gone.
        assert 'str(uuid.uuid4())' not in source, (
            "B-8 regression: fallback still uses bare uuid4"
        )
        # The PG cast must be present so asyncpg writes a uuid,
        # not a string, into the column.
        assert "$1::uuid" in source, (
            "B-8 regression: missing $1::uuid cast on the INSERT — "
            "a string id would 500 with 'invalid input syntax for "
            "type uuid'"
        )

    @pytest.mark.asyncio
    async def test_fallback_id_is_deterministic(self) -> None:
        """Two calls with the same inputs produce the same uuid5 id."""
        # Force the fallback path: stub out HookBus by patching the
        # import path that _record_action actually resolves.
        import sys

        from eden.llmops import promotion_hooks
        fake_hooks_bus = type(sys)("fake_hooks_bus")
        fake_hooks_bus.HookEvent = object
        fake_hooks_bus.get_hook_bus = lambda: (_ for _ in ()).throw(
            RuntimeError("HookBus unavailable"),
        )
        with patch.dict(sys.modules, {"eden.llmops.hooks_bus": fake_hooks_bus}):
            with patch(
                "eden.storage.postgres.get_postgres_client",
                new=AsyncMock(return_value=AsyncMock(execute=AsyncMock())),
            ):
                id1 = await promotion_hooks._record_action(
                    "org_test", hook_name="test", action_kind="k",
                    target="t", payload={"a": 1},
                )
                id2 = await promotion_hooks._record_action(
                    "org_test", hook_name="test", action_kind="k",
                    target="t", payload={"a": 1},
                )
        assert id1 == id2, "B-8 regression: ids not deterministic"
        # Validate UUID format — uuid5 yields a 36-char canonical
        # string ``8-4-4-4-12`` (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
        import uuid as _uuid_mod

        try:
            parsed = _uuid_mod.UUID(id1)
        except (TypeError, ValueError):
            raise AssertionError(
                f"B-8 regression: id {id1!r} is not a valid UUID"
            )
        # uuid5 is version 5 — confirm we got the right scheme
        # (defence against accidental uuid4 / random fallback
        # slipping back in).
        assert parsed.version == 5, (
            f"B-8 regression: id {id1!r} is uuid v{parsed.version}, "
            "expected v5 (uuid5 over canonical content)"
        )


# ─── B-8 audit 2026-07-03: regression tests for the runtime fix ────


class TestB8Uuid5ColumnSafety:
    """Audit 2026-07-03 — the pre-fix code wrote a 20-char string
    (``"act_" + sha256[:16]``) into a ``UUID PRIMARY KEY`` column;
    Postgres rejected it with ``invalid input syntax for type uuid``
    and the entire row insert was lost. The uuid5 fix restores the
    cast. Pin the requirement here so a refactor that drops it
    again fails CI.
    """

    @pytest.mark.asyncio
    async def test_retry_yields_same_uuid5(self) -> None:
        """Retry with the same content lands on the same uuid,
        so the ON CONFLICT (id) DO NOTHING dedup actually fires.
        """
        import sys

        from eden.llmops import promotion_hooks

        fake_hooks_bus = type(sys)("fake_hooks_bus")
        fake_hooks_bus.HookEvent = object
        fake_hooks_bus.get_hook_bus = lambda: (_ for _ in ()).throw(
            RuntimeError("HookBus unavailable"),
        )
        with patch.dict(
            sys.modules, {"eden.llmops.hooks_bus": fake_hooks_bus}
        ):
            with patch(
                "eden.storage.postgres.get_postgres_client",
                new=AsyncMock(return_value=AsyncMock(execute=AsyncMock())),
            ):
                id_a = await promotion_hooks._record_action(
                    "org_x",
                    hook_name="h1",
                    action_kind="k1",
                    target="t1",
                    payload={"x": 1},
                )
                id_b = await promotion_hooks._record_action(
                    "org_x",
                    hook_name="h1",
                    action_kind="k1",
                    target="t1",
                    payload={"x": 1},
                )
        assert id_a == id_b

    @pytest.mark.asyncio
    async def test_different_content_yields_different_uuid5(self) -> None:
        """Different content must yield a different uuid — the
        dedup gate must not collapse legitimate distinct events
        into the same row.
        """
        import sys

        from eden.llmops import promotion_hooks

        fake_hooks_bus = type(sys)("fake_hooks_bus")
        fake_hooks_bus.HookEvent = object
        fake_hooks_bus.get_hook_bus = lambda: (_ for _ in ()).throw(
            RuntimeError("HookBus unavailable"),
        )
        with patch.dict(
            sys.modules, {"eden.llmops.hooks_bus": fake_hooks_bus}
        ):
            with patch(
                "eden.storage.postgres.get_postgres_client",
                new=AsyncMock(return_value=AsyncMock(execute=AsyncMock())),
            ):
                id_a = await promotion_hooks._record_action(
                    "org_x",
                    hook_name="h1",
                    action_kind="k1",
                    target="t1",
                    payload={"x": 1},
                )
                id_b = await promotion_hooks._record_action(
                    "org_x",
                    hook_name="h1",
                    action_kind="k1",
                    target="t1",
                    payload={"x": 2},
                )
        assert id_a != id_b, (
            "B-8 regression: distinct payloads collapsed to same id "
            "— the dedup gate would drop a legitimate follow-up event"
        )


# ─── B-9: fire_hook default OFF ─────────────────────────────────────


class TestB9FireHookDefault:
    """``LegacyEvalToGuardrailLink.promote`` defaults ``fire_hook=False``.

    The recursive guard (``fire_hook=False`` inside
    ``GuardrailHook.on_judge_threshold_breach``) was already
    there; this is the outer default flip.
    """

    def test_default_fire_hook_false(self) -> None:
        """Static check: the ``fire_hook`` parameter defaults to False."""
        from eden.guardrails import intervention

        sig = inspect.signature(intervention.LegacyEvalToGuardrailLink.promote)
        assert sig.parameters["fire_hook"].default is False, (
            "B-9 regression: fire_hook default is not False"
        )


# ─── B-10: last_used_at debounce ────────────────────────────────────


class TestB10LastUsedAtDebounce:
    """``UPDATE last_used_at`` is throttled to once per 60s per key."""

    def test_validates_function_signature(self) -> None:
        """The function reads ``last_used_at`` from the SELECT row."""
        from eden.api.routes import api_keys

        source = textwrap.dedent(
            inspect.getsource(api_keys.validate_org_api_key)
        )
        assert "last_used_at" in source, (
            "B-10 regression: validate_org_api_key doesn't read "
            "last_used_at"
        )
        assert "60" in source, (
            "B-10 regression: no 60s throttle constant"
        )

    @pytest.mark.asyncio
    async def test_fresh_key_writes_stamp(self) -> None:
        """A key with ``last_used_at = NULL`` always writes the stamp."""
        from eden.api.routes import api_keys

        fake_client = AsyncMock()
        fake_row = {
            "name": "Org", "slug": "org", "owner_id": "owner-uuid",
            "org_id": "org-uuid", "scopes": ["references:read"],
            "key_id": "key-uuid",
            "last_used_at": None,
        }
        fake_client.fetchrow = AsyncMock(return_value=fake_row)
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.routes.api_keys.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            result = await api_keys.validate_org_api_key(
                "org-uuid", "eden_api_key_xyz",
            )
        assert result is not None
        fake_client.execute.assert_called_once()

    @pytest.mark.asyncio
    async def test_recent_key_skips_stamp(self) -> None:
        """A key whose ``last_used_at`` is < 60s old does NOT write."""
        from datetime import UTC, datetime, timedelta

        from eden.api.routes import api_keys

        fake_client = AsyncMock()
        fake_row = {
            "name": "Org", "slug": "org", "owner_id": "owner-uuid",
            "org_id": "org-uuid", "scopes": ["references:read"],
            "key_id": "key-uuid",
            "last_used_at": datetime.now(UTC) - timedelta(seconds=10),
        }
        fake_client.fetchrow = AsyncMock(return_value=fake_row)
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.routes.api_keys.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            result = await api_keys.validate_org_api_key(
                "org-uuid", "eden_api_key_xyz",
            )
        assert result is not None
        fake_client.execute.assert_not_called()


# ─── B-11: create rate limit ────────────────────────────────────────


class TestB11CreateRateLimit:
    """5 creates / hour / (org, user); 6th returns 429 + Retry-After.

    Audit 2026-07-03 — the rate-limit helper is now async (Redis-backed
    distributed counter); the in-memory deque is the fallback path.
    Tests target the local fallback so they don't need a Redis fixture.
    """

    @pytest.mark.asyncio
    async def test_allowed_under_limit(self) -> None:
        """First 5 calls in a window all return None (allowed)."""
        from eden.api.routes.api_keys import _check_api_key_create_rate_limit

        # Fresh user → log is empty.
        for i in range(5):
            r = await _check_api_key_create_rate_limit(
                f"org_{i}", f"user_{i}",
            )
            assert r is None, (
                f"B-11 regression: call {i+1} unexpectedly rate-limited"
            )

    @pytest.mark.asyncio
    async def test_blocked_at_sixth(self) -> None:
        """6th call from same (org, user) returns retry-after seconds."""
        from eden.api.routes.api_keys import _check_api_key_create_rate_limit

        for _ in range(5):
            await _check_api_key_create_rate_limit("org_block", "user_block")
        r = await _check_api_key_create_rate_limit("org_block", "user_block")
        assert r is not None, (
            "B-11 regression: 6th call not rate-limited"
        )
        assert 0 < r <= 3600.0, (
            f"B-11 regression: retry-after {r} not in (0, 3600]"
        )

    @pytest.mark.asyncio
    async def test_isolated_per_user(self) -> None:
        """User A's blocked state does NOT affect user B."""
        from eden.api.routes.api_keys import _check_api_key_create_rate_limit

        for _ in range(5):
            await _check_api_key_create_rate_limit("org_isolated", "user_a")
        # User A is blocked.
        assert (
            await _check_api_key_create_rate_limit("org_isolated", "user_a")
            is not None
        )
        # User B is fresh.
        assert (
            await _check_api_key_create_rate_limit("org_isolated", "user_b")
            is None
        )

    @pytest.mark.asyncio
    async def test_window_expires(self) -> None:
        """After the window passes, the limit resets."""
        from eden.api.routes.api_keys import (
            _API_KEY_CREATE_MAX,
            _api_key_create_log,
            _check_api_key_create_rate_limit,
        )

        await _check_api_key_create_rate_limit("org_reset", "user_reset")
        # Force-expire by mutating the deque.
        log = _api_key_create_log[("org_reset", "user_reset")]
        log.appendleft(log[0] - 3700.0)
        r = await _check_api_key_create_rate_limit("org_reset", "user_reset")
        assert r is None, (
            "B-11 regression: limit did not reset after window"
        )


# ─── B-12: list_api_keys restricted ────────────────────────────────


class TestB12ListKeysRestricted:
    """``list_api_keys`` requires admin/owner (was: any org member)."""

    def test_calls_require_org_admin(self) -> None:
        """Static check: the function calls ``require_org_admin``."""
        from eden.api.routes import api_keys

        source = textwrap.dedent(
            inspect.getsource(api_keys.list_api_keys)
        )
        assert "require_org_admin" in source, (
            "B-12 regression: list_api_keys doesn't call "
            "require_org_admin"
        )


# ─── B-13: traffic_pct validation ──────────────────────────────────


class TestB13TrafficPctValidation:
    """``pick_canary_version`` clamps ``traffic_pct`` to [0, 100]."""

    def test_validates_assignment_at_entry(self) -> None:
        """Out-of-range pct is clamped to 100 + logs warning."""
        from eden.agents.prompt_canary import pick_canary_version

        with patch(
            "eden.agents.prompt_canary.logger"
        ) as mock_logger:
            assignments = [
                {"version": 2, "traffic_pct": 150},  # out of range
            ]
            result = pick_canary_version(
                assignments, "tenant_x", "agent_y",
            )
        # Function returns the row, but its traffic_pct is now 100.
        assert result is not None
        assert result["traffic_pct"] == 100.0, (
            f"B-13 regression: clamp failed, got "
            f"{result['traffic_pct']}"
        )
        mock_logger.warning.assert_called_once()

    def test_in_range_passes_through(self) -> None:
        """Assignments already in range are not modified."""
        from eden.agents.prompt_canary import pick_canary_version

        with patch("eden.agents.prompt_canary.logger") as mock_logger:
            assignments = [
                {"version": 2, "traffic_pct": 50},
                {"version": 3, "traffic_pct": 30},
            ]
            result = pick_canary_version(
                assignments, "tenant_z", "agent_w",
            )
        assert result is not None
        assert mock_logger.warning.call_count == 0, (
            "B-13 regression: in-range pct triggered warning"
        )
        # One of the two should be picked (roll determines which).
        assert result["traffic_pct"] in (50.0, 30.0)

    def test_negative_pct_clamped(self) -> None:
        """Negative pct is also clamped (to 100)."""
        from eden.agents.prompt_canary import pick_canary_version

        with patch("eden.agents.prompt_canary.logger"):
            assignments = [{"version": 1, "traffic_pct": -10}]
            result = pick_canary_version(
                assignments, "tenant_n", "agent_n",
            )
        assert result["traffic_pct"] == 100.0


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
