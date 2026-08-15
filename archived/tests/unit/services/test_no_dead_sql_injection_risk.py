"""Source-level assertions guarding against reintroduction of dead code
with latent SQL-injection risk.

Background
----------
``eden.services.user_intel.satisfaction`` historically contained a
private helper ``_fetch_per_channel_prior`` that interpolated a
caller-supplied ``interval_sql: str`` straight into a Postgres query
via an f-string. The function was never called anywhere in the
codebase, so it was dead code — but if a future caller passed user
input it would have been a textbook SQL-injection bug.

We removed the function (see FIXES_LOG F49). This test asserts the
removal stays in place so nobody re-introduces it on a copy-paste.
"""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SATISFACTION = REPO_ROOT / "src" / "eden" / "services" / "user_intel" / "satisfaction.py"


def test_satisfaction_source_does_not_contain_dead_per_channel_prior() -> None:
    """The dead ``_fetch_per_channel_prior`` helper must stay gone."""
    src = SATISFACTION.read_text(encoding="utf-8")
    assert "_fetch_per_channel_prior" not in src, (
        "Dead code with latent SQL-injection risk was re-introduced "
        "in eden.services.user_intel.satisfaction. See FIXES_LOG F49."
    )


def test_satisfaction_source_does_not_interpolate_interval_sql() -> None:
    """Guard against any future f-string ``{...}::interval`` interpolation."""
    src = SATISFACTION.read_text(encoding="utf-8")
    assert "interval_sql" not in src, (
        "Found a reference to `interval_sql` in "
        "eden.services.user_intel.satisfaction. This parameter is "
        "historically used for raw SQL interpolation — re-add it "
        "with parameterised SQL only."
    )
    # Belt-and-braces: no f-string with the ``interval`` cast should
    # remain anywhere in the file.
    assert "::interval" not in src or "f" not in src.split("::interval")[0].split("\n")[-1], (
        "Suspicious `::interval` cast near an f-string in "
        "eden.services.user_intel.satisfaction."
    )
