"""FEAT-102: nl_alert_rules severity persistence and read-back."""

from __future__ import annotations

from eden.alerts import repo


def test_rule_row_includes_severity() -> None:
    row = {
        "id": "rule-1",
        "org_id": "org-1",
        "name": "Outage",
        "nl_text": "alert on outage",
        "compiled_eql": "SELECT 1",
        "triage_enabled": True,
        "channels": {"email": True},
        "enabled": True,
        "severity": "critical",
        "created_by": "user-1",
        "last_fired_at": None,
        "created_at": None,
        "updated_at": None,
    }
    out = repo._rule_row(row)
    assert out["severity"] == "critical"


def test_rule_row_defaults_missing_severity_to_warning() -> None:
    row = {
        "id": "rule-1",
        "org_id": "org-1",
        "name": "Legacy",
        "nl_text": "old",
        "compiled_eql": "SELECT 1",
        "triage_enabled": True,
        "channels": {},
        "enabled": True,
        "created_by": None,
        "last_fired_at": None,
        "created_at": None,
        "updated_at": None,
    }
    out = repo._rule_row(row)
    assert out["severity"] == "warning"


def test_normalize_nl_rule_severity_maps_portal_aliases() -> None:
    assert repo._normalize_nl_rule_severity("warn") == "warning"
    assert repo._normalize_nl_rule_severity("error") == "high"
    assert repo._normalize_nl_rule_severity("critical") == "critical"
    assert repo._normalize_nl_rule_severity("info") == "info"
