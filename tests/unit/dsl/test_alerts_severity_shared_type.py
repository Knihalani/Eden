"""FEAT-44: dsl.alerts's severity sets now derive from the shared
AlertSeverity enum (eden.alerting.types, re-exporting
eden.realtime.alert_stream.AlertSeverity) instead of a hand-duplicated
frozenset of string literals. Confirms the migration didn't change any
runtime membership behavior.
"""

from __future__ import annotations

from eden.alerting.types import AlertSeverity
from eden.dsl.alerts import _FIREABLE_SEVERITIES, _VALID_SEVERITIES


def test_valid_severities_match_alert_severity_minus_debug() -> None:
    assert set(_VALID_SEVERITIES) == {
        AlertSeverity.INFO,
        AlertSeverity.WARNING,
        AlertSeverity.HIGH,
        AlertSeverity.CRITICAL,
    }
    assert AlertSeverity.DEBUG not in _VALID_SEVERITIES


def test_valid_severities_still_compare_equal_to_plain_strings() -> None:
    # AlertSeverity is a StrEnum — plain-string membership checks used
    # throughout dsl/alerts.py (`severity not in _VALID_SEVERITIES`)
    # must keep working unchanged after the migration.
    for s in ("info", "warning", "high", "critical"):
        assert s in _VALID_SEVERITIES
    assert "debug" not in _VALID_SEVERITIES
    assert "bogus" not in _VALID_SEVERITIES


def test_fireable_severities_excludes_critical_per_v13_design() -> None:
    # Documented, deliberate v1.3 behavior (see _evaluate_rule) — not
    # something this migration should change.
    assert "critical" not in _FIREABLE_SEVERITIES
    assert set(_FIREABLE_SEVERITIES) == {"info", "warning", "high"}
