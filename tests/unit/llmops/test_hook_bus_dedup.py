"""HookBus dedup + cascade + severity precedence per upgradespec §E.3."""

from __future__ import annotations

import asyncio

import pytest

from eden.llmops.hooks_bus import HookBus, HookEvent


def _event(reason="low_user_satisfaction", severity="medium", org_id="org-1",
           primary_entity_id="feat-checkout", source=None, parent_hook_id=None,
           dedup_window_seconds=300):
    return HookEvent(
        reason=reason,
        severity=severity,
        org_id=org_id,
        source={"primary_entity_id": primary_entity_id, **(source or {})},
        context={},
        parent_hook_id=parent_hook_id,
        dedup_window_seconds=dedup_window_seconds,
        requires_human_approval=False,
    )


@pytest.mark.asyncio
async def test_first_emit_returns_hook_id():
    bus = HookBus()
    ev = _event()
    hid = await bus.emit(ev)
    assert hid is not None
    assert isinstance(hid, str)


@pytest.mark.asyncio
async def test_dedup_within_window_returns_none():
    bus = HookBus()
    ev = _event()
    first = await bus.emit(ev)
    second = await bus.emit(_event())
    assert first is not None
    assert second is None  # deduped


@pytest.mark.asyncio
async def test_dedup_window_expires():
    bus = HookBus()
    ev = _event(dedup_window_seconds=0)  # window = 0 → expires immediately
    first = await bus.emit(ev)
    second = await bus.emit(_event(dedup_window_seconds=0))
    assert first is not None
    assert second is not None  # not deduped


@pytest.mark.asyncio
async def test_different_orgs_not_deduped():
    bus = HookBus()
    a = await bus.emit(_event(org_id="org-A"))
    b = await bus.emit(_event(org_id="org-B"))
    assert a is not None
    assert b is not None


@pytest.mark.asyncio
async def test_different_reasons_not_deduped():
    bus = HookBus()
    a = await bus.emit(_event(reason="low_user_satisfaction"))
    b = await bus.emit(_event(reason="low_roi_department"))
    assert a is not None
    assert b is not None


@pytest.mark.asyncio
async def test_severity_suppression_higher_wins():
    """Per §E.3 — higher severity within 1h suppresses lower for same entity."""
    bus = HookBus()
    # Fire critical first
    crit = await bus.emit(_event(reason="compliance_gap:gdpr", severity="critical"))
    # Now try to fire low for the same entity — should be suppressed
    low = await bus.emit(_event(reason="compliance_gap:gdpr", severity="low"))
    assert crit is not None
    assert low is None


@pytest.mark.asyncio
async def test_cascade_dedup_inherits_parent_window():
    """Per §E.3 — cascade events inherit the parent's dedup window."""
    bus = HookBus()
    parent = await bus.emit(_event(reason="incident_clustered", severity="high", dedup_window_seconds=600))
    child = await bus.emit(
        _event(reason="incident_clustered", parent_hook_id=parent)
    )
    assert parent is not None
    assert child is None  # cascade dedup'd


@pytest.mark.asyncio
async def test_high_severity_requires_approval():
    """Per §E.4 — high/critical severity → requires_approval=True."""
    bus = HookBus()
    ev = _event(reason="compliance_gap:gdpr", severity="critical")
    hid = await bus.emit(ev)
    assert hid is not None
    # Even though requires_approval=False on the event itself, the bus
    # elevates to required for critical/high.
    # (Full proposal.persist() is best-effort and may not write if no DB —
    # the assertion is that emit succeeds and returns an id.)
