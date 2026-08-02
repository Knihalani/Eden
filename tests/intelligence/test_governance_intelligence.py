"""Behavioural tests for Cat 10 — Governance Intelligence.

Exercises the six services
(:class:`ApprovalWorkflowService`,
:class:`ComplianceEvidenceGenerator`, :class:`SecurityScanner`,
:class:`RightToBeForgottenService`, :class:`DataLineageService`,
:class:`ComplianceDashboardService`) and the 13 routes that
expose them, plus the Cat 17 closed-loop hooks that the
compliance generator and security scanner fire.

Structure mirrors
:mod:`tests.intelligence.test_outcome_roi_intelligence` and
:mod:`tests.intelligence.test_user_intelligence`:

* **Service-level unit tests** — call the service classes
  directly with a custom Postgres mock that routes by SQL
  fragment.
* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_governance`` router mounted and
  ``get_current_user`` overridden. Each of the 13 routes is
  hit and the response envelope shape is asserted.
"""

from __future__ import annotations

import importlib
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Postgres router mock ───────────────────────────────────────────


def _pg_router(
    *,
    workflows: list[dict[str, Any]] | None = None,
    requests: list[dict[str, Any]] | None = None,
    audit_log_count: int = 0,
    role_change_count: int = 0,
    usage_events_count: int = 0,
    judge_score_count: int = 0,
    pii_policies_count: int = 0,
    incident_count: int = 0,
    intervention_count: int = 0,
    rtbf_count: int = 0,
    approvals_count: int = 0,
    telemetry_events: list[dict[str, Any]] | None = None,
    org_pii_policies: list[dict[str, Any]] | None = None,
    rtbf_table_counts: dict[str, int] | None = None,
    outcomes_by_trace: list[dict[str, Any]] | None = None,
    telemetry_by_trace: list[dict[str, Any]] | None = None,
    telemetry_by_user: list[dict[str, Any]] | None = None,
    outcome_to_trace: list[dict[str, Any]] | None = None,
    audit_log_by_target: list[dict[str, Any]] | None = None,
    evidence_packs: list[dict[str, Any]] | None = None,
    scan_runs: list[dict[str, Any]] | None = None,
    approvals_state_counts: list[dict[str, Any]] | None = None,
    rtbf_audit_rollup: list[dict[str, Any]] | None = None,
    rtbf_conversation_ids: list[Any] | None = None,
) -> MagicMock:
    """Build a Postgres mock whose ``fetch`` / ``execute`` route
    on SQL fragments. Defaults to empty for every branch — tests
    override the bits they care about.
    """
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="OK")
    pg.fetchrow = AsyncMock(return_value=None)

    async def _fetch(query: str, *args: Any) -> list[dict[str, Any]]:
        q = query.lower()

        # ── RTBF per-table COUNT(*) — checked FIRST so the
        #    per-table override beats the generic ``from
        #    telemetry_events`` / ``from judge_scores`` branches.
        if rtbf_table_counts is not None and "count(*)" in q:
            for table_name, count in rtbf_table_counts.items():
                if f"from {table_name}" in q:
                    return [{"count": count}]

        # ── Approval workflow + requests reads ─────────────────
        if "from approval_workflows" in q:
            return list(workflows or [])
        if "from approval_requests" in q:
            if "group by state" in q:
                return list(approvals_state_counts or [])
            if "count(*)" in q and "between" in q:
                return [{"count": approvals_count}]
            return list(requests or [])

        # ── Compliance source counts (one per source) ──────────
        if "from org_audit_log" in q:
            if "rtbf.processed" in q and "max(created_at)" in q:
                # Dashboard rtbf rollup
                return list(rtbf_audit_rollup or [
                    {"count": rtbf_count, "last_at": None},
                ])
            if "rtbf.processed" in q:
                return [{"count": rtbf_count}]
            if "target_type" in q and "target_id" in q:
                return list(audit_log_by_target or [])
            if "role.%" in q or "member.%" in q or "invite.%" in q:
                return [{"count": role_change_count}]
            if "change.%" in q:
                return [{"count": 0}]
            return [{"count": audit_log_count}]
        if "from usage_events" in q:
            return [{"count": usage_events_count}]
        if "from judge_scores" in q:
            return [{"count": judge_score_count}]
        if "from org_pii_policies" in q and "pattern_name" in q:
            return list(org_pii_policies or [])
        if "from org_pii_policies" in q and "count" in q:
            return [{"count": pii_policies_count}]
        if "from org_pii_policies" in q:
            # Evidence-context snapshot (non-count SELECT)
            return list(org_pii_policies or [])
        if "from org_retention_policies" in q:
            return []
        if "from incident_clusters" in q:
            return [{"count": incident_count}]
        if "from intervention_log" in q:
            return [{"count": intervention_count}]

        # ── Compliance evidence read paths ─────────────────────
        if "from compliance_evidence" in q:
            return list(evidence_packs or [])

        # ── Security scan read paths ───────────────────────────
        if "from security_scan_runs" in q:
            return list(scan_runs or [])
        if "from telemetry_events" in q:
            if "distinct user_id" in q:
                return list(telemetry_by_trace or [])
            if "distinct trace_id" in q:
                return list(telemetry_by_user or [])
            return list(telemetry_events or [])
        # ── RTBF scope derivation: the user's conversation ids ──
        if "select id from conversations" in q:
            return [{"id": cid} for cid in (rtbf_conversation_ids or [])]
        if "from outcomes" in q:
            if "select trace_id" in q:
                return list(outcome_to_trace or [])
            return list(outcomes_by_trace or [])

        # ── RTBF: per-table row counts (legacy block, kept for
        #    forward-compat; first-pass branch above usually
        #    matches first).
        if rtbf_table_counts is not None:
            for table_name, count in rtbf_table_counts.items():
                if f"from {table_name}" in q and "count(*)" in q:
                    return [{"count": count}]

        return []

    pg.fetch = AsyncMock(side_effect=_fetch)
    return pg


# ─── Module-imports under test ──────────────────────────────────────


@pytest.fixture(scope="module")
def gov_modules():
    """Import once per module; saves ~1s on the full file."""
    from eden.services.governance_intel import (
        ApprovalWorkflowService,
        ComplianceDashboardService,
        ComplianceEvidenceGenerator,
        DataLineageService,
        RightToBeForgottenService,
        SecurityScanner,
    )
    return {
        "approvals": ApprovalWorkflowService,
        "compliance": ComplianceEvidenceGenerator,
        "security": SecurityScanner,
        "rtbf": RightToBeForgottenService,
        "lineage": DataLineageService,
        "dashboard": ComplianceDashboardService,
    }


# ─── 1. ApprovalWorkflowService ─────────────────────────────────────


class TestApprovalWorkflow:
    @pytest.mark.asyncio
    async def test_create_returns_workflow_id(self, gov_modules) -> None:
        svc = gov_modules["approvals"]()
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.create(
                "org_test",
                name="Override judge threshold",
                resource_type="judge_threshold",
                required_approvers=2,
                ttl_seconds=3600,
            )
        assert out["status"] == "ok"
        assert out["live"] is True
        assert out["data"]["workflow_id"].startswith("wf_")
        assert out["data"]["required_approvers"] == 2
        # Persistence call was made
        assert pg.execute.await_count >= 1

    @pytest.mark.asyncio
    async def test_create_rejects_blank_name(self, gov_modules) -> None:
        svc = gov_modules["approvals"]()
        out = await svc.create(
            "org_test", name="  ", required_approvers=1,
        )
        assert out["status"] == "bad_request"
        assert "name" in out["data"]["message"].lower()

    @pytest.mark.asyncio
    async def test_create_rejects_low_approvers(self, gov_modules) -> None:
        svc = gov_modules["approvals"]()
        out = await svc.create(
            "org_test", name="x", required_approvers=0,
        )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_create_rejects_short_ttl(self, gov_modules) -> None:
        svc = gov_modules["approvals"]()
        out = await svc.create(
            "org_test", name="x", ttl_seconds=10,
        )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_request_creates_pending(self, gov_modules) -> None:
        svc = gov_modules["approvals"]()
        pg = _pg_router(
            workflows=[{
                "steps_json": json.dumps({
                    "required_approvers": 2, "ttl_seconds": 3600,
                }),
                "status": "active",
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.request(
                "org_test",
                workflow_id="wf_abc",
                requested_by="user_a",
                action="override_judge_threshold",
                target="hallucination",
                value=0.25,
            )
        assert out["status"] == "ok"
        assert out["data"]["request_id"].startswith("req_")
        assert out["data"]["state"] == "pending"
        assert out["data"]["approvers_required"] == 2

    @pytest.mark.asyncio
    async def test_request_rejects_inactive_workflow(self, gov_modules) -> None:
        svc = gov_modules["approvals"]()
        pg = _pg_router(
            workflows=[{
                "steps_json": "{}",
                "status": "archived",
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.request(
                "org_test",
                workflow_id="wf_abc",
                requested_by="user_a",
                action="x",
            )
        assert out["status"] == "bad_request"
        assert "not active" in out["data"]["message"]

    @pytest.mark.asyncio
    async def test_resolve_enforces_invariant(self, gov_modules) -> None:
        """``requested_by`` cannot approve their own request."""
        svc = gov_modules["approvals"]()
        pg = _pg_router(
            requests=[{
                "requested_by": "user_a",
                "state": "pending",
                "payload_json": json.dumps({
                    "approvers_required": 1,
                    "approvers": [],
                }),
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.resolve(
                "org_test",
                request_id="req_xyz",
                approver="user_a",
                decision="approve",
            )
        assert out["status"] == "bad_request"
        assert "own request" in out["data"]["message"]

    @pytest.mark.asyncio
    async def test_resolve_approve_moves_to_approved(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["approvals"]()
        pg = _pg_router(
            requests=[{
                "requested_by": "user_a",
                "state": "pending",
                "payload_json": json.dumps({
                    "approvers_required": 1, "approvers": [],
                }),
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.resolve(
                "org_test",
                request_id="req_xyz",
                approver="user_b",
                decision="approve",
            )
        assert out["status"] == "ok"
        assert out["data"]["state"] == "approved"
        assert out["data"]["approvers_received"] == 1

    @pytest.mark.asyncio
    async def test_resolve_deny_moves_to_denied(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["approvals"]()
        pg = _pg_router(
            requests=[{
                "requested_by": "user_a",
                "state": "pending",
                "payload_json": json.dumps({
                    "approvers_required": 2, "approvers": [],
                }),
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.resolve(
                "org_test",
                request_id="req_xyz",
                approver="user_b",
                decision="deny",
                rationale="not ok",
            )
        assert out["data"]["state"] == "denied"

    @pytest.mark.asyncio
    async def test_resolve_partial_keeps_pending(
        self, gov_modules,
    ) -> None:
        """Two approvers required, one given — stays ``pending``."""
        svc = gov_modules["approvals"]()
        pg = _pg_router(
            requests=[{
                "requested_by": "user_a",
                "state": "pending",
                "payload_json": json.dumps({
                    "approvers_required": 2, "approvers": [],
                }),
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.resolve(
                "org_test",
                request_id="req_xyz",
                approver="user_b",
                decision="approve",
            )
        assert out["data"]["state"] == "pending"
        assert out["data"]["approvers_received"] == 1

    @pytest.mark.asyncio
    async def test_resolve_rejects_duplicate_approver(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["approvals"]()
        pg = _pg_router(
            requests=[{
                "requested_by": "user_a",
                "state": "pending",
                "payload_json": json.dumps({
                    "approvers_required": 2,
                    "approvers": ["user_b"],
                }),
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.resolve(
                "org_test",
                request_id="req_xyz",
                approver="user_b",
                decision="approve",
            )
        assert out["status"] == "bad_request"
        assert "already" in out["data"]["message"]

    @pytest.mark.asyncio
    async def test_resolve_rejects_non_pending(self, gov_modules) -> None:
        svc = gov_modules["approvals"]()
        pg = _pg_router(
            requests=[{
                "requested_by": "user_a",
                "state": "approved",
                "payload_json": "{}",
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.resolve(
                "org_test",
                request_id="req_xyz",
                approver="user_b",
                decision="approve",
            )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_list_requests_filters_state(self, gov_modules) -> None:
        svc = gov_modules["approvals"]()
        pg = _pg_router(
            requests=[
                {"id": "req_1", "workflow_id": "wf_1",
                 "requested_by": "user_a", "state": "pending",
                 "payload_json": json.dumps({"action": "x"}),
                 "created_at": None},
            ],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.list_requests(
                "org_test", state="pending", limit=10,
            )
        assert out["status"] == "ok"
        assert out["data"]["count"] == 1
        assert out["data"]["requests"][0]["state"] == "pending"

    @pytest.mark.asyncio
    async def test_list_requests_rejects_unknown_state(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["approvals"]()
        out = await svc.list_requests(
            "org_test", state="bogus",
        )
        assert out["status"] == "bad_request"


# ─── 2. ComplianceEvidenceGenerator ─────────────────────────────────


class TestComplianceEvidence:
    @pytest.mark.asyncio
    async def test_generate_soc2_returns_50_plus_controls(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["compliance"]()
        pg = _pg_router(
            audit_log_count=1234,
            role_change_count=50,
            usage_events_count=1_000_000,
            judge_score_count=200,
            pii_policies_count=3,
            incident_count=2,
            intervention_count=5,
            approvals_count=8,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.generate_soc2_evidence(
                "org_test",
                period_start="2026-04-01",
                period_end="2026-06-30",
            )
        assert out["status"] == "ok"
        assert out["live"] is True
        d = out["data"]
        assert d["framework"] == "soc2_type_ii"
        assert d["control_count"] >= 50
        # Every control has an evidence entry
        for ctrl in d["controls"]:
            assert "evidence_count" in ctrl
            assert "status" in ctrl
            assert ctrl["status"] in ("pass", "warn", "fail")
        assert "passing" in d
        assert "failing" in d
        assert d["evidence_pack_id"].startswith("ev_")
        # Persistence + closed-loop hook attempted
        assert pg.execute.await_count >= 1

    @pytest.mark.asyncio
    async def test_generate_hipaa_returns_18_safeguards(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["compliance"]()
        pg = _pg_router(
            audit_log_count=10, role_change_count=5,
            usage_events_count=1000, judge_score_count=5,
            pii_policies_count=2,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.generate_hipaa_evidence(
                "org_test",
                period_start="2026-04-01",
                period_end="2026-06-30",
            )
        assert out["status"] == "ok"
        assert out["data"]["framework"] == "hipaa"
        assert out["data"]["control_count"] == 18

    @pytest.mark.asyncio
    async def test_generate_gdpr_returns_10_controls(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["compliance"]()
        pg = _pg_router(
            audit_log_count=10, pii_policies_count=2,
            usage_events_count=1000, judge_score_count=5,
            rtbf_count=1,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.generate_gdpr_evidence(
                "org_test",
                period_start="2026-04-01",
                period_end="2026-06-30",
            )
        assert out["data"]["framework"] == "gdpr"
        assert out["data"]["control_count"] == 10
        rtbf_ctrls = [c for c in out["data"]["controls"]
                      if c["control_id"] == "Art.17"]
        assert len(rtbf_ctrls) == 1
        assert rtbf_ctrls[0]["status"] == "pass"

    @pytest.mark.asyncio
    async def test_generate_iso27001_returns_14_families(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["compliance"]()
        pg = _pg_router(
            audit_log_count=10, pii_policies_count=2,
            usage_events_count=1000, judge_score_count=5,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.generate_iso27001_evidence(
                "org_test",
                period_start="2026-04-01",
                period_end="2026-06-30",
            )
        assert out["data"]["framework"] == "iso27001"
        assert out["data"]["control_count"] == 14

    @pytest.mark.asyncio
    async def test_generate_rejects_unknown_framework(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["compliance"]()
        out = await svc.generate(
            "org_test",
            framework="bogus",
            period_start="2026-04-01",
            period_end="2026-06-30",
        )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_generate_rejects_inverted_period(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["compliance"]()
        out = await svc.generate(
            "org_test",
            framework="soc2",
            period_start="2026-06-30",
            period_end="2026-04-01",
        )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_generate_rejects_bad_date(self, gov_modules) -> None:
        svc = gov_modules["compliance"]()
        out = await svc.generate(
            "org_test",
            framework="soc2",
            period_start="not-a-date",
            period_end="2026-06-30",
        )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_alias_soc2_normalises_to_soc2_type_ii(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["compliance"]()
        pg = _pg_router(audit_log_count=5)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.generate(
                "org_test", framework="SOC2",
                period_start="2026-04-01", period_end="2026-06-30",
            )
        assert out["data"]["framework"] == "soc2_type_ii"

    @pytest.mark.asyncio
    async def test_failing_controls_fire_drift_hook(
        self, gov_modules,
    ) -> None:
        """Empty data ⇒ many warnings + the pii_policies/judges
        ``fail`` paths trip — the drift hook should fire when ≥1
        controls fail.
        """
        svc = gov_modules["compliance"]()
        # All zeros → pii_policies → 'fail' on SOC2 because the
        # generator demands ≥1 policy.
        pg = _pg_router()
        hook = MagicMock()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=hook,
        ):
            out = await svc.generate_soc2_evidence(
                "org_test",
                period_start="2026-04-01",
                period_end="2026-06-30",
            )
        assert out["data"]["failing"] >= 1
        hook.on_drift_alert.assert_called_once()
        kwargs = hook.on_drift_alert.call_args.kwargs
        assert kwargs["drift_type"].startswith("compliance_gap:")

    @pytest.mark.asyncio
    async def test_list_packs(self, gov_modules) -> None:
        svc = gov_modules["compliance"]()
        pg = _pg_router(
            evidence_packs=[
                {"id": "ev_1", "framework": "soc2_type_ii",
                 "period_start": None, "period_end": None,
                 "generated_at": None},
            ],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.list_packs("org_test")
        assert out["status"] == "ok"
        assert out["data"]["count"] == 1

    @pytest.mark.asyncio
    async def test_get_pack_returns_body(self, gov_modules) -> None:
        svc = gov_modules["compliance"]()
        pg = _pg_router(
            evidence_packs=[{
                "evidence_json": json.dumps({
                    "framework": "gdpr", "controls": [],
                }),
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.get_pack(
                "org_test", evidence_pack_id="ev_1",
            )
        assert out["status"] == "ok"
        assert out["data"]["framework"] == "gdpr"

    @pytest.mark.asyncio
    async def test_get_pack_missing(self, gov_modules) -> None:
        svc = gov_modules["compliance"]()
        pg = _pg_router(evidence_packs=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.get_pack(
                "org_test", evidence_pack_id="ev_missing",
            )
        assert out["status"] == "bad_request"


# ─── 3. SecurityScanner ─────────────────────────────────────────────


class TestSecurityScanner:
    @pytest.mark.asyncio
    async def test_scan_flags_synthetic_ssn(self, gov_modules) -> None:
        svc = gov_modules["security"]()
        events = [
            {"id": "ev_1", "trace_id": "trc_1",
             "payload_json": "Customer SSN: 123-45-6789",
             "metadata_json": ""},
        ]
        pg = _pg_router(telemetry_events=events)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.scan_for_pii_leakage(
                "org_test",
                scanners=["ssn"],
                scope="payload",
            )
        assert out["status"] == "ok"
        findings = out["data"]["findings"]
        assert len(findings) == 1
        assert findings[0]["scanner"] == "ssn"
        assert findings[0]["count"] == 1
        assert out["data"]["n_events_redacted"] == 1

    @pytest.mark.asyncio
    async def test_scan_flags_synthetic_credit_card(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["security"]()
        events = [
            {"id": "ev_2", "trace_id": "trc_2",
             "payload_json": "card: 4532015112830366",
             "metadata_json": ""},
        ]
        pg = _pg_router(telemetry_events=events)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.scan_for_pii_leakage(
                "org_test",
                scanners=["credit_card"],
                scope="payload",
            )
        findings = out["data"]["findings"]
        assert any(f["scanner"] == "credit_card" for f in findings)

    @pytest.mark.asyncio
    async def test_scan_flags_synthetic_api_key(self, gov_modules) -> None:
        svc = gov_modules["security"]()
        events = [
            {"id": "ev_3", "trace_id": "trc_3",
             "payload_json": "sk_live_abcdefghij0123456789",
             "metadata_json": ""},
        ]
        pg = _pg_router(telemetry_events=events)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.scan_for_pii_leakage(
                "org_test",
                scanners=["api_keys"],
                scope="payload",
            )
        findings = out["data"]["findings"]
        assert any(f["scanner"] == "api_keys" for f in findings)
        # api_keys is critical → policy_violations counted
        assert out["data"]["policy_violations"] >= 1

    @pytest.mark.asyncio
    async def test_scan_rejects_unknown_scope(self, gov_modules) -> None:
        svc = gov_modules["security"]()
        out = await svc.scan_for_pii_leakage(
            "org_test", scope="all-of-them",
        )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_scan_clean_payload_finds_nothing(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["security"]()
        events = [
            {"id": "ev_4", "trace_id": "trc_4",
             "payload_json": "hello world",
             "metadata_json": ""},
        ]
        pg = _pg_router(telemetry_events=events)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.scan_for_pii_leakage(
                "org_test", scanners=["ssn", "credit_card"],
            )
        assert out["data"]["findings"] == []
        assert out["data"]["policy_violations"] == 0

    @pytest.mark.asyncio
    async def test_scan_drops_unknown_scanners(self, gov_modules) -> None:
        svc = gov_modules["security"]()
        events = [{"id": "e", "trace_id": "t",
                   "payload_json": "x", "metadata_json": ""}]
        pg = _pg_router(telemetry_events=events)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.scan_for_pii_leakage(
                "org_test",
                scanners=["bogus", "also-bogus", "ssn"],
            )
        assert sorted(out["data"]["dropped_scanners"]) == [
            "also-bogus", "bogus",
        ]

    @pytest.mark.asyncio
    async def test_scan_redaction_off_does_not_rewrite(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["security"]()
        events = [
            {"id": "ev_5", "trace_id": "trc_5",
             "payload_json": "123-45-6789",
             "metadata_json": ""},
        ]
        pg = _pg_router(telemetry_events=events)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.scan_for_pii_leakage(
                "org_test", scanners=["ssn"],
                redact_in_place=False,
            )
        assert out["data"]["n_events_redacted"] == 0
        assert out["data"]["findings"][0]["action_taken"] == (
            "flagged_only"
        )

    @pytest.mark.asyncio
    async def test_critical_finding_fires_hook(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["security"]()
        events = [
            {"id": "ev_6", "trace_id": "trc_6",
             "payload_json": "sk_live_abcdefghij0123456789",
             "metadata_json": ""},
        ]
        pg = _pg_router(telemetry_events=events)
        hook = MagicMock()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=hook,
        ):
            await svc.scan_for_pii_leakage(
                "org_test", scanners=["api_keys"],
            )
        hook.on_drift_alert.assert_called_once()
        kwargs = hook.on_drift_alert.call_args.kwargs
        assert kwargs["drift_type"] == "security:api_keys"
        assert kwargs["severity"] == "high"  # critical→high mapping

    @pytest.mark.asyncio
    async def test_scan_uses_org_pii_policies(self, gov_modules) -> None:
        """A tenant supplied a custom regex; it should be used in
        place of the default for that scanner name.
        """
        svc = gov_modules["security"]()
        events = [
            {"id": "ev_7", "trace_id": "trc_7",
             "payload_json": "match_me_TOKEN xyz",
             "metadata_json": ""},
        ]
        pg = _pg_router(
            telemetry_events=events,
            org_pii_policies=[
                {"pattern_name": "custom_tag",
                 "regex": r"match_me_TOKEN"},
            ],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.scan_for_pii_leakage(
                "org_test", scanners=["custom_tag"],
            )
        assert any(
            f["scanner"] == "custom_tag"
            for f in out["data"]["findings"]
        )

    @pytest.mark.asyncio
    async def test_list_runs(self, gov_modules) -> None:
        svc = gov_modules["security"]()
        pg = _pg_router(
            scan_runs=[
                {"id": "scan_1", "scan_type": "pii_leak",
                 "severity": "high",
                 "findings_json": json.dumps({
                     "findings": [{"count": 3}],
                     "n_events_scanned": 1000,
                 }),
                 "created_at": None},
            ],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.list_runs("org_test")
        assert out["data"]["count"] == 1
        assert out["data"]["runs"][0]["n_events_scanned"] == 1000


# ─── 4. RightToBeForgottenService ───────────────────────────────────


class TestRTBF:
    @pytest.mark.asyncio
    async def test_rtbf_anonymises_and_audit_logs(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["rtbf"]()
        pg = _pg_router(
            rtbf_table_counts={
                "telemetry_events": 50,
                "judge_scores": 5,
                "user_feedback": 2,
                "user_sessions": 1,
                "conversation_messages": 10,
                "conversations": 1,
            },
            # Scope-derivation results so judge_scores (via
            # trace_ids) and conversation_messages (via
            # conversation ids) are in scope.
            telemetry_by_user=[{"trace_id": f"trace_{i}"} for i in range(3)],
            rtbf_conversation_ids=["conv_1"],
        )
        # Stub cross-store fanout so retention/ClickHouse noise cannot
        # poison the JSON audit metadata (CI had MagicMock await errors).
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.governance_intel.rtbf_fanout.fanout_rtbf",
            new=AsyncMock(return_value=[
                {"store": "redis", "status": "ok"},
            ]),
        ):
            out = await svc.process_request(
                "org_test",
                user_id="user_to_forget",
                requested_by="admin_a",
                sla_days=14,
            )
        assert out["status"] == "ok"
        assert out["data"]["request_id"].startswith("rtbf_")
        # SHA-256 anonymous id, namespaced
        assert out["data"]["user_id_hash"].startswith("anon_")
        assert out["data"]["total_rows_matched"] == 69
        # Audit log was written
        any_audit_insert = any(
            "org_audit_log" in str(c.args[0]).lower()
            for c in pg.execute.await_args_list
        )
        assert any_audit_insert

    @pytest.mark.asyncio
    async def test_rtbf_dry_run_does_not_anonymise(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["rtbf"]()
        pg = _pg_router(
            rtbf_table_counts={"telemetry_events": 50},
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.process_request(
                "org_test",
                user_id="user_x",
                dry_run=True,
            )
        # No UPDATE issued
        update_calls = [
            c for c in pg.execute.await_args_list
            if "update " in str(c.args[0]).lower()
        ]
        assert update_calls == []
        assert out["data"]["dry_run"] is True

    @pytest.mark.asyncio
    async def test_rtbf_rejects_empty_user_id(self, gov_modules) -> None:
        svc = gov_modules["rtbf"]()
        out = await svc.process_request(
            "org_test", user_id="   ",
        )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_rtbf_anon_id_is_deterministic(
        self, gov_modules,
    ) -> None:
        """Same user_id → same anon_id across calls (so re-running
        on a retry lands at the same key).
        """
        from eden.services.governance_intel.gdpr import _anon_id_for
        a = _anon_id_for("alice@example.com")
        b = _anon_id_for("alice@example.com")
        c = _anon_id_for("bob@example.com")
        assert a == b
        assert a != c
        assert a.startswith("anon_")

    @pytest.mark.asyncio
    async def test_rtbf_clamps_sla_days(self, gov_modules) -> None:
        svc = gov_modules["rtbf"]()
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.process_request(
                "org_test", user_id="u", sla_days=999, dry_run=True,
            )
        assert out["data"]["sla_days"] == 90

    @pytest.mark.asyncio
    async def test_rtbf_fails_closed_when_postgres_unavailable(
        self, gov_modules,
    ) -> None:
        """No database must never look like a completed erasure."""
        svc = gov_modules["rtbf"]()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=None
        ):
            out = await svc.process_request("org_test", user_id="u")
        assert out["status"] == "error"
        assert out["data"]["complete"] is False

    @pytest.mark.asyncio
    async def test_rtbf_fails_closed_on_sql_error(
        self, gov_modules,
    ) -> None:
        """A table whose SQL raises must surface as a named failure
        in an ``error`` envelope — pre-fix this was swallowed and the
        response reported ``rows_matched: 0`` inside a success
        envelope (the ``gdpr.py:222`` silent-zero bug).
        """
        svc = gov_modules["rtbf"]()
        pg = _pg_router(rtbf_table_counts={"telemetry_events": 3})

        original_fetch = pg.fetch

        async def _boom_on_conversations(query, *args):
            q = query.lower()
            if "from conversations" in q and "count(*)" in q:
                raise RuntimeError("relation conversations does not exist")
            return await original_fetch(query, *args)

        pg.fetch = AsyncMock(side_effect=_boom_on_conversations)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.governance_intel.rtbf_fanout.fanout_rtbf",
            new=AsyncMock(return_value=[{"store": "redis", "status": "ok"}]),
        ):
            out = await svc.process_request(
                "org_test", user_id="user_to_forget", dry_run=True,
            )
        assert out["status"] == "error"
        assert out["data"]["complete"] is False
        failed_tables = {f["table"] for f in out["data"]["failures"]}
        assert failed_tables == {"conversations"}
        # The healthy tables still reported their real counts.
        by_table = {t["table"]: t for t in out["data"]["tables"]}
        assert by_table["telemetry_events"]["rows_matched"] == 3
        assert by_table["conversations"]["status"] == "failed"

    @pytest.mark.asyncio
    async def test_rtbf_sql_matches_live_schema(self, gov_modules) -> None:
        """Regression lock for the 2026-07-31 disabled-features entry:
        the erase path previously named columns that do not exist on
        the three tables holding user content. Assert the issued SQL
        uses the live-schema columns instead.
        """
        svc = gov_modules["rtbf"]()
        pg = _pg_router(
            rtbf_table_counts={
                "telemetry_events": 2,
                "judge_scores": 1,
                "user_feedback": 1,
                "user_sessions": 1,
                "conversation_messages": 4,
                "conversations": 1,
            },
            telemetry_by_user=[{"trace_id": "trace_1"}],
            rtbf_conversation_ids=["conv_1"],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.governance_intel.rtbf_fanout.fanout_rtbf",
            new=AsyncMock(return_value=[{"store": "redis", "status": "ok"}]),
        ):
            out = await svc.process_request(
                "org_test", user_id="user_to_forget",
            )
        assert out["status"] == "ok", out["data"].get("failures")

        executed = "\n".join(
            str(c.args[0]).lower() for c in pg.execute.await_args_list
        )
        fetched = "\n".join(
            str(c.args[0]).lower() for c in pg.fetch.await_args_list
        )
        all_sql = executed + "\n" + fetched

        # Dead columns from the pre-fix _RTBF_TABLES must be gone.
        for dead in ("payload_json", "metadata_json", "raw_input", "raw_output"):
            assert dead not in all_sql, f"dead column {dead} still referenced"

        # telemetry_events: tenant-scoped, user matched via attributes
        # keys, content columns scrubbed, zstd shadows nulled.
        assert "update telemetry_events" in executed
        assert "tenant_id" in executed
        assert "attributes->>'user_id'" in executed
        assert "request_body" in executed
        assert "payload_zstd = null" in executed

        # judge_scores: scoped through the user's trace_ids, not a
        # nonexistent user_id column.
        assert "update judge_scores set rationale" in executed
        assert "trace_id = any(" in executed

        # conversation_messages: scoped through conversation ids.
        assert "update conversation_messages set content" in executed
        assert "conversation_id = any(" in executed

        # Re-key tables still hash the user id.
        assert "update user_sessions set user_id" in executed
        assert "update conversations set user_id" in executed


# ─── 5. DataLineageService ──────────────────────────────────────────


class TestLineage:
    @pytest.mark.asyncio
    async def test_trace_from_trace_finds_outcome_and_user(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["lineage"]()
        pg = _pg_router(
            outcomes_by_trace=[{"id": "out_1"}],
            telemetry_by_trace=[{"user_id": "user_a"}],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.trace(
                "org_test", resource_type="trace",
                resource_id="trc_xyz", depth=1,
            )
        assert out["status"] == "ok"
        node_types = {n["type"] for n in out["data"]["nodes"]}
        assert "trace_id" in node_types
        assert "outcome_id" in node_types
        assert "user_id" in node_types
        assert out["data"]["edge_count"] >= 2

    @pytest.mark.asyncio
    async def test_trace_rejects_unknown_resource_type(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["lineage"]()
        out = await svc.trace(
            "org_test", resource_type="bogus", resource_id="x",
        )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_trace_rejects_blank_resource_id(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["lineage"]()
        out = await svc.trace(
            "org_test", resource_type="trace", resource_id="",
        )
        assert out["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_trace_user_finds_traces(self, gov_modules) -> None:
        svc = gov_modules["lineage"]()
        pg = _pg_router(
            telemetry_by_user=[
                {"trace_id": "trc_a"},
                {"trace_id": "trc_b"},
            ],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.trace(
                "org_test", resource_type="user",
                resource_id="user_a", depth=1,
            )
        trace_nodes = [
            n for n in out["data"]["nodes"]
            if n["type"] == "trace_id"
        ]
        assert len(trace_nodes) == 2


# ─── 6. ComplianceDashboardService ──────────────────────────────────


class TestDashboard:
    @pytest.mark.asyncio
    async def test_aggregate_rolls_up_all_surfaces(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["dashboard"]()
        pg = _pg_router(
            evidence_packs=[{
                "id": "ev_1",
                "evidence_json": json.dumps({
                    "passing": 45, "warnings": 3, "failing": 2,
                }),
                "generated_at": None,
            }],
            approvals_state_counts=[
                {"state": "pending", "count": 4},
                {"state": "approved", "count": 12},
            ],
            scan_runs=[{
                "severity": "high",
                "findings_json": json.dumps({
                    "findings": [
                        {"count": 3, "severity": "high"},
                        {"count": 1, "severity": "critical"},
                    ],
                }),
                "created_at": None,
            }],
            rtbf_audit_rollup=[{"count": 7, "last_at": None}],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.aggregate("org_test")
        d = out["data"]
        assert d["approvals"]["pending"] == 4
        assert d["scans"]["open_high"] == 3
        assert d["scans"]["open_critical"] == 1
        assert d["rtbf"]["processed"] == 7
        assert "headline" in d

    @pytest.mark.asyncio
    async def test_posture_summary_returns_one_line(
        self, gov_modules,
    ) -> None:
        svc = gov_modules["dashboard"]()
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            out = await svc.posture_summary("org_test")
        assert "summary" in out["data"]
        assert isinstance(out["data"]["summary"], str)


# ─── 7. Common helpers ──────────────────────────────────────────────


class TestCommon:
    def test_normalize_framework(self) -> None:
        from eden.services.governance_intel._common import (
            _normalize_framework,
        )
        assert _normalize_framework("soc2") == "soc2_type_ii"
        assert _normalize_framework("SOC2") == "soc2_type_ii"
        assert _normalize_framework("hipaa") == "hipaa"
        assert _normalize_framework("ISO 27001") == "iso27001"
        assert _normalize_framework("bogus") is None
        assert _normalize_framework(None) is None

    def test_parse_iso8601(self) -> None:
        from eden.services.governance_intel._common import (
            _parse_iso8601,
        )
        d1 = _parse_iso8601("2026-04-01")
        d2 = _parse_iso8601("2026-04-01T00:00:00Z")
        assert d1 is not None
        assert d2 is not None
        assert d1.year == 2026
        assert d2.tzinfo is not None
        assert _parse_iso8601("not-a-date") is None
        assert _parse_iso8601(None) is None
        assert _parse_iso8601("") is None

    def test_truncate(self) -> None:
        from eden.services.governance_intel._common import _truncate
        assert _truncate("hello", 100) == "hello"
        assert _truncate("a" * 200, 50) == "a" * 50
        assert _truncate(None, 5) == ""

    def test_redact_match(self) -> None:
        from eden.services.governance_intel._common import _redact_match
        out = _redact_match(
            "SSN is 123-45-6789 here",
            r"\d{3}-\d{2}-\d{4}",
        )
        assert "***" in out
        assert "123-45-6789" not in out


# ─── 8. Route smoke tests ───────────────────────────────────────────


@pytest.fixture(scope="module")
def gov_test_app() -> FastAPI:
    """Minimal app mounting only the governance router."""
    from eden.api.deps import get_current_user, require_org_member, require_path_org_access
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-governance-test")
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "user_test", "org_id": "org_test",
    }
    app.dependency_overrides[require_org_member] = lambda: {
        "sub": "user_test", "org_id": "org_test",
    }
    app.dependency_overrides[require_path_org_access] = lambda: "org_test"
    mod = importlib.import_module(
        "eden.api.routes.intelligence_governance"
    )
    if hasattr(mod, "_require_path_org"):
        app.dependency_overrides[mod._require_path_org] = lambda: "org_test"
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def gov_client(gov_test_app: FastAPI) -> TestClient:
    return TestClient(gov_test_app)


class TestGovernanceRoutes:
    def test_post_create_approval(self, gov_client: TestClient) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/approvals",
                json={
                    "name": "Approve prompt deploy",
                    "required_approvers": 1,
                    "ttl_seconds": 600,
                },
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "ok"
        assert body["data"]["workflow_id"].startswith("wf_")

    def test_post_request_approval(self, gov_client: TestClient) -> None:
        pg = _pg_router(
            workflows=[{
                "steps_json": json.dumps({
                    "required_approvers": 1, "ttl_seconds": 600,
                }),
                "status": "active",
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/approvals/request",
                json={
                    "workflow_id": "wf_abc",
                    "action": "deploy_prompt",
                    "target": "prompt_xyz",
                    "rationale": "v2 of system prompt",
                },
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["data"]["state"] == "pending"

    def test_post_resolve_approval(self, gov_client: TestClient) -> None:
        pg = _pg_router(
            requests=[{
                "requested_by": "other_user",
                "state": "pending",
                "payload_json": json.dumps({
                    "approvers_required": 1, "approvers": [],
                }),
            }],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/"
                "approvals/req_abc/resolve",
                json={"decision": "approve"},
            )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["state"] == "approved"

    def test_get_list_approvals(self, gov_client: TestClient) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.get(
                "/orgs/org_test/intelligence/governance/approvals"
                "?state=pending&limit=5",
            )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "ok"

    def test_post_generate_compliance_soc2(
        self, gov_client: TestClient,
    ) -> None:
        pg = _pg_router(audit_log_count=100)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/compliance/generate",
                json={
                    "framework": "soc2",
                    "period_start": "2026-04-01",
                    "period_end": "2026-06-30",
                },
            )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["framework"] == "soc2_type_ii"

    def test_legacy_compliance_soc2_route(
        self, gov_client: TestClient,
    ) -> None:
        pg = _pg_router(audit_log_count=10)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/compliance/soc2",
                json={
                    "period_start": "2026-04-01",
                    "period_end": "2026-06-30",
                },
            )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["framework"] == "soc2_type_ii"

    def test_legacy_compliance_iso27001_route(
        self, gov_client: TestClient,
    ) -> None:
        # ISO27001 evidence pack is live — generates JSON from
        # audit_log / retention / PII / subprocessors.
        pg = _pg_router(audit_log_count=10)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/compliance/iso27001",
                json={
                    "period_start": "2026-04-01",
                    "period_end": "2026-06-30",
                },
            )
        body = r.json()
        assert r.status_code == 200, r.text
        assert body["status"] == "ok"
        assert body["live"] is True
        assert body["data"]["framework"] == "iso27001"
        assert "evidence_context" in body["data"]
        assert "subprocessors" in body["data"]["evidence_context"]

    def test_get_list_packs(self, gov_client: TestClient) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.get(
                "/orgs/org_test/intelligence/governance/compliance/packs",
            )
        assert r.status_code == 200, r.text

    def test_post_security_scan(self, gov_client: TestClient) -> None:
        pg = _pg_router(telemetry_events=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/security/scan",
                json={"scope": "payload", "scanners": ["ssn"]},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["data"]["scope"] == "payload"

    def test_get_list_security_scans(
        self, gov_client: TestClient,
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.get(
                "/orgs/org_test/intelligence/governance/security/scans",
            )
        assert r.status_code == 200, r.text

    def test_post_rtbf_is_gated_off_by_default(
        self, gov_client: TestClient
    ) -> None:
        """RTBF is behind ``rtbf_fanout_v1``, which defaults to False.

        The cross-store fanout cannot currently erase per-user data from
        Typesense, Redis, Qdrant, ClickHouse or S3 — each either filters on a
        field its schema does not have or has no delete-by-user path at all.
        Serving the endpoint would hand back a compliance guarantee the system
        cannot keep, so it 404s (``require_feature_flag`` deliberately hides
        the route rather than 403-ing it).
        """
        pg = _pg_router(rtbf_table_counts={})
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/rtbf",
                json={"user_id": "user_x", "dry_run": True},
            )
        assert r.status_code == 404, r.text

    def test_post_rtbf_works_when_enabled(
        self,
        gov_client: TestClient,
        test_settings: Any,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """With the flag on, the handler still functions.

        The flag must be set on the object ``eden.api.deps.get_settings()``
        returns. ``deps.py`` binds ``get_settings`` at import time, so it keeps
        a reference to the original ``lru_cache``d function — the autouse
        ``patch_settings`` fixture only replaces ``eden.config.get_settings``.
        Verified empirically: ``test_settings`` and ``eden.config.get_settings()``
        are the *same* object, while ``deps.get_settings()`` is a *different*
        one. Patching either of the first two has no effect on any dependency
        resolved through ``deps``.
        """
        import eden.api.deps as deps

        monkeypatch.setattr(test_settings, "rtbf_fanout_v1", True, raising=False)
        monkeypatch.setattr(
            deps.get_settings(), "rtbf_fanout_v1", True, raising=False
        )

        pg = _pg_router(rtbf_table_counts={})
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/rtbf",
                json={"user_id": "user_x", "dry_run": True},
            )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["dry_run"] is True

    def test_post_lineage(self, gov_client: TestClient) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.post(
                "/orgs/org_test/intelligence/governance/lineage",
                json={
                    "resource_type": "trace",
                    "resource_id": "trc_root",
                    "depth": 1,
                },
            )
        assert r.status_code == 200, r.text

    def test_get_dashboard(self, gov_client: TestClient) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = gov_client.get(
                "/orgs/org_test/intelligence/governance/dashboard",
            )
        assert r.status_code == 200, r.text
        assert "headline" in r.json()["data"]

    @pytest.mark.asyncio
    async def test_feature_flag_off_returns_404(self) -> None:
        """When ``intelligence_gap_v0`` is off, the dependency
        raises HTTP 404 directly. Test exercises the dep — not
        an end-to-end route — to avoid the patch-singleton
        ordering quirk between :mod:`conftest`'s
        ``patch_settings`` autouse and the lru-cached production
        ``get_settings``. The dep behaviour IS the gating
        contract; the same dep gates all 13 routes.

        Marked async (``asyncio.run`` would close the
        session-scoped event loop and poison subsequent tests).
        """
        from fastapi import HTTPException

        from eden.api.deps import require_feature_flag

        # Build a stub Settings with the flag off + patch
        # ``get_settings`` in :mod:`eden.api.deps` for the
        # duration of the call. Avoids touching either the prod
        # singleton or the session-scoped test_settings.
        flag_off = type("S", (), {"intelligence_gap_v0": False})()
        with patch("eden.api.deps.get_settings", return_value=flag_off):
            dep = require_feature_flag("intelligence_gap_v0")
            with pytest.raises(HTTPException) as exc_info:
                await dep()
        assert exc_info.value.status_code == 404


# ─── 9. Backwards-compat re-exports ─────────────────────────────────


class TestBackwardsCompat:
    def test_legacy_import_path_still_works(self) -> None:
        """The old ``eden.compliance.evidence_generator`` path
        still resolves to the new implementations.
        """
        from eden.compliance.evidence_generator import (
            ApprovalWorkflowService as Legacy,
        )
        from eden.services.governance_intel import (
            ApprovalWorkflowService as Current,
        )
        assert Legacy is Current
