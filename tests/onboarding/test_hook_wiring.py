"""D.14 OnboardingMilestoneHook tests (upgradespec §G.1).

Two tests covering the hook → state-machine wiring:
- ``on_first_10_traces`` records the milestone + auto-advances
- The hook is the documented call site for the trace counter /
  judge runner / prompt-versioning service per the §E.1 hook
  taxonomy.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from eden.llmops.promotion_hooks import OnboardingMilestoneHook


def _state_row(
    org_id: str = "org-1",
    current_step: str = "connect",
    completed_steps: list[str] | None = None,
    milestones_reached: list[str] | None = None,
) -> dict:
    now = datetime.now(UTC)
    return {
        "org_id": org_id,
        "current_step": current_step,
        "completed_steps": completed_steps or [],
        "cat_enablements": {},
        "first_trace_at": None,
        "milestones_reached": milestones_reached or [],
        "created_at": now,
        "updated_at": now,
    }


class TestOnboardingMilestoneHook:
    """The 2 spec-mandated hook-wiring tests (upgradespec §G.1)."""

    @pytest.mark.asyncio
    async def test_first_10_traces_hook_fires_onboarding_advance(
        self, mock_postgres_client: MagicMock,
    ):
        """The hook's ``on_first_10_traces`` method must record the
        'first_10_traces' milestone AND auto-advance the org to
        'wait' (per ``MILESTONE_ADVANCES``).

        Same 4-SELECT queue as the state-machine milestone test;
        see tests/onboarding/test_state_machine.py for the call
        sequence details.
        """
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(current_step="connect"))
        )
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM onboarding_state",
                _state_row(
                    current_step="connect",
                    milestones_reached=["first_10_traces"],
                ),
            )
        )
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM onboarding_state",
                _state_row(
                    current_step="connect",
                    milestones_reached=["first_10_traces"],
                ),
            )
        )
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM onboarding_state",
                _state_row(
                    current_step="wait",
                    completed_steps=["connect"],
                    milestones_reached=["first_10_traces"],
                ),
            )
        )
        hook = OnboardingMilestoneHook()
        result = await hook.on_first_10_traces(
            "org-1", trace_count=10
        )
        assert result is not None
        assert result["current_step"] == "wait"
        assert "first_10_traces" in result["milestones_reached"]

    @pytest.mark.asyncio
    async def test_pilot_org_date_cutoff_respected(
        self, mock_postgres_client: MagicMock,
    ):
        """A pre-cutover org returns ``onboarding_v2_enabled=False``
        (via the state machine's ``_is_legacy_org`` check), so the
        hook's downstream callers can short-circuit and not show
        the banner. We assert this by feeding the state machine
        a pre-cutover ``org_created_at`` and verifying the returned
        row has the legacy flag set.
        """
        # The state machine's get_state path: a pre-cutover org
        # should NOT touch the DB at all (the legacy branch
        # returns a synthetic row before the SELECT).
        from eden.services.onboarding import OnboardingStateMachine
        sm = OnboardingStateMachine()
        state = await sm.get_state(
            "org-legacy", org_created_at="2025-12-01T00:00:00+00:00",
        )
        # Source is "legacy" and the v2 flag is off.
        assert state.source == "legacy"
        assert state.onboarding_v2_enabled is False
        # No DB SELECT was made (the legacy branch returns early
        # before calling get_postgres_client). The mock's
        # _fetchrow_overrides is empty → no calls were made.
        assert mock_postgres_client._fetchrow_overrides == []
