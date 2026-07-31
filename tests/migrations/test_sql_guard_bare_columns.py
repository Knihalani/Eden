"""The guard must check bare columns, and must not cry wolf doing it.

The original guard inspected only *qualified* ``alias.column`` references. Its
docstring claimed single-table statements were covered too; they were not. That
gap mattered more than the covered case, because a single-table query has no
reason to alias anything -- so the guard reported **0 violations across all of
src/** while 106 bare-column references to nonexistent columns were live,
including an ``INSERT INTO users (..., email_verified)`` that makes every
email/password signup return 503.

Precision is the whole ballgame here. The guard runs in a blocking pre-commit
hook, so one false positive gets it switched off and then it protects nothing.
These tests pin both directions: the shapes it must flag, and -- at greater
length -- the shapes it must leave alone. Every "must not flag" case below is a
real query from this repo that an earlier draft reported.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO / "src"))

_spec = importlib.util.spec_from_file_location(
    "_sql_guard", _REPO / "scripts" / "sql_schema_guard.py"
)
assert _spec and _spec.loader
_guard = importlib.util.module_from_spec(_spec)
# ``@dataclass`` resolves annotations through ``sys.modules[cls.__module__]``,
# so the module has to be registered before the body executes.
sys.modules["_sql_guard"] = _guard
_spec.loader.exec_module(_guard)

bare_columns = _guard._bare_columns


class TestPositionsThatAreDefinitelyColumns:
    def test_insert_column_list(self) -> None:
        got = bare_columns(
            "INSERT INTO users (email, password_hash, name, email_verified) "
            "VALUES ($1, $2, $3, FALSE) RETURNING id"
        )
        assert {"email", "password_hash", "name", "email_verified"} <= got

    def test_update_assignment_targets(self) -> None:
        got = bare_columns(
            "UPDATE jobs SET current_stage = $1, updated_at = NOW() WHERE id = $2"
        )
        assert {"current_stage", "updated_at"} <= got

    def test_update_target_with_a_function_call_containing_commas(self) -> None:
        got = bare_columns(
            "UPDATE t SET a = COALESCE($1, b, c), d = 1 WHERE id = $2"
        )
        assert "a" in got and "d" in got

    def test_where_comparison_left_hand_sides(self) -> None:
        got = bare_columns(
            "SELECT 1 FROM judge_scores WHERE org_id = $1 AND agent_id = $2 "
            "AND created_at >= $3"
        )
        assert {"org_id", "agent_id", "created_at"} <= got

    def test_order_and_group_by_items(self) -> None:
        got = bare_columns(
            "SELECT event_type FROM telemetry_events "
            "GROUP BY event_type ORDER BY start_time DESC"
        )
        assert "start_time" in got

    def test_plain_select_list_items(self) -> None:
        got = bare_columns(
            "SELECT trace_id, realm, span_count, duration_ms FROM telemetry_events"
        )
        assert {"trace_id", "span_count", "duration_ms"} <= got

    def test_single_argument_aggregates(self) -> None:
        """``AVG(latency_ms)`` is how one live defect is actually spelled."""
        got = bare_columns("SELECT AVG(latency_ms) FROM telemetry_events")
        assert "latency_ms" in got

    def test_is_null_comparison(self) -> None:
        got = bare_columns("SELECT 1 FROM t WHERE error_type IS NOT NULL")
        assert "error_type" in got


class TestShapesItMustNotFlag:
    """Each of these was a false positive in an earlier draft."""

    def test_output_alias_referenced_in_distinct_on(self) -> None:
        """The real query from change_impact/preview.py."""
        got = bare_columns(
            "SELECT DISTINCT ON (bucket) trace_id FROM ("
            "  SELECT trace_id, (CASE WHEN outcome IS DISTINCT FROM 'success' "
            "  THEN 0 ELSE 2 END) AS bucket, timestamp FROM telemetry_events"
            ") s ORDER BY bucket"
        )
        assert "bucket" not in got

    def test_output_alias_shadowing_a_real_column(self) -> None:
        got = bare_columns(
            "SELECT SUM(cost_usd) AS cost_usd, DATE_TRUNC('day', ts) AS day "
            "FROM usage_events GROUP BY day"
        )
        assert "day" not in got
        assert "cost_usd" not in got

    def test_type_names_in_casts(self) -> None:
        got = bare_columns(
            "SELECT (attributes->>'n')::numeric FROM t WHERE id = $1::uuid"
        )
        assert not {"numeric", "uuid"} & got

    def test_keywords_are_not_columns(self) -> None:
        got = bare_columns(
            "SELECT a FROM t WHERE b IS NULL AND c IN ($1) "
            "ORDER BY d DESC NULLS LAST LIMIT 10 OFFSET 5"
        )
        assert not {"null", "desc", "nulls", "last", "limit", "offset"} & got

    def test_extract_field_names_are_not_columns(self) -> None:
        got = bare_columns("SELECT EXTRACT(epoch FROM created_at) FROM t")
        assert "epoch" not in got

    def test_function_names_are_not_columns(self) -> None:
        got = bare_columns("SELECT COALESCE(a, b), NOW() FROM t WHERE c = $1")
        assert not {"coalesce", "now"} & got

    def test_string_literal_contents_are_not_columns(self) -> None:
        got = bare_columns("SELECT a FROM t WHERE b = 'order by user_id'")
        assert "user_id" not in got

    def test_numeric_order_by_positions(self) -> None:
        got = bare_columns("SELECT a, count(*) FROM t GROUP BY 1 ORDER BY 2 DESC")
        assert not {"1", "2"} & got

    def test_on_conflict_excluded_pseudo_table(self) -> None:
        """``EXCLUDED.x`` is qualified against a pseudo-relation, not a table."""
        got = bare_columns(
            "INSERT INTO t (a, b) VALUES ($1, $2) "
            "ON CONFLICT (a) DO UPDATE SET b = EXCLUDED.b"
        )
        assert "excluded" not in got


class TestStatementLevelSkips:
    """Ambiguity must skip the statement, not guess."""

    @staticmethod
    def _check(sql: str) -> list:
        from eden.db_migrations.schema_model import build

        return _guard._check_statement(build(), "x", sql, "f.py", 1)

    def test_join_skips_bare_columns(self) -> None:
        """Two relations means a bare column could belong to either."""
        found = self._check(
            "SELECT nonexistent_col FROM telemetry_events t "
            "JOIN judge_scores j ON t.trace_id = j.trace_id"
        )
        assert [v.column for v in found] == []

    def test_subquery_skips_bare_columns(self) -> None:
        found = self._check(
            "SELECT nonexistent_col FROM (SELECT 1 AS nonexistent_col) s"
        )
        assert [v.column for v in found] == []

    def test_derived_table_skips_bare_columns(self) -> None:
        found = self._check(
            "SELECT nonexistent_col FROM ( SELECT * FROM telemetry_events ) x"
        )
        assert [v.column for v in found] == []

    def test_interpolated_identifier_skips_the_statement(self) -> None:
        found = self._check("SELECT nonexistent_col FROM {}")
        assert found == []

    def test_single_table_is_checked(self) -> None:
        """Guards the premise: the happy path really does report."""
        found = self._check(
            "SELECT definitely_not_a_column FROM telemetry_events WHERE tenant_id = $1"
        )
        assert [(v.table, v.column) for v in found] == [
            ("telemetry_events", "definitely_not_a_column")
        ]


class TestKnownDefectsAreDetected:
    """If the guard cannot find the bugs we know about, it is not working."""

    @staticmethod
    def _columns_for(sql: str) -> set[str]:
        from eden.db_migrations.schema_model import build

        return {
            v.column
            for v in _guard._check_statement(build(), "x", sql, "f.py", 1)
        }

    @pytest.mark.parametrize(
        ("sql", "column"),
        [
            # ``users.email_verified`` was the headline find here — signup
            # returned 503 on every attempt — but migration 124 added the
            # column, so it is no longer a violation and cannot be asserted as
            # one. A synthetic name keeps the INSERT-column-list position
            # covered without depending on a defect staying unfixed.
            (
                "INSERT INTO users (email, password_hash, not_a_real_column) "
                "VALUES ($1,$2,$3)",
                "not_a_real_column",
            ),
            (
                "SELECT trace_id, span_count FROM telemetry_events "
                "WHERE tenant_id = $1",
                "span_count",
            ),
            (
                "SELECT org_id FROM judge_scores WHERE org_id = $1",
                "org_id",
            ),
            (
                "SELECT id, start_time FROM telemetry_events WHERE tenant_id = $1",
                "start_time",
            ),
        ],
    )
    def test_detects(self, sql: str, column: str) -> None:
        assert column in self._columns_for(sql)
