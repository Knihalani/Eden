"""Portal signals must enrich relatedIssueIds / exampleTraceIds from live tables."""

from __future__ import annotations

import inspect

from eden.api.routes import portal as portal_mod


def test_portal_signal_enrich_helpers_exist() -> None:
    assert callable(portal_mod._portal_signal_def_ids)
    assert callable(portal_mod._example_trace_ids_by_portal_signal)
    assert callable(portal_mod._related_issue_ids_by_portal_signal)


def test_list_portal_signals_source_enriches_related_ids() -> None:
    src = inspect.getsource(portal_mod.list_portal_signals)
    assert "_portal_signal_def_ids" in src
    assert "_related_issue_ids_by_portal_signal" in src
    assert "_example_trace_ids_by_portal_signal" in src
    assert "relatedIssueIds=related_issues.get(sid, [])[:3]" in src
    assert "exampleTraceIds=example_traces.get(sid, [])[:3]" in src
    # Must not hardcode empty related lists anymore.
    assert "relatedIssueIds=[]," not in src
    assert "exampleTraceIds=[]," not in src
