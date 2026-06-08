"""Unit tests for PromptEvolvers auto-canary creation (Unit A8).

When ``settings.evolver_auto_canary_pct`` is greater than zero, every
newly generated prompt variant should be auto-enrolled in a canary at
the configured traffic percentage.  The canary state is recorded on the
``prompt_versions`` row's ``quality_metrics`` JSONB and an
``evolver.auto_canary_created`` audit event is written to
``org_audit_log``.

These tests use ``AsyncMock`` for the prompt-versions client and
postgres client, mirroring the pattern in
``tests/unit/agents/test_critic.py``.

Note: ``PromptEvolvers.__init__`` calls
``get_episodic_client()`` which lives in a module with a pre-existing
bug (``limit: int = 20`` shadows the built-in).  We sidestep that
constructor entirely by building the evolver via ``__new__`` so the
buggy module is never imported.
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch


from eden.agents.evolution.components import PromptEvolvers


@pytest.fixture
def evolver():
    """A ``PromptEvolvers`` with no LLM client and stubbed KB clients.

    Uses ``__new__`` to avoid the (buggy) constructor's
    ``get_episodic_client()`` call.
    """
    e = PromptEvolvers.__new__(PromptEvolvers)
    # Mirror the parent ``EvolutionComponent`` init attributes.
    e.llm = MagicMock()
    e.last_run = None
    # Wire our per-test mocks.
    e.prompt_versions = MagicMock()
    e.prompt_versions.insert_version = AsyncMock(return_value=True)
    e.prompt_versions.update_quality_metrics = AsyncMock(return_value=True)
    return e


@pytest.fixture
def mock_postgres():
    """Mock PostgresClient used by the audit logger."""
    client = MagicMock()
    client.fetchval = AsyncMock(side_effect=_fetchval_dispatch)
    client.execute = AsyncMock(return_value="INSERT 0 1")
    return client


async def _fetchval_dispatch(query: str, *args):
    """Return plausible org/user ids for the SELECTs the audit logger
    runs against the orgs + users tables."""
    q = " ".join(query.split()).lower()
    if "from organizations" in q:
        return "00000000-0000-0000-0000-000000000aaa"
    if "from users" in q:
        return "00000000-0000-0000-0000-000000000bbb"
    return None


class TestAutoCanarySettings:
    """``evolver_auto_canary_pct`` is a Settings field with sane defaults."""

    def test_setting_default_is_5(self):
        from eden.config import Settings
        s = Settings()
        assert s.evolver_auto_canary_pct == 5

    def test_setting_zero_disables(self):
        from eden.config import Settings
        s = Settings(evolver_auto_canary_pct=0)
        assert s.evolver_auto_canary_pct == 0

    def test_setting_accepts_custom_value(self):
        from eden.config import Settings
        s = Settings(evolver_auto_canary_pct=10)
        assert s.evolver_auto_canary_pct == 10


class TestAutoCreateCanary:
    """``PromptEvolvers._auto_create_canary`` unit tests."""

    @pytest.mark.asyncio
    async def test_disabled_when_pct_is_zero(self, evolver, mock_postgres):
        with patch(
            "eden.agents.evolution.components.settings"
        ) as mock_settings:
            mock_settings.evolver_auto_canary_pct = 0

            result = await evolver._auto_create_canary("planner", 2, 1)

        assert result is False
        evolver.prompt_versions.update_quality_metrics.assert_not_called()
        mock_postgres.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_disabled_when_pct_is_negative(self, evolver, mock_postgres):
        with patch(
            "eden.agents.evolution.components.settings"
        ) as mock_settings:
            mock_settings.evolver_auto_canary_pct = -1

            result = await evolver._auto_create_canary("planner", 2, 1)

        assert result is False
        evolver.prompt_versions.update_quality_metrics.assert_not_called()

    @pytest.mark.asyncio
    async def test_creates_canary_at_default_5pct(self, evolver, mock_postgres):
        with patch(
            "eden.agents.evolution.components.settings"
        ) as mock_settings:
            mock_settings.evolver_auto_canary_pct = 5

            with patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=mock_postgres),
            ):
                result = await evolver._auto_create_canary("planner", 2, 1)

        assert result is True

        # Variant row should be updated with canary metadata.
        evolver.prompt_versions.update_quality_metrics.assert_awaited_once()
        call_args = evolver.prompt_versions.update_quality_metrics.await_args
        assert call_args.args[0] == "planner"
        assert call_args.args[1] == 2
        metrics = call_args.args[2]
        assert metrics["canary_status"] == "active"
        assert metrics["canary_traffic_pct"] == 5
        assert metrics["ab_test_active"] is True
        assert metrics["ab_test_round"] == 1
        assert "canary_created_at" in metrics

        # Audit log row should be inserted.
        mock_postgres.execute.assert_awaited_once()
        exec_args = mock_postgres.execute.await_args
        assert "INSERT INTO org_audit_log" in exec_args.args[0]
        # Positional args: org_id, user_id, action, target_type, target_id, metadata
        org_id, user_id, action, target_type, target_id, metadata_json = (
            exec_args.args[1:7]
        )
        assert action == "evolver.auto_canary_created"
        assert target_type == "prompt_version"
        assert target_id == "planner:2"
        metadata = json.loads(metadata_json)
        assert metadata["agent"] == "planner"
        assert metadata["version"] == 2
        assert metadata["traffic_pct"] == 5

    @pytest.mark.asyncio
    async def test_clamps_pct_above_100(self, evolver, mock_postgres):
        with patch(
            "eden.agents.evolution.components.settings"
        ) as mock_settings:
            mock_settings.evolver_auto_canary_pct = 250

            with patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=mock_postgres),
            ):
                result = await evolver._auto_create_canary("critic", 3, 2)

        assert result is True
        metrics = evolver.prompt_versions.update_quality_metrics.await_args.args[2]
        assert metrics["canary_traffic_pct"] == 100

    @pytest.mark.asyncio
    async def test_returns_false_when_update_fails(
        self, evolver, mock_postgres
    ):
        evolver.prompt_versions.update_quality_metrics.return_value = False
        with patch(
            "eden.agents.evolution.components.settings"
        ) as mock_settings:
            mock_settings.evolver_auto_canary_pct = 5

            with patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=mock_postgres),
            ):
                result = await evolver._auto_create_canary("planner", 2, 1)

        assert result is False
        # Audit must NOT be written when canary row update fails.
        mock_postgres.execute.assert_not_called()

    @pytest.mark.asyncio
    async def test_audit_failure_does_not_block_canary(
        self, evolver, mock_postgres
    ):
        # The canary row succeeds but the audit INSERT throws.
        mock_postgres.execute.side_effect = RuntimeError("audit db down")
        with patch(
            "eden.agents.evolution.components.settings"
        ) as mock_settings:
            mock_settings.evolver_auto_canary_pct = 5

            with patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=mock_postgres),
            ):
                # Should not raise — audit is best-effort.
                result = await evolver._auto_create_canary("planner", 2, 1)

        assert result is True
        evolver.prompt_versions.update_quality_metrics.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_handles_non_int_pct(self, evolver, mock_postgres):
        with patch(
            "eden.agents.evolution.components.settings"
        ) as mock_settings:
            mock_settings.evolver_auto_canary_pct = "not-a-number"

            result = await evolver._auto_create_canary("planner", 2, 1)

        # Non-int values are treated as disabled (defensive — prevents
        # garbage config from silently enrolling every variant).
        assert result is False
        evolver.prompt_versions.update_quality_metrics.assert_not_called()


class TestHandleDegradationWiring:
    """``_handle_degradation`` should call ``_auto_create_canary`` for
    every successfully inserted variant."""

    @pytest.mark.asyncio
    async def test_auto_canary_called_for_each_variant(
        self, evolver, mock_postgres
    ):
        # Skip the LLM call.  We feed in two pre-built variants and
        # assert both get canaried.
        evolver._auto_create_canary = AsyncMock(return_value=True)

        failure_jobs = [
            {"job_id": f"job{i}", "outcome_tier": "Failed"} for i in range(3)
        ]
        current_quality = {"test_pass_rate": 0.5, "avg_executor_iterations": 2.0}
        previous_quality = {"test_pass_rate": 0.95, "avg_executor_iterations": 1.0}

        with patch.object(
            evolver, "_generate_prompt_variants",
            AsyncMock(return_value=[
                {"prompt": "variant one"},
                {"prompt": "variant two"},
            ]),
        ):
            with patch(
                "eden.agents.evolution.components.settings"
            ) as mock_settings:
                mock_settings.evolver_auto_canary_pct = 5
                created = await evolver._handle_degradation(
                    agent="planner",
                    current_version=1,
                    failure_jobs=failure_jobs,
                    current_quality=current_quality,
                    previous_quality=previous_quality,
                )

        assert created == 2
        assert evolver._auto_create_canary.await_count == 2
        # Variants are canaried at versions 2 and 3 (current + 1 + i).
        awaited_versions = sorted(
            c.args[1] for c in evolver._auto_create_canary.await_args_list
        )
        assert awaited_versions == [2, 3]

    @pytest.mark.asyncio
    async def test_no_canary_when_no_variants(self, evolver):
        evolver._auto_create_canary = AsyncMock(return_value=True)

        failure_jobs = [{"job_id": "j1", "outcome_tier": "Failed"}]
        with patch.object(
            evolver, "_generate_prompt_variants",
            AsyncMock(return_value=[]),
        ):
            created = await evolver._handle_degradation(
                agent="planner",
                current_version=1,
                failure_jobs=failure_jobs,
                current_quality={"test_pass_rate": 0.5},
                previous_quality={"test_pass_rate": 0.95},
            )

        assert created == 0
        evolver._auto_create_canary.assert_not_called()
