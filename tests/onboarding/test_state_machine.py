"""D.14 cold-start UX state machine tests (upgradespec §G.1).

Five tests covering the 7-step state machine, milestone
auto-advance, skip-blocking, backward transitions, and
idempotency. Per spec §10.1 the steps are:

    install → org → connect → wait → done → tour → autonomous

The state machine is best-effort: every fetcher returns a
synthetic ``StateRow`` if the DB is unreachable, so the tests
that need DB behaviour explicitly override
``mock_postgres_client._fetchrow_overrides``.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from eden.services.onboarding import (
    ONBOARDING_STEPS,
    ONBOARDING_V2_CUTOVER,
    OnboardingStateMachine,
)
from eden.services.onboarding.state_machine import (
    _is_legacy_org,
    _step_index,
    MILESTONE_ADVANCES,
)


# ── helpers ───────────────────────────────────────────────────────────


def _state_row(
    org_id: str = "org-1",
    current_step: str = "install",
    completed_steps: list[str] | None = None,
    milestones_reached: list[str] | None = None,
) -> dict:
    """Build a fake ``onboarding_state`` row that the conftest's
    default ``fetchrow`` will return (matched by the query
    substring ``FROM onboarding_state``)."""
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


# ── 5 state-machine tests ─────────────────────────────────────────────


class TestOnboardingStateMachine:
    """The 5 spec-mandated state-machine tests (upgradespec §G.1)."""

    @pytest.mark.asyncio
    async def test_install_advances_to_org(self, mock_postgres_client: MagicMock):
        """Forward advance to the next step is allowed."""
        # advance() does 2 SELECTs: initial get_state + re-read in _persist.
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(current_step="install"))
        )
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(
                current_step="org", completed_steps=["install"],
            ))
        )
        sm = OnboardingStateMachine()
        state = await sm.advance("org-1", "org")
        assert state.current_step == "org"
        assert "install" in state.completed_steps
        # The new step is the second of seven.
        assert _step_index(state.current_step) == 1

    @pytest.mark.asyncio
    async def test_skip_blocked_at_wait_step(self, mock_postgres_client: MagicMock):
        """Cannot skip from 'connect' (idx 2) directly to 'done' (idx 4)
        without ``force=True`` (the wait step is required for the
        'first_10_traces' milestone auto-advance)."""
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(current_step="connect"))
        )
        sm = OnboardingStateMachine()
        with pytest.raises(ValueError, match="cannot skip"):
            await sm.advance("org-1", "done")
        # With force=True it works — queue the row for the forced
        # advance (initial get_state + re-read after the upsert).
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(current_step="connect"))
        )
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(
                current_step="done", completed_steps=["connect"],
            ))
        )
        state = await sm.advance("org-1", "done", force=True)
        assert state.current_step == "done"

    @pytest.mark.asyncio
    async def test_backward_transition_audit_logged(self, mock_postgres_client: MagicMock, caplog):
        """Backward transitions are allowed and audit-logged."""
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(current_step="connect"))
        )
        # After backward advance, the row reflects the new state.
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(current_step="org"))
        )
        sm = OnboardingStateMachine()
        with caplog.at_level("INFO", logger="eden.services.onboarding.state_machine"):
            state = await sm.advance("org-1", "org")
        assert state.current_step == "org"
        # Audit row is on the returned state.
        assert state.last_audit is not None
        assert state.last_audit["action"] == "advance"
        assert state.last_audit["from"] == "connect"
        assert state.last_audit["to"] == "org"
        # And it's in the log stream (the log uses Python repr
        # so the dict is rendered as ``{'action': 'advance', ...}``).
        assert any(
            "org-1" in rec.message
            and "advance" in rec.message
            and "from" in rec.message
            and "to" in rec.message
            for rec in caplog.records
        )

    @pytest.mark.asyncio
    async def test_milestone_first_10_traces_advances(self, mock_postgres_client: MagicMock):
        """Recording the 'first_10_traces' milestone auto-advances
        the org to the 'wait' step (per ``MILESTONE_ADVANCES``).

        The state machine does these SELECTs in order:
          1. record_milestone's get_state
          2. _persist (milestone upsert) re-read
          3. advance's get_state (auto-advance triggered)
          4. _persist (advance upsert) re-read
        """
        mock_postgres_client._fetchrow_overrides.append(
            ("FROM onboarding_state", _state_row(current_step="connect"))
        )
        # After milestone recorded (in-DB view).
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM onboarding_state",
                _state_row(
                    current_step="connect",
                    milestones_reached=["first_10_traces"],
                ),
            )
        )
        # Same as above — the advance sees the same DB view.
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM onboarding_state",
                _state_row(
                    current_step="connect",
                    milestones_reached=["first_10_traces"],
                ),
            )
        )
        # After the advance is upserted (final view).
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
        sm = OnboardingStateMachine()
        state = await sm.record_milestone("org-1", "first_10_traces")
        # The milestone maps to 'wait' (idx 3) — that's beyond the
        # next step (connect idx 2), so the auto-advance is forced.
        assert state.current_step == "wait"
        assert "first_10_traces" in state.milestones_reached
        # Sanity: MILESTONE_ADVANCES is wired per spec.
        assert MILESTONE_ADVANCES["first_10_traces"].value == "wait"

    @pytest.mark.asyncio
    async def test_milestone_already_recorded_idempotent(self, mock_postgres_client: MagicMock):
        """Re-recording a milestone is a no-op (the state machine
        does NOT error and does NOT advance again)."""
        mock_postgres_client._fetchrow_overrides.append(
            (
                "FROM onboarding_state",
                _state_row(
                    current_step="wait",
                    milestones_reached=["first_10_traces"],
                ),
            )
        )
        sm = OnboardingStateMachine()
        # Should not raise + should not advance.
        state = await sm.record_milestone("org-1", "first_10_traces")
        assert state.current_step == "wait"
        assert state.milestones_reached.count("first_10_traces") == 1


# ─- bonus: spec-level invariants ─────────────────────────────────────


class TestOnboardingInvariants:
    """Light invariants the 5 above don't cover."""

    def test_7_steps_in_order(self):
        ids = [s.value for s in ONBOARDING_STEPS]
        assert ids == [
            "install", "org", "connect", "wait", "done", "tour", "autonomous",
        ]

    def test_cutover_date_is_july_1_2026(self):
        # The plan's "new-orgs-only rollout flag" is a one-line
        # date change; locking the constant here so a future edit
        # is deliberate.
        assert ONBOARDING_V2_CUTOVER.year == 2026
        assert ONBOARDING_V2_CUTOVER.month == 7
        assert ONBOARDING_V2_CUTOVER.day == 1

    def test_is_legacy_org_recognises_pre_cutover(self):
        # Pre-cutover: legacy.
        assert _is_legacy_org("2025-01-01T00:00:00+00:00") is True
        assert _is_legacy_org("2026-06-30T00:00:00+00:00") is True
        # Post-cutover: new.
        assert _is_legacy_org("2026-07-01T00:00:00+00:00") is False
        assert _is_legacy_org("2026-08-15T00:00:00+00:00") is False
        # No timestamp: assume new (safe default for fresh orgs).
        assert _is_legacy_org(None) is False
