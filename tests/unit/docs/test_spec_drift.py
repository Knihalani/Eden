"""M4 (D20) — spec flag-table drift guard.

Invokes the core functions of ``scripts/spec_drift_check.py``: the
AUTONOMY-OVERHAUL-PLAN §1.4 table must parse, must currently match
``config.py`` defaults (the CI gate at commit time), and the checker
must actually detect a lie when fed one.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "spec_drift_check.py"


@pytest.fixture(scope="module")
def checker():
    spec = importlib.util.spec_from_file_location("spec_drift_check", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_flag_table_parses_and_covers_the_load_bearing_flags(checker) -> None:
    flags = checker.parse_spec_flag_table()
    for name in (
        "closed_loop_orchestrator_v1",
        "autonomous_actions_v0",
        "code_change_enabled",
        "auto_pr_enabled",
        "default_maintenance_mode",
        "daily_maintenance_budget_usd",
        "max_triage_cost_usd_per_day",
        # compound rows expand to one entry per full flag name
        "patch_max_per_day",
        "patch_max_generates_per_sweep",
        "patch_max_llm_calls_per_sweep",
        "verify_delay_seconds",
        "verify_quiet_window_minutes",
        "max_auto_rollbacks_per_day",
    ):
        assert name in flags, f"§1.4 table lost the {name!r} row"


def test_current_spec_matches_config_defaults(checker) -> None:
    """The commit-time invariant: zero drift between spec and config."""
    diffs = checker.check()
    assert diffs == [], (
        "AUTONOMY-OVERHAUL-PLAN.md §1.4 drifted from config.py defaults: "
        f"{diffs}"
    )


def test_checker_detects_a_lying_table(checker) -> None:
    """Feed a table that contradicts config.py → named diff."""
    lying = (
        "### 1.4 Live defaults that decide behavior (`config.py`)\n"
        "| Flag / knob | Default | Effect |\n"
        "|---|---|---|\n"
        "| `autonomous_actions_v0` | True | wrong on purpose |\n"
        "### 1.5 next section\n"
    )
    flags = checker.parse_spec_flag_table(lying)
    assert flags == {"autonomous_actions_v0": "True"}
    settings = checker.default_settings()
    assert checker._values_match("True", settings.autonomous_actions_v0) is False
    assert checker._values_match("False", settings.autonomous_actions_v0) is True


def test_checker_rejects_malformed_compound_rows(checker) -> None:
    """Flag/value count mismatch is an error, not a silent skip."""
    bad = (
        "### 1.4 Live defaults\n"
        "| Flag / knob | Default | Effect |\n"
        "|---|---|---|\n"
        "| `a_flag` / `b_flag` | 10 | mismatched |\n"
        "### 1.5\n"
    )
    with pytest.raises(ValueError, match="1 default value"):
        checker.parse_spec_flag_table(bad)
