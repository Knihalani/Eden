"""Soft Autonomy Phase 1: Issue Why/Fix must derive from real triage fields.

Triage writes ``root_cause`` + ``suggested_actions``; the portal contract
reads ``summary``/``body``/``suggestedFix``/``impact``. These tests pin the
derivation so Why/Fix can never silently go blank again.
"""

from __future__ import annotations

from types import SimpleNamespace

from eden.api.routes.portal import _triage_fix_text, _triage_impact_text


def test_fix_text_prefers_direct_suggested_fix() -> None:
    triage = {"suggested_fix": "Bump the retry budget"}
    assert _triage_fix_text(triage) == "Bump the retry budget"


def test_fix_text_derives_from_suggested_actions() -> None:
    triage = {
        "suggested_actions": [
            {"type": "propose_patch", "summary": "Patch checkout loop guard"},
            {"type": "escalate", "summary": "Escalate if patch fails"},
        ]
    }
    out = _triage_fix_text(triage)
    assert "Patch checkout loop guard" in out
    assert "Escalate if patch fails" in out


def test_fix_text_empty_when_no_actions() -> None:
    assert _triage_fix_text({}) == ""
    assert _triage_fix_text({"suggested_actions": []}) == ""
    assert _triage_fix_text({"suggested_actions": "not-a-list"}) == ""


def test_fix_text_skips_non_dict_and_blank() -> None:
    triage = {"suggested_actions": [{"summary": ""}, "junk", {"summary": "Real fix"}]}
    assert _triage_fix_text(triage) == "Real fix"


def test_impact_text_prefers_direct() -> None:
    issue = SimpleNamespace(stumble_count=5, severity="P1")
    assert _triage_impact_text(issue, {"impact": "12 users affected"}) == "12 users affected"


def test_impact_text_derives_from_count_and_severity() -> None:
    issue = SimpleNamespace(stumble_count=47, severity="P0")
    out = _triage_impact_text(issue, {})
    assert "P0" in out
    assert "47" in out


def test_impact_text_empty_when_nothing_known() -> None:
    issue = SimpleNamespace(stumble_count=0, severity="")
    assert _triage_impact_text(issue, {}) == ""


def test_list_portal_issues_maps_root_cause_to_summary() -> None:
    """The mapping must read root_cause into summary/body (source check)."""
    import inspect

    from eden.api.routes import portal as portal_mod

    src = inspect.getsource(portal_mod.list_portal_issues)
    assert "root_cause" in src
    assert "_triage_fix_text" in src
    assert "_triage_impact_text" in src
