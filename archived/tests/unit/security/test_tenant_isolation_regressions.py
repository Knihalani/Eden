"""Tenant-isolation and fail-closed regressions found 2026-07-29.

Four defects, all reachable in production, none of which had a test:

  1. datasets/hub._trace_payload queried telemetry_events by trace_id
     alone. The route authorises the caller's org and then passes
     body.trace_id through unvalidated, so org A could read org B's
     prompt text.
  2. data_platform /etl/run resolved org_id and never passed it, so an
     org admin ran ETL over every tenant's usage_events.
  3. github callback matched an attacker-controlled `state` with LIKE,
     where % and _ are wildcards — ?state=%25 matched every pending org.
  4. approval.resolve returned state="approved" whenever the database
     was unreachable, skipping existence, pending, self-approval and
     quorum checks.
"""

from __future__ import annotations

import inspect
import re

import pytest


class TestTracePromotionIsTenantScoped:
    def test_trace_payload_query_filters_by_tenant(self):
        from eden.datasets.hub import DatasetHub

        src = inspect.getsource(DatasetHub._trace_payload)
        assert "tenant_id" in src, (
            "the telemetry_events read must be scoped by tenant, or one org "
            "can promote another org's trace into its own dataset"
        )

    def test_trace_payload_takes_an_org(self):
        from eden.datasets.hub import DatasetHub

        params = list(
            inspect.signature(DatasetHub._trace_payload).parameters
        )
        assert "org_id" in params, "org_id must be threaded down to the query"

    def test_promote_trace_passes_its_org_down(self):
        from eden.datasets.hub import DatasetHub

        src = inspect.getsource(DatasetHub.promote_trace)
        assert "_trace_payload(org_id" in src, (
            "promote_trace has org_id in scope; it must pass it on"
        )


class TestEtlIsTenantScoped:
    def test_run_from_bronze_accepts_an_org(self):
        from eden.data_platform.silver_etl import SilverETLPipeline

        params = inspect.signature(SilverETLPipeline.run_from_bronze).parameters
        assert "org_id" in params

    def test_bronze_query_can_filter_by_org(self):
        from eden.data_platform.silver_etl import SilverETLPipeline

        src = inspect.getsource(SilverETLPipeline.run_from_bronze)
        assert "org_id = $" in src, "the Bronze read must be org-filterable"

    def test_route_passes_org_id(self):
        from eden.api.routes import data_platform

        src = inspect.getsource(data_platform.run_etl)
        assert "org_id=org_id" in src, (
            "/etl/run authorises against a path org and must scope the run "
            "to it, not sweep every tenant"
        )


class TestGithubCallbackStateMatching:
    def test_no_like_wildcard_matching_on_state(self):
        from eden.api.routes import github

        src = inspect.getsource(github)
        assert 'LIKE $1' not in src or 'oauth_state' not in src.split('LIKE $1')[0][-400:], (
            "state is attacker-controlled on an unauthenticated endpoint; "
            "LIKE makes % and _ wildcards, so ?state=% matched every org"
        )
        assert "strpos(" in src, "expected a literal substring match"

    def test_ambiguous_state_is_refused_not_guessed(self):
        from eden.api.routes import github

        src = inspect.getsource(github)
        assert "len(rows) == 1" in src, (
            "a state matching multiple orgs must be refused, not resolved "
            "to rows[0]"
        )

    def test_state_shape_is_validated(self):
        from eden.api.routes.github import _SAFE_STATE_RE

        # secrets.token_urlsafe alphabet
        assert _SAFE_STATE_RE.fullmatch("abcDEF123_-" + "x" * 10)
        # wildcards and quotes must be refused before reaching a query
        for bad in ("%", "_", "%25", "' OR 1=1 --", '"', "a" * 200, "short"):
            assert not _SAFE_STATE_RE.fullmatch(bad), f"{bad!r} should be refused"


class TestApprovalFailsClosed:
    def test_no_db_branch_refuses(self):
        """Source check, with comments stripped.

        The first version of this test matched the string "approved"
        anywhere after the no-DB branch and failed on the explanatory
        COMMENT describing the bug — a good reminder that asserting on
        source text is brittle. The behavioural test below is the real
        guarantee; this one only catches an obvious reintroduction.
        """
        from eden.services.governance_intel.approval import (
            ApprovalWorkflowService,
        )

        src = inspect.getsource(ApprovalWorkflowService.resolve)
        head = src.split("client = await _get_client()")[1][:1400]
        code = "\n".join(
            line for line in head.splitlines()
            if not line.strip().startswith("#")
        )
        assert re.search(r'"state"\s*:\s*\(?\s*"approved"', code) is None, (
            "with no database the gate must refuse, not synthesise an "
            "approval — it cannot check existence, pending state, "
            "self-approval or quorum"
        )

    @pytest.mark.asyncio
    async def test_resolve_without_db_is_not_ok(self, monkeypatch):
        from eden.services.governance_intel import approval as mod

        async def _no_client():
            return None

        monkeypatch.setattr(mod, "_get_client", _no_client)
        svc = mod.ApprovalWorkflowService()
        out = await svc.resolve(
            "org-attacker",
            request_id="does-not-exist",
            decision="approve",
            approver="attacker@example.com",
        )
        assert out.get("status") != "ok", (
            f"approval resolved without a database: {out}"
        )
        assert (out.get("data") or {}).get("state") != "approved"
