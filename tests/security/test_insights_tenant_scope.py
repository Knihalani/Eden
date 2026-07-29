"""Insights lookups must be tenant-scoped.

Regression lock for the 2026-07 remediation.

``InsightsService`` is a **process-global singleton** (``insights.py`` builds
one ``_insights_service`` for the whole pod) whose ``_traces``, ``_insights``
and ``_disparity_reports`` stores hold every tenant's data together. Several
lookups took only an id:

    get_trace(trace_id)
    get_insight_by_id(insight_id)
    get_disparity_report(report_id)

Their routes validated access to the *path* org and then returned whatever
matched the id — so any authenticated caller could read another organisation's
trace, insight or disparity report by guessing or leaking one identifier. The
tenant-scoped siblings (``list_traces``, ``get_insights``, ``list_datasets``)
all took ``tenant_id``, which is what made the asymmetry unambiguous.

``Insight`` carries no tenant field, so ownership is derived from
``affected_trace_ids`` against the ``_tenant_traces`` index — the same rule
``get_insights`` already used.
"""

from __future__ import annotations

import pytest

from eden.insights.insights_service import Insight, InsightsService

_VICTIM = "org-victim"
_ATTACKER = "org-attacker"


def _service() -> InsightsService:
    """A service holding one trace and one insight owned by the victim."""
    svc = InsightsService()
    svc._traces["trace-secret"] = object()  # type: ignore[assignment]
    svc._tenant_traces[_VICTIM] = ["trace-secret"]
    svc._tenant_traces[_ATTACKER] = ["trace-mine"]
    svc._insights.append(
        Insight(
            insight_id="insight-secret",
            detector="loop",
            severity="high",
            confidence=0.9,
            summary="victim only",
            affected_trace_ids=["trace-secret"],
            pattern="p",
            recommended_action="a",
        )
    )
    return svc


class TestGetTrace:
    def test_owner_can_read(self) -> None:
        assert _service().get_trace(_VICTIM, "trace-secret") is not None

    def test_other_tenant_cannot_read(self) -> None:
        assert _service().get_trace(_ATTACKER, "trace-secret") is None

    def test_unknown_tenant_cannot_read(self) -> None:
        assert _service().get_trace("org-nobody", "trace-secret") is None


class TestGetInsightById:
    def test_owner_can_read(self) -> None:
        got = _service().get_insight_by_id(_VICTIM, "insight-secret")
        assert got is not None
        assert got.insight_id == "insight-secret"

    def test_other_tenant_cannot_read(self) -> None:
        assert _service().get_insight_by_id(_ATTACKER, "insight-secret") is None

    def test_scoping_matches_the_list_endpoint(self) -> None:
        """A single lookup must not expose what the list view hides."""
        svc = _service()
        listed = {i.insight_id for i in svc.get_insights(_ATTACKER)}
        assert "insight-secret" not in listed
        assert svc.get_insight_by_id(_ATTACKER, "insight-secret") is None


class TestGetDisparityReport:
    def test_other_tenant_cannot_read(self) -> None:
        from eden.insights.comparative_analysis import DisparityReport

        svc = _service()
        svc._disparity_reports.append(
            DisparityReport(
                report_id="report-secret",
                tenant_id=_VICTIM,
                env_trace_id="e",
                prod_trace_id="p",
                generated_at="2026-07-29T00:00:00Z",
                overall_score=0.5,
            )
        )
        assert svc.get_disparity_report(_VICTIM, "report-secret") is not None
        assert svc.get_disparity_report(_ATTACKER, "report-secret") is None


def test_tenant_id_is_required_not_optional() -> None:
    """Callers must not be able to omit the tenant and get the old behaviour."""
    svc = _service()
    for call in (
        lambda: svc.get_trace("trace-secret"),  # type: ignore[call-arg]
        lambda: svc.get_insight_by_id("insight-secret"),  # type: ignore[call-arg]
        lambda: svc.get_disparity_report("report-secret"),  # type: ignore[call-arg]
    ):
        with pytest.raises(TypeError):
            call()
