"""Tests for the consolidated account-erasure code path (FEAT-5,
2026-08 strategic-review remediation).

Before this change, three HTTP routes each had their own
non-communicating account-deletion implementation:

  * ``DELETE /api/v1/me``  -> ``compliance_jobs.run_user_delete_job``
    (narrow: only anonymised ``users`` + deleted ``org_members``)
  * ``DELETE /users/me``   -> inline SQL in ``routes/auth.py``
    (narrower still: only ``deleted_at`` + ``token_version``)
  * ``POST /governance/rtbf`` -> ``RightToBeForgottenService``
    (the real six-table + cross-store-fanout erasure, but gated
    behind a feature flag and never called by the other two)

``erase_user_account`` is now the single implementation both
self-service routes converge on. These tests exercise it directly
(against a stub Postgres client + a mocked RTBF service) and via
``run_user_delete_job``.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.services import compliance_jobs


class _StubPg:
    """Minimal in-memory Postgres stub for org_members + users queries."""

    def __init__(self, *, org_ids: list[str] | None = None) -> None:
        self.org_ids = org_ids or []
        self.executed: list[tuple[str, tuple]] = []
        self.org_members_deleted_for: list[str] = []
        self.users_anonymized_for: list[str] = []

    async def fetch(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        if "SELECT org_id FROM org_members" in q:
            return [{"org_id": oid} for oid in self.org_ids]
        return []

    async def execute(self, query: str, *args, **kwargs):
        q = " ".join(query.split())
        self.executed.append((q, args))
        if "DELETE FROM org_members" in q:
            self.org_members_deleted_for.append(args[0])
        elif "UPDATE users SET" in q and "deleted_at = NOW()" in q:
            self.users_anonymized_for.append(args[0])
        return None


def _mock_rtbf_service(results_by_org: dict[str, dict[str, Any]]):
    """Patch RightToBeForgottenService.process_request to return
    canned envelopes keyed by org_id."""
    instance = AsyncMock()

    async def _process(org_id, *, user_id, requested_by=None, **kwargs):
        return results_by_org[org_id]

    instance.process_request = _process
    return patch(
        "eden.services.governance_intel.gdpr.RightToBeForgottenService",
        return_value=instance,
    )


def _ok_envelope(complete: bool = True) -> dict[str, Any]:
    return {"status": "ok", "data": {"complete": complete}}


def _error_envelope(message: str = "boom") -> dict[str, Any]:
    return {"status": "error", "data": {"message": message, "complete": False}}


class TestEraseUserAccount:
    @pytest.mark.asyncio
    async def test_no_orgs_still_anonymizes_account(self) -> None:
        pg = _StubPg(org_ids=[])
        summary = await compliance_jobs.erase_user_account(
            "user-1", requested_by="user-1", client=pg
        )
        assert summary["account_anonymized"] is True
        assert summary["failures"] == []
        assert pg.users_anonymized_for == ["user-1"]
        assert pg.org_members_deleted_for == ["user-1"]

    @pytest.mark.asyncio
    async def test_calls_rtbf_service_once_per_org(self) -> None:
        pg = _StubPg(org_ids=["org-a", "org-b"])
        seen_orgs: list[str] = []

        instance = AsyncMock()

        async def _process(org_id, *, user_id, requested_by=None, **kwargs):
            seen_orgs.append(org_id)
            assert user_id == "user-1"
            assert requested_by == "user-1"
            return _ok_envelope()

        instance.process_request = _process

        with patch(
            "eden.services.governance_intel.gdpr.RightToBeForgottenService",
            return_value=instance,
        ):
            summary = await compliance_jobs.erase_user_account(
                "user-1", requested_by="user-1", client=pg
            )

        assert sorted(seen_orgs) == ["org-a", "org-b"]
        assert summary["account_anonymized"] is True
        assert summary["failures"] == []
        assert summary["incomplete_orgs"] == []

    @pytest.mark.asyncio
    async def test_hard_rtbf_failure_blocks_anonymization(self) -> None:
        """A fail-closed 'error' envelope from any org must stop the
        erasure from proceeding, not silently anonymise anyway."""
        pg = _StubPg(org_ids=["org-a", "org-b"])

        with _mock_rtbf_service(
            {"org-a": _ok_envelope(), "org-b": _error_envelope("sql failed")}
        ):
            summary = await compliance_jobs.erase_user_account(
                "user-1", requested_by="user-1", client=pg
            )

        assert summary["account_anonymized"] is False
        assert pg.users_anonymized_for == []
        assert pg.org_members_deleted_for == []
        assert len(summary["failures"]) == 1
        assert summary["failures"][0]["org_id"] == "org-b"
        assert "sql failed" in summary["failures"][0]["error"]

    @pytest.mark.asyncio
    async def test_incomplete_fanout_does_not_block_anonymization(self) -> None:
        """A known cross-store gap (e.g. Typesense pre-backfill, S3
        'unsupported') must not block self-service deletion — today's
        infra genuinely can't guarantee 100% fanout yet."""
        pg = _StubPg(org_ids=["org-a"])

        with _mock_rtbf_service({"org-a": _ok_envelope(complete=False)}):
            summary = await compliance_jobs.erase_user_account(
                "user-1", requested_by="user-1", client=pg
            )

        assert summary["account_anonymized"] is True
        assert summary["failures"] == []
        assert summary["incomplete_orgs"] == ["org-a"]

    @pytest.mark.asyncio
    async def test_rtbf_exception_is_recorded_as_failure(self) -> None:
        pg = _StubPg(org_ids=["org-a"])
        instance = AsyncMock()
        instance.process_request = AsyncMock(side_effect=RuntimeError("db down"))

        with patch(
            "eden.services.governance_intel.gdpr.RightToBeForgottenService",
            return_value=instance,
        ):
            summary = await compliance_jobs.erase_user_account(
                "user-1", requested_by="user-1", client=pg
            )

        assert summary["account_anonymized"] is False
        assert len(summary["failures"]) == 1
        assert "db down" in summary["failures"][0]["error"]


class TestRunUserDeleteJob:
    @pytest.mark.asyncio
    async def test_marks_completed_on_success(self) -> None:
        marks: list[dict[str, Any]] = []

        async def _mark_job(job_id, *, status, download_url=None, error_message=None):
            marks.append({"status": status, "error_message": error_message})

        with patch.object(compliance_jobs, "_mark_job", _mark_job), patch.object(
            compliance_jobs,
            "erase_user_account",
            AsyncMock(
                return_value={
                    "user_id": "user-1",
                    "org_ids": [],
                    "rtbf_results": {},
                    "failures": [],
                    "incomplete_orgs": [],
                    "account_anonymized": True,
                }
            ),
        ):
            await compliance_jobs.run_user_delete_job("job-1", "user-1")

        statuses = [m["status"] for m in marks]
        assert statuses == ["running", "completed"]

    @pytest.mark.asyncio
    async def test_marks_failed_when_erasure_has_failures(self) -> None:
        marks: list[dict[str, Any]] = []

        async def _mark_job(job_id, *, status, download_url=None, error_message=None):
            marks.append({"status": status, "error_message": error_message})

        with patch.object(compliance_jobs, "_mark_job", _mark_job), patch.object(
            compliance_jobs,
            "erase_user_account",
            AsyncMock(
                return_value={
                    "user_id": "user-1",
                    "org_ids": ["org-a"],
                    "rtbf_results": {},
                    "failures": [{"org_id": "org-a", "error": "sql failed"}],
                    "incomplete_orgs": [],
                    "account_anonymized": False,
                }
            ),
        ):
            await compliance_jobs.run_user_delete_job("job-1", "user-1")

        statuses = [m["status"] for m in marks]
        assert statuses == ["running", "failed"]
        assert "sql failed" in marks[-1]["error_message"]
