"""The SQL-vs-DDL guard must catch the bug class it was built for.

Eden's largest defect class is SQL naming a column no migration created,
swallowed by ``except Exception: logger.debug(...)``. The query raises every
time, the handler returns ``[]``, and the feature looks quiet rather than
broken. It silently disabled the metering chain, trace replay, Live Tail, the
reasoning endpoint, every EQL query and four intelligence subsystems.

These tests pin two properties:

* the reconstructed schema is **accurate** — a model missing real columns would
  produce false positives, and a guard that cries wolf gets switched off;
* the guard **detects the known instances** — if it cannot find the bugs we
  already know about, it is not finished.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "src"))

from eden.db_migrations.schema_model import build  # noqa: E402

_BASELINE = _REPO / "tests" / "migrations" / "sql_schema_guard_baseline.json"
_GUARD = _REPO / "scripts" / "sql_schema_guard.py"


@pytest.fixture(scope="module")
def model():
    return build()


class TestSchemaModelAccuracy:
    def test_models_a_plausible_number_of_tables(self, model) -> None:
        assert len(model.tables) > 150, (
            f"only {len(model.tables)} tables modelled — the migration parser "
            "is dropping DDL, which produces false positives"
        )

    def test_skip_rate_stays_low(self, model) -> None:
        """A guard that silently skips most of its input is theatre."""
        total = model.parsed + model.skipped
        assert total > 0
        assert model.skipped / total < 0.25, (
            f"skip rate {model.skipped / total:.1%} is too high; the parser is "
            "ignoring DDL it should understand"
        )

    def test_telemetry_events_is_fully_modelled(self, model) -> None:
        """The busiest table must not be opaque, or the guard is blind on it."""
        assert model.has_table("telemetry_events")
        assert "telemetry_events" not in model.opaque
        cols = model.columns("telemetry_events")
        # Sample of columns that genuinely exist — a regression here means the
        # model lost DDL and will start reporting real columns as missing.
        for real in (
            "tenant_id", "error_type", "project_id", "realm", "timestamp",
            "request_body", "response_body", "payload", "cache_hit", "model",
        ):
            assert real in cols, f"real column {real!r} missing from the model"

    def test_op_api_migrations_are_parsed(self, model) -> None:
        """Four migrations use the alembic op API rather than raw SQL.

        Missing them dropped real columns (``users.password_changed_at``).
        """
        assert "password_changed_at" in model.columns("users")

    def test_dynamic_add_column_loops_are_expanded(self, model) -> None:
        """Migration 011 adds columns from a literal list in a for-loop."""
        cols = model.columns("telemetry_events")
        for c in ("reasoning", "tool_calls_full", "tool_results", "images"):
            assert c in cols, f"{c!r} came from a for-loop and was not expanded"


class TestKnownPhantomColumns:
    """The acceptance criterion: it must find the bugs we already know about."""

    @pytest.mark.parametrize(
        ("table", "column"),
        [
            ("telemetry_events", "org_id"),
            ("telemetry_events", "error"),
            ("telemetry_events", "correlation_id"),
            ("telemetry_events", "id"),
            ("trace_reasoning_reports", "faithfulness"),
            ("trace_reasoning_reports", "lanham_score"),
            ("jobs", "quality_score"),
            ("organizations", "features"),
        ],
    )
    def test_phantom_column_is_not_known(self, model, table: str, column: str) -> None:
        assert model.has_table(table), f"{table} is not modelled at all"
        assert not model.knows(table, column), (
            f"the guard believes {table}.{column} exists; it does not, and "
            "this is one of the bugs the guard exists to catch"
        )

    def test_real_column_is_known(self, model) -> None:
        """The inverse, so the test above cannot pass by modelling nothing."""
        assert model.knows("telemetry_events", "tenant_id")
        assert model.knows("telemetry_events", "error_type")
        assert model.knows("trace_reasoning_reports", "coherence")


class TestGuardCli:
    def test_baseline_exists_and_is_parseable(self) -> None:
        data = json.loads(_BASELINE.read_text())
        assert "violations" in data
        assert isinstance(data["violations"], list)

    def test_no_new_violations(self) -> None:
        """The ratchet. New unknown-column SQL fails here."""
        result = subprocess.run(
            [sys.executable, str(_GUARD)],
            capture_output=True,
            text=True,
            cwd=_REPO,
        )
        assert result.returncode == 0, (
            "new SQL references a column no migration creates:\n"
            f"{result.stdout}\n{result.stderr}"
        )

    @pytest.mark.xfail(
        strict=False,
        reason="burn-down in progress; flip to a hard assert when it reaches []",
    )
    def test_baseline_is_empty(self) -> None:
        """The finish line for the column-mismatch burn-down."""
        data = json.loads(_BASELINE.read_text())
        assert data["violations"] == []

    def test_guard_detects_the_dsl_org_id_bug(self) -> None:
        """Spot-check a specific known instance survives in the baseline."""
        data = json.loads(_BASELINE.read_text())
        keys = {(v["table"], v["column"]) for v in data["violations"]}
        assert ("telemetry_events", "org_id") in keys, (
            "the EQL compiler's org_id bug is no longer detected — either it "
            "was fixed (remove it from the baseline) or the guard regressed"
        )
