"""M3 (D6/D7/D29) — verify hardening.

* empty fingerprint → re-derive from the issue; still empty → failed
  ``no_fingerprint`` (never an auto-pass);
* thrown StatGate scorer → inconclusive → consume attempt + retry →
  attempts exhausted → failed ``statgate_error``;
* D29: the re-score judges on RECENT evidence — a healed P0 with a clean
  quiet window passes;
* D7: ``verify_poll_interval_seconds`` is a read-through alias of
  ``verify_loop_interval_seconds`` with a one-time deprecation log.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop import verify

ORG = "org-verify-hardening"
ISSUE = "dddddddd-dddd-dddd-dddd-dddddddddddd"
FP = "fp-hardening"


@pytest.fixture(autouse=True)
def _clean_state():
    verify._reset_state_for_tests()
    yield
    verify._reset_state_for_tests()


def _issue(
    fingerprint: str = FP,
    severity: str = "p0",
    kind: str = "statgate_p0",
    stumble_count: int = 9,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=ISSUE,
        kind=kind,
        severity=severity,
        stumble_count=stumble_count,
        fingerprint=fingerprint,
    )


def _repo(
    issue: SimpleNamespace | None,
    recent: int = 0,
    stumbles: list[dict[str, Any]] | None = None,
) -> MagicMock:
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    repo.count_recent_stumbles = AsyncMock(return_value=recent)
    repo.list_stumbles = AsyncMock(return_value=stumbles or [])
    return repo


# ── empty fingerprint (D6) ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_empty_fingerprint_still_empty_fails() -> None:
    repo = _repo(_issue(fingerprint=""))
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        passed, detail = await verify._verify_issue(ORG, ISSUE, "")

    assert passed is False
    assert detail["reason"] == "no_fingerprint"
    repo.count_recent_stumbles.assert_not_awaited()


@pytest.mark.asyncio
async def test_empty_fingerprint_rederived_from_issue() -> None:
    repo = _repo(_issue(severity="p2", kind="tool_error"))
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        passed, detail = await verify._verify_issue(ORG, ISSUE, "")

    assert passed is True
    repo.count_recent_stumbles.assert_awaited_once()
    assert repo.count_recent_stumbles.await_args.args[1] == FP


# ── StatGate re-score exception → inconclusive (D6) ─────────────────


@pytest.mark.asyncio
async def test_thrown_scorer_is_inconclusive_not_pass() -> None:
    repo = _repo(_issue())
    with patch("eden.issues.repo.IssuesRepo", return_value=repo), patch(
        "eden.issues.statgate_scorer.StatGateIncidentScorer",
        MagicMock(side_effect=RuntimeError("scorer down")),
    ):
        passed, detail = await verify._verify_issue(ORG, ISSUE, FP)

    assert passed is None  # inconclusive — never a silent pass
    assert detail["reason"] == "statgate_error"


def _verify_client(attempts: int) -> MagicMock:
    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "id": "v1",
                "org_id": ORG,
                "issue_id": ISSUE,
                "fingerprint": FP,
                "ref": FP,
                "attempts": attempts,
            }
        ]
    )
    client.execute = AsyncMock(return_value="OK")
    return client


@pytest.mark.asyncio
async def test_inconclusive_consumes_attempt_and_retries() -> None:
    client = _verify_client(attempts=0)
    with patch.object(verify, "_pg", AsyncMock(return_value=client)), patch.object(
        verify, "_verify_issue", AsyncMock(return_value=(None, {"x": 1}))
    ), patch("eden.closed_loop.event_bus.publish", AsyncMock()) as publish:
        summary = await verify.run_due_verifications()

    assert summary["retried"] == 1
    assert summary["failed"] == 0
    publish.assert_not_awaited()
    # Attempt consumed via the reschedule write.
    reschedules = [
        c for c in client.execute.await_args_list if "SET attempts" in c.args[0]
    ]
    assert reschedules and reschedules[0].args[2] == 1


@pytest.mark.asyncio
async def test_inconclusive_exhausted_fails_with_statgate_error() -> None:
    client = _verify_client(attempts=2)  # attempt 3 of max 3
    emitted: list[Any] = []
    with patch.object(verify, "_pg", AsyncMock(return_value=client)), patch.object(
        verify, "_verify_issue", AsyncMock(return_value=(None, {"x": 1}))
    ), patch(
        "eden.closed_loop.event_bus.publish",
        AsyncMock(side_effect=lambda e: emitted.append(e)),
    ):
        summary = await verify.run_due_verifications()

    assert summary["failed"] == 1
    assert emitted and emitted[0].type == "verify_failed"
    assert emitted[0].payload["verify"]["reason"] == "statgate_error"


# ── D29: re-score judges recent evidence ────────────────────────────


@pytest.mark.asyncio
async def test_healed_p0_with_clean_window_passes() -> None:
    """Stored severity=='p0' + lifetime stumble_count must not fail a
    verification whose quiet window is clean (real scorer, no mocks)."""
    repo = _repo(_issue(severity="p0", kind="statgate_p0", stumble_count=9))
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        passed, detail = await verify._verify_issue(ORG, ISSUE, FP)

    assert passed is True
    assert detail["statgate_p0"] is False
    assert detail["reason"] == "quiet window clean + no P0"


@pytest.mark.asyncio
async def test_stale_stumbles_filtered_client_side() -> None:
    """Even when the repo ignores ``since``, old P0 stumbles are dropped
    before scoring."""
    old = {
        "kind": "statgate_p0",
        "detail": {},
        "detected_at": datetime.now(UTC) - timedelta(hours=6),
    }
    repo = _repo(_issue(), stumbles=[old])
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        passed, detail = await verify._verify_issue(ORG, ISSUE, FP)

    assert passed is True
    # The since filter reached the repo call too.
    assert repo.list_stumbles.await_args.kwargs.get("since") is not None


@pytest.mark.asyncio
async def test_recent_p0_stumble_still_fails() -> None:
    fresh = {
        "kind": "statgate_p0",
        "detail": {},
        "detected_at": datetime.now(UTC),
    }
    repo = _repo(_issue(), stumbles=[fresh])
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        passed, detail = await verify._verify_issue(ORG, ISSUE, FP)

    assert passed is False
    assert detail["reason"] == "StatGate still flags P0"


# ── D7: poll-interval alias ─────────────────────────────────────────


def test_verify_poll_interval_alias_resolves(caplog) -> None:
    import eden.config as config_mod
    from eden.config import get_settings

    settings = get_settings()
    config_mod._VERIFY_POLL_ALIAS_WARNED = False
    with caplog.at_level(logging.WARNING, logger="eden.config"):
        first = settings.verify_poll_interval_seconds
        second = settings.verify_poll_interval_seconds

    assert first == settings.verify_loop_interval_seconds
    assert second == first
    deprecations = [
        r for r in caplog.records if "deprecated" in r.getMessage()
    ]
    assert len(deprecations) == 1  # one-time log
