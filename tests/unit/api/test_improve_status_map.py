"""Soft Autonomy Phase 2: improve status mapping must not resurrect dead PRs."""

from __future__ import annotations

from eden.api.routes.portal import _map_improve_status


def test_closed_maps_to_blocked_not_needs_you() -> None:
    # Migration 118 marks plans 'closed' when the PR is closed on GitHub
    # without merging. That must never surface as "needs you" again.
    assert _map_improve_status("closed") == "blocked"


def test_known_statuses() -> None:
    assert _map_improve_status("draft") == "needs_you"
    assert _map_improve_status("pending_review") == "needs_you"
    assert _map_improve_status("approved") == "in_progress"
    assert _map_improve_status("pr_opened") == "verify"
    assert _map_improve_status("merged") == "done"
    assert _map_improve_status("rejected") == "blocked"
    assert _map_improve_status(None) == "needs_you"
