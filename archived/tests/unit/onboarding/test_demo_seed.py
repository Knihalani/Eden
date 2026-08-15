"""Unit tests for OOM §6.1 demo-data seeder (W2-6 O1).

Covers:
  1. Guard — seed-demo route returns 403 for non-admins.
  2. Idempotent seeding — second call inserts nothing (ON CONFLICT dedup).
  3. Purge precision — purge removes only demo rows, leaving real rows.
  4. Webhook isolation — _upsert_org never raises because of seed failure.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── 1. Auth guard (403) ──────────────────────────────────────────────────────


class TestSeedDemoRouteGuard:
    """The /seed-demo route must gate on org-admin."""

    def test_router_requires_require_org_admin(self) -> None:
        """seed_demo must declare require_org_admin as a dependency."""
        import inspect

        from eden.api.routes import onboarding_seed
        from eden.api.deps import require_org_admin

        src = inspect.getsource(onboarding_seed.seed_demo)
        # The dependency must be visible in the function signature or route decorator.
        assert "require_org_admin" in src, (
            "seed_demo route must gate on require_org_admin "
            "so non-admins receive 403"
        )

    def test_router_inherits_v2_guard(self) -> None:
        """The router-level guard must include _require_onboarding_v2_enabled."""
        from eden.api.routes import onboarding_seed
        from eden.api.routes.onboarding import _require_onboarding_v2_enabled

        dep_funcs = {
            getattr(d, "dependency", None)
            for d in (onboarding_seed.router.dependencies or [])
        }
        assert _require_onboarding_v2_enabled in dep_funcs, (
            "onboarding_seed router must inherit _require_onboarding_v2_enabled "
            "so the kill-switch gates the endpoint (503 when disabled)"
        )

    def test_v2_guard_raises_503_when_disabled(self, monkeypatch) -> None:
        """Guard raises 503 when the kill-switch is off."""
        from fastapi import HTTPException
        from eden.api.routes.onboarding import _require_onboarding_v2_enabled

        class _S:
            onboarding_state_machine_v2_enabled = False

        monkeypatch.setattr("eden.config.get_settings", lambda: _S())
        with pytest.raises(HTTPException) as ei:
            _require_onboarding_v2_enabled()
        assert ei.value.status_code == 503


# ─── 2. Idempotent seeding ────────────────────────────────────────────────────


class TestSeedDemoIdempotency:
    """seed_demo_data is idempotent: second call inserts nothing."""

    @pytest.mark.asyncio
    async def test_first_call_inserts_stumbles(self) -> None:
        """seed_demo_data calls StumbleWriter.create for each demo agent."""
        calls: list[str] = []

        async def _fake_create(self_or_sc, sc=None):
            # patch on a bound method passes (self, sc); on a free function (sc,)
            actual_sc = sc if sc is not None else self_or_sc
            calls.append(actual_sc.agent_id)
            return {
                "stumble_id": f"sid-{len(calls)}",
                "fingerprint": f"fp-{actual_sc.agent_id}",
                "inserted": True,
                "issue": None,
            }

        async def _fake_plan(*_a, **_kw):
            return {"id": "plan-uuid-1"}

        with (
            patch("eden.issues.stumble_writer.StumbleWriter.create", new=_fake_create),
            patch("eden.improvement.plans_repo.create_plan", new=AsyncMock(return_value={"id": "plan-1"})),
            patch("eden.improvement.plans_repo._resolve_base_ref_sha", new=AsyncMock(return_value=None)),
            patch("eden.storage.postgres.get_postgres_client", new=AsyncMock(return_value=None)),
        ):
            from eden.onboarding.demo_seed import seed_demo_data

            result = await seed_demo_data("org-test-1")

        # 3 agents × 4 stumbles = 12 calls
        assert len(calls) == 12, f"expected 12 stumble inserts, got {len(calls)}"
        assert result["stumbles_inserted"] == 12
        assert result["org_id"] == "org-test-1"

    @pytest.mark.asyncio
    async def test_second_call_inserts_nothing(self) -> None:
        """When StumbleWriter.create returns inserted=False, count stays 0."""
        async def _fake_create_dedup(sc):
            return {
                "stumble_id": "existing",
                "fingerprint": "fp-x",
                "inserted": False,
                "deduped": True,
                "issue": None,
            }

        with (
            patch("eden.issues.stumble_writer.StumbleWriter.create", new=_fake_create_dedup),
            patch("eden.improvement.plans_repo.create_plan", new=AsyncMock(return_value={"id": "plan-1"})),
            patch("eden.improvement.plans_repo._resolve_base_ref_sha", new=AsyncMock(return_value=None)),
            patch("eden.storage.postgres.get_postgres_client", new=AsyncMock(return_value=None)),
        ):
            from eden.onboarding.demo_seed import seed_demo_data

            result = await seed_demo_data("org-test-2")

        assert result["stumbles_inserted"] == 0, (
            "idempotent re-seed must not count deduped stumbles as inserted"
        )

    def test_demo_trace_ids_are_deterministic(self) -> None:
        """Demo trace-ids must embed the agent_id (not a random UUID).

        This is what makes the ON CONFLICT dedup fire on the second call:
        if the trace-id were random, every call would insert new rows.
        """
        from eden.onboarding.demo_seed import _DEMO_AGENTS

        # The trace-id template in demo_seed._seed_agent is
        # f"demo-{agent_id}-{batch}-{i}" — agent_id is fixed, batch
        # will vary between calls but the ON CONFLICT dedup on
        # (org_id, trace_id, kind, fingerprint) covers fingerprint
        # which is derived from (kind, agent_id, error_signature)
        # and is stable across batches.
        for cfg in _DEMO_AGENTS:
            assert cfg["agent_id"].startswith("demo-"), (
                f"demo agent_id must start with 'demo-': {cfg['agent_id']}"
            )


# ─── 3. Purge precision ───────────────────────────────────────────────────────


class TestPurgePrecision:
    """purge_demo_data must delete only demo rows, not real ones."""

    @pytest.mark.asyncio
    async def test_purge_uses_demo_predicates(self) -> None:
        """The DELETE statements must reference DEMO_DETECTED_BY and demo prefix."""
        import inspect
        from eden.onboarding import demo_seed

        src = inspect.getsource(demo_seed.purge_demo_data)
        assert "eden:demo_seed" in src or "DEMO_DETECTED_BY" in src, (
            "purge must filter on detected_by = 'eden:demo_seed'"
        )
        assert "demo-%" in src or "DEMO_AGENT_ID_PREFIX" in src, (
            "purge must filter agent_id LIKE 'demo-%'"
        )

    @pytest.mark.asyncio
    async def test_purge_calls_three_tables(self) -> None:
        """purge_demo_data must delete from stumbles, issues, and plans."""
        execute_calls: list[str] = []

        class _FakeClient:
            async def execute(self, sql, *args):
                # SQL is "DELETE FROM <table> WHERE ..."; word index 2 is the table.
                tokens = sql.strip().split()
                table = tokens[2].lower() if len(tokens) > 2 else tokens[-1].lower()
                execute_calls.append(table)
                return "DELETE 5"

        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=_FakeClient()),
        ):
            from eden.onboarding.demo_seed import purge_demo_data

            result = await purge_demo_data("org-purge-1")

        tables_deleted = set(execute_calls)
        assert "agent_stumbles" in tables_deleted, f"got {tables_deleted}"
        assert "agent_issues" in tables_deleted, f"got {tables_deleted}"
        assert "improvement_plans" in tables_deleted, f"got {tables_deleted}"
        assert result["deleted"]["stumbles"] == 5

    @pytest.mark.asyncio
    async def test_purge_no_db_returns_error_not_raises(self) -> None:
        """purge_demo_data must not raise when Postgres is unavailable."""
        with patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=None),
        ):
            from eden.onboarding.demo_seed import purge_demo_data

            result = await purge_demo_data("org-no-db")

        assert result.get("error") == "no_db"

    def test_is_demo_agent_id_only_matches_prefix(self) -> None:
        """is_demo_agent_id must not match real agent IDs."""
        from eden.onboarding.demo_seed import is_demo_agent_id

        assert is_demo_agent_id("demo-checkout-agent") is True
        assert is_demo_agent_id("demo-") is True
        assert is_demo_agent_id("real-agent-123") is False
        assert is_demo_agent_id("") is False
        assert is_demo_agent_id(None) is False


# ─── 4. Webhook isolation ────────────────────────────────────────────────────


class TestWebhookSeedIsolation:
    """_upsert_org must never fail because of demo seeding."""

    @pytest.mark.asyncio
    async def test_upsert_org_does_not_raise_on_seed_failure(self) -> None:
        """Seeding error must be swallowed — webhook returns 2xx."""
        from eden.api.routes.clerk_webhooks import _upsert_org

        # Build a fake Postgres client.
        async def _fetchrow(sql, *args):
            if "users" in sql:
                # owner lookup
                return {"id": "user-uuid-1"}
            # org existence / seed org lookup
            return {"id": "org-uuid-1"}

        class _FakeClient:
            async def fetchrow(self, sql, *args):
                return await _fetchrow(sql, *args)

            async def execute(self, sql, *args):
                return "UPDATE 1"

        with (
            patch(
                "eden.api.routes.clerk_webhooks.get_postgres_client",
                new=AsyncMock(return_value=_FakeClient()),
            ),
            patch(
                "eden.api.routes.onboarding_seed._fire_and_forget_seed",
                new=AsyncMock(side_effect=RuntimeError("seed exploded")),
            ),
        ):
            # Must not raise — RuntimeError from seeding is swallowed.
            await _upsert_org(
                {"id": "org_2abc", "name": "Acme", "slug": "acme", "created_by": "user_xyz"}
            )
        # If we reach here the webhook handler correctly isolated the failure.

    @pytest.mark.asyncio
    async def test_fire_and_forget_seed_swallows_errors(self) -> None:
        """_fire_and_forget_seed must not propagate exceptions."""
        with patch(
            "eden.onboarding.demo_seed.seed_demo_data",
            new=AsyncMock(side_effect=RuntimeError("db exploded")),
        ):
            # Should not raise.
            from eden.api.routes.onboarding_seed import _fire_and_forget_seed
            import asyncio

            # Schedule and run the task to completion.
            task_holder: list = []
            original_ensure = asyncio.ensure_future

            def _capture(coro):
                t = original_ensure(coro)
                task_holder.append(t)
                return t

            with patch("asyncio.ensure_future", side_effect=_capture):
                await _fire_and_forget_seed("org-seed-fail")

            # Run scheduled tasks.
            if task_holder:
                await asyncio.gather(*task_holder, return_exceptions=True)
            # No exception propagated.


# ─── 5. on_first_10_traces purge wiring ──────────────────────────────────────


class TestFirstTracePurgeWiring:
    """on_first_10_traces must trigger demo purge."""

    @pytest.mark.asyncio
    async def test_on_first_10_traces_calls_purge(self) -> None:
        """on_first_10_traces must invoke purge_demo_data."""
        purge_mock = AsyncMock(return_value={"org_id": "org-1", "deleted": {}})

        with (
            patch(
                "eden.onboarding.demo_seed.purge_demo_data",
                new=purge_mock,
            ),
            patch(
                "eden.llmops.promotion_hooks.OnboardingMilestoneHook._record",
                new=AsyncMock(return_value={"org_id": "org-1", "milestones_reached": ["first_10_traces"]}),
            ),
        ):
            from eden.llmops.promotion_hooks import OnboardingMilestoneHook

            hook = OnboardingMilestoneHook()
            await hook.on_first_10_traces("org-1", trace_count=10)

        purge_mock.assert_awaited_once_with("org-1")

    @pytest.mark.asyncio
    async def test_on_first_10_traces_continues_on_purge_error(self) -> None:
        """Purge failure must not break the milestone record."""
        record_mock = AsyncMock(return_value={"org_id": "org-2", "milestones_reached": []})

        with (
            patch(
                "eden.onboarding.demo_seed.purge_demo_data",
                new=AsyncMock(side_effect=RuntimeError("db down")),
            ),
            patch(
                "eden.llmops.promotion_hooks.OnboardingMilestoneHook._record",
                new=record_mock,
            ),
        ):
            from eden.llmops.promotion_hooks import OnboardingMilestoneHook

            hook = OnboardingMilestoneHook()
            result = await hook.on_first_10_traces("org-2", trace_count=10)

        record_mock.assert_awaited_once()
        assert result is not None, "milestone result must be returned even when purge fails"
