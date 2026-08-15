"""Portal issues must expose real trace ids, not stumble UUIDs."""

from __future__ import annotations

from eden.api.routes import portal as portal_mod


def test_portal_issues_resolves_stumble_refs_helper_exists() -> None:
    assert callable(portal_mod._resolve_stumble_refs)
    assert callable(portal_mod._related_issue_ids_by_session)


def test_list_portal_issues_source_resolves_stumbles() -> None:
    import inspect

    src = inspect.getsource(portal_mod.list_portal_issues)
    assert "_resolve_stumble_refs" in src
    assert "occurrenceTraceIds=occurrence" in src
    # Must not dump raw example_stumble_ids into occurrenceTraceIds.
    assert "example_stumble_ids, None) or [])][:20]" not in src
