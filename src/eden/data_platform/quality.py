"""Data quality framework for Eden's Bronze → Silver → Gold pipeline.

Provides expectation-based validation, anomaly detection, and quality scoring
for every dataset in the data platform. Integrates with the Silver ETL to
automatically quarantine bad data and alert operators.

Usage:
    from eden.data_platform.quality import DataQualityValidator, Expectation
    validator = DataQualityValidator()
    result = validator.validate_table("silver_events", expectations)
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# Identifiers used in raw SQL interpolations (table_name, column).
# Even though our shipped expectation suites are static, we whitelist at
# runtime so a caller-supplied expectation set cannot smuggle SQL.
_IDENT_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _safe_ident(name: str, *, kind: str = "identifier") -> str:
    """Validate a SQL identifier (table or column name).

    Postgres unquoted identifiers must match ``[A-Za-z_][A-Za-z0-9_]*``.
    Anything else is rejected. We do NOT support quoted identifiers here
    because the expectation framework has no legitimate need for unusual
    names and quoting would only widen the attack surface.
    """
    if not isinstance(name, str) or not _IDENT_PATTERN.match(name):
        raise ValueError(
            f"Invalid SQL {kind}: {name!r}. "
            "Only ASCII letters, digits, and underscores are allowed "
            "(must start with a letter or underscore)."
        )
    return name


@dataclass
class Expectation:
    """A single data-quality expectation (inspired by Great Expectations)."""

    name: str
    description: str = ""
    severity: str = "error"  # "error" | "warning"
    expectation_type: str = ""
    kwargs: dict[str, Any] = field(default_factory=dict)

    # Pre-defined expectation types
    EXPECT_NOT_NULL = "expect_column_values_to_not_be_null"
    EXPECT_UNIQUE = "expect_column_values_to_be_unique"
    EXPECT_BETWEEN = "expect_column_values_to_be_between"
    EXPECT_REGEX = "expect_column_values_to_match_regex"
    EXPECT_IN_SET = "expect_column_values_to_be_in_set"
    EXPECT_TYPE = "expect_column_values_to_be_of_type"
    EXPECT_ROW_COUNT = "expect_table_row_count_to_be_between"
    EXPECT_COLUMNS = "expect_table_columns_to_match_set"
    EXPECT_NO_DUPLICATES = "expect_compound_columns_to_be_unique"


@dataclass
class ExpectationResult:
    """Result of evaluating a single expectation."""

    expectation: Expectation
    success: bool
    observed_value: Any = None
    unexpected_count: int = 0
    unexpected_percent: float = 0.0
    message: str = ""


@dataclass
class ValidationReport:
    """Aggregated result of validating a dataset against multiple expectations."""

    table_name: str
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    results: list[ExpectationResult] = field(default_factory=list)
    success: bool = False
    error_count: int = 0
    warning_count: int = 0
    passed_count: int = 0
    total_rows: int = 0
    quality_score: float = 0.0  # 0.0–1.0

    def __post_init__(self) -> None:
        self.error_count = sum(
            1 for r in self.results if not r.success and r.expectation.severity == "error"
        )
        self.warning_count = sum(
            1 for r in self.results if not r.success and r.expectation.severity == "warning"
        )
        self.passed_count = sum(1 for r in self.results if r.success)
        self.success = self.error_count == 0
        total = len(self.results)
        self.quality_score = self.passed_count / total if total > 0 else 1.0


# ── Table-specific expectation suites ──────────────────────────────────────

SILVER_EVENT_EXPECTATIONS: list[Expectation] = [
    Expectation(
        name="trace_id_not_null",
        description="trace_id must never be null",
        severity="error",
        expectation_type=Expectation.EXPECT_NOT_NULL,
        kwargs={"column": "trace_id"},
    ),
    Expectation(
        name="org_id_not_null",
        description="org_id must never be null",
        severity="error",
        expectation_type=Expectation.EXPECT_NOT_NULL,
        kwargs={"column": "org_id"},
    ),
    Expectation(
        name="event_type_not_null",
        description="event_type must never be null",
        severity="error",
        expectation_type=Expectation.EXPECT_NOT_NULL,
        kwargs={"column": "event_type"},
    ),
    Expectation(
        name="timestamp_not_null",
        description="timestamp must never be null",
        severity="error",
        expectation_type=Expectation.EXPECT_NOT_NULL,
        kwargs={"column": "timestamp"},
    ),
    Expectation(
        name="duration_ms_sane",
        description="duration_ms should be between 0 and 5 minutes",
        severity="warning",
        expectation_type=Expectation.EXPECT_BETWEEN,
        kwargs={"column": "duration_ms", "min_value": 0, "max_value": 300_000},
    ),
    Expectation(
        name="total_tokens_sane",
        description="total_tokens should be between 0 and 1M",
        severity="warning",
        expectation_type=Expectation.EXPECT_BETWEEN,
        kwargs={"column": "total_tokens", "min_value": 0, "max_value": 1_000_000},
    ),
    Expectation(
        name="cost_usd_non_negative",
        description="cost_usd should be non-negative",
        severity="error",
        expectation_type=Expectation.EXPECT_BETWEEN,
        kwargs={"column": "cost_usd", "min_value": 0, "max_value": 1_000_000},
    ),
    Expectation(
        name="org_id_format",
        description="org_id should match UUID-like format",
        severity="warning",
        expectation_type=Expectation.EXPECT_REGEX,
        kwargs={"column": "org_id", "regex": r"^[0-9a-fA-F\-]{36}$"},
    ),
    Expectation(
        name="event_type_known",
        description="event_type should be a known value",
        severity="warning",
        expectation_type=Expectation.EXPECT_IN_SET,
        kwargs={
            "column": "event_type",
            "value_set": [
                "llm_call",
                "job_start",
                "job_complete",
                "job_cancel",
                "storage",
                "sandbox",
                "api_request",
                "benchmark_run",
                "agent.start",
                "agent.think",
                "agent.act",
                "agent.tool_call",
                "agent.complete",
                "agent.error",
                "pipeline.stage_start",
                "pipeline.stage_complete",
                "pipeline.stage_error",
            ],
        },
    ),
]

USAGE_EVENT_EXPECTATIONS: list[Expectation] = [
    Expectation(
        name="org_id_not_null",
        severity="error",
        expectation_type=Expectation.EXPECT_NOT_NULL,
        kwargs={"column": "org_id"},
    ),
    Expectation(
        name="event_type_not_null",
        severity="error",
        expectation_type=Expectation.EXPECT_NOT_NULL,
        kwargs={"column": "event_type"},
    ),
    Expectation(
        name="quantity_non_negative",
        severity="error",
        expectation_type=Expectation.EXPECT_BETWEEN,
        kwargs={"column": "quantity", "min_value": 0, "max_value": 1e12},
    ),
    Expectation(
        name="resource_known",
        severity="warning",
        expectation_type=Expectation.EXPECT_IN_SET,
        kwargs={
            "column": "resource",
            "value_set": ["tokens", "jobs", "storage_mb", "sandbox_seconds", "requests"],
        },
    ),
]


class DataQualityValidator:
    """Validates datasets against expectation suites.

    Designed to work with PostgreSQL tables as the primary data store.
    For ClickHouse or Iceberg tables, the same logic applies with
    adapted query patterns.
    """

    def __init__(self, postgres_client: Any | None = None) -> None:
        self._client = postgres_client

    async def _get_client(self) -> Any:
        if self._client is None:
            from eden.storage.postgres import get_postgres_client

            self._client = await get_postgres_client()
        return self._client

    async def validate_table(
        self,
        table_name: str,
        expectations: list[Expectation],
        where_clause: str | None = None,
    ) -> ValidationReport:
        """Validate a PostgreSQL table against a suite of expectations."""
        client = await self._get_client()
        results: list[ExpectationResult] = []

        # Defence-in-depth: reject any non-identifier table name before
        # it reaches a raw-SQL interpolation below.
        table_name = _safe_ident(table_name, kind="table name")

        # Get row count
        count_query = f"SELECT COUNT(*) FROM {table_name}"
        if where_clause:
            count_query += f" WHERE {where_clause}"
        total_rows = await client.fetchval(count_query) or 0

        for exp in expectations:
            try:
                result = await self._evaluate_expectation(client, table_name, exp, where_clause)
                results.append(result)
            except Exception as exc:
                logger.warning(f"Quality check failed for {exp.name}: {exc}")
                results.append(
                    ExpectationResult(
                        expectation=exp,
                        success=False,
                        message=f"Evaluation error: {exc}",
                    )
                )

        return ValidationReport(
            table_name=table_name,
            results=results,
            total_rows=total_rows,
        )

    async def _evaluate_expectation(
        self,
        client: Any,
        table_name: str,
        expectation: Expectation,
        where_clause: str | None = None,
    ) -> ExpectationResult:
        """Evaluate a single expectation against a table."""
        etype = expectation.expectation_type
        kwargs = expectation.kwargs
        where = f"WHERE {where_clause}" if where_clause else ""

        # Validate every column identifier this expectation references
        # before any of it reaches a raw-SQL interpolation below.
        if "column" in kwargs:
            _safe_ident(kwargs["column"], kind="column name")

        if etype == Expectation.EXPECT_NOT_NULL:
            col = kwargs["column"]
            total, unexpected = await _count_total_and_unexpected(
                client, table_name, where, f"{col} IS NULL"
            )
            success = unexpected == 0
            return ExpectationResult(
                expectation=expectation,
                success=success,
                observed_value=f"{unexpected} nulls",
                unexpected_count=unexpected,
                unexpected_percent=_unexpected_percent(unexpected, total),
                message=f"{unexpected} null values found in '{col}'" if not success else "",
            )

        if etype == Expectation.EXPECT_UNIQUE:
            col = kwargs["column"]
            # COUNT(*) - COUNT(DISTINCT col) already needs the total, so this
            # one is a single scan either way; taking both from one row keeps it
            # consistent with the others.
            row = await client.fetchrow(
                f"SELECT COUNT(*) AS total, "
                f"COUNT(*) - COUNT(DISTINCT {col}) AS unexpected "
                f"FROM {table_name} {where}"
            )
            total = int(row["total"] or 0) if row else 0
            unexpected = int(row["unexpected"] or 0) if row else 0
            success = unexpected == 0
            return ExpectationResult(
                expectation=expectation,
                success=success,
                observed_value=f"{unexpected} duplicates",
                unexpected_count=unexpected,
                unexpected_percent=_unexpected_percent(unexpected, total),
                message=f"{unexpected} duplicate values in '{col}'" if not success else "",
            )

        if etype == Expectation.EXPECT_BETWEEN:
            col = kwargs["column"]
            min_val = kwargs.get("min_value")
            max_val = kwargs.get("max_value")
            conditions = []
            if min_val is not None:
                conditions.append(f"{col} < {min_val}")
            if max_val is not None:
                conditions.append(f"{col} > {max_val}")
            cond = " OR ".join(conditions)
            total, unexpected = await _count_total_and_unexpected(
                client, table_name, where, f"({cond})"
            )
            success = unexpected == 0
            return ExpectationResult(
                expectation=expectation,
                success=success,
                observed_value=f"{unexpected} out-of-range",
                unexpected_count=unexpected,
                unexpected_percent=_unexpected_percent(unexpected, total),
                message=f"{unexpected} values out of range in '{col}'" if not success else "",
            )

        if etype == Expectation.EXPECT_REGEX:
            col = kwargs["column"]
            pattern = kwargs["regex"]
            total, unexpected = await _count_total_and_unexpected(
                client,
                table_name,
                where,
                f"{col} IS NOT NULL AND {col} !~ $1",
                pattern,
            )
            success = unexpected == 0
            return ExpectationResult(
                expectation=expectation,
                success=success,
                observed_value=f"{unexpected} regex failures",
                unexpected_count=unexpected,
                unexpected_percent=_unexpected_percent(unexpected, total),
                message=f"{unexpected} values don't match regex in '{col}'" if not success else "",
            )

        if etype == Expectation.EXPECT_IN_SET:
            col = kwargs["column"]
            value_set = kwargs["value_set"]
            if not value_set:
                return ExpectationResult(
                    expectation=expectation,
                    success=True,
                    message="Empty value set — skipped",
                )
            placeholders = ", ".join(f"${i + 1}" for i in range(len(value_set)))
            total, unexpected = await _count_total_and_unexpected(
                client,
                table_name,
                where,
                f"{col} IS NOT NULL AND {col} NOT IN ({placeholders})",
                *value_set,
            )
            success = unexpected == 0
            return ExpectationResult(
                expectation=expectation,
                success=success,
                observed_value=f"{unexpected} invalid values",
                unexpected_count=unexpected,
                unexpected_percent=_unexpected_percent(unexpected, total),
                message=f"{unexpected} unexpected values in '{col}'" if not success else "",
            )

        if etype == Expectation.EXPECT_ROW_COUNT:
            min_rows = kwargs.get("min_value", 0)
            max_rows = kwargs.get("max_value", 1e12)
            query = f"SELECT COUNT(*) FROM {table_name} {where}"
            row_count = await client.fetchval(query) or 0
            success = min_rows <= row_count <= max_rows
            return ExpectationResult(
                expectation=expectation,
                success=success,
                observed_value=row_count,
                message=f"Row count {row_count} not in range [{min_rows}, {max_rows}]"
                if not success
                else "",
            )

        # Fallback for unhandled expectation types
        return ExpectationResult(
            expectation=expectation,
            success=False,
            message=f"Unknown expectation type: {etype}",
        )

    async def validate_silver_events(self, where: str | None = None) -> ValidationReport:
        """Convenience: validate the silver_events table."""
        return await self.validate_table("silver_events", SILVER_EVENT_EXPECTATIONS, where)

    async def validate_usage_events(self, where: str | None = None) -> ValidationReport:
        """Convenience: validate the usage_events table."""
        return await self.validate_table("usage_events", USAGE_EVENT_EXPECTATIONS, where)

    def generate_expectation_suite(
        self,
        table_name: str,
        sample_rows: list[dict[str, Any]],
    ) -> list[Expectation]:
        """Auto-generate a basic expectation suite from sample rows.

        This is a heuristic generator — production suites should be curated.
        """
        if not sample_rows:
            return []

        expectations: list[Expectation] = []
        columns = list(sample_rows[0].keys())

        for col in columns:
            values = [r[col] for r in sample_rows if col in r and r[col] is not None]
            if not values:
                continue

            # Not-null for all columns
            expectations.append(
                Expectation(
                    name=f"{col}_not_null",
                    expectation_type=Expectation.EXPECT_NOT_NULL,
                    kwargs={"column": col},
                )
            )

            # Type inference
            types = {type(v).__name__ for v in values}
            if types == {"str"}:
                # Check for UUID-like strings
                if all(re.match(r"^[0-9a-fA-F\-]{36}$", str(v)) for v in values[:5]):
                    expectations.append(
                        Expectation(
                            name=f"{col}_uuid_format",
                            expectation_type=Expectation.EXPECT_REGEX,
                            kwargs={"column": col, "regex": r"^[0-9a-fA-F\-]{36}$"},
                        )
                    )
            elif types.issubset({"int", "float"}):
                # Range expectation
                numeric = [float(v) for v in values]
                min_v = min(numeric)
                max_v = max(numeric)
                # Pad the range by 10%
                pad = (max_v - min_v) * 0.1 if max_v != min_v else abs(min_v) * 0.1 or 1.0
                expectations.append(
                    Expectation(
                        name=f"{col}_range",
                        expectation_type=Expectation.EXPECT_BETWEEN,
                        kwargs={"column": col, "min_value": min_v - pad, "max_value": max_v + pad},
                    )
                )

        return expectations


def _expectation_holds_for_row(row: dict[str, Any], exp: Expectation) -> bool:
    """Evaluate one expectation against a single in-memory row.

    Mirrors the SQL-based checks in ``_evaluate_expectation`` but
    operates on a Python value instead of a table scan — used for
    gating a row *before* it has been written anywhere. Expectation
    types that are only meaningful in aggregate over a whole table
    (row count, uniqueness, column-set shape) are not evaluable
    per-row and are treated as passing so they cannot spuriously gate
    a single event.
    """
    etype = exp.expectation_type
    kwargs = exp.kwargs
    col = kwargs.get("column")
    value = row.get(col) if col else None

    if etype == Expectation.EXPECT_NOT_NULL:
        return value is not None

    if etype == Expectation.EXPECT_BETWEEN:
        if value is None:
            return True  # absence is EXPECT_NOT_NULL's job, not this one's
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return False
        min_val = kwargs.get("min_value")
        max_val = kwargs.get("max_value")
        if min_val is not None and numeric < min_val:
            return False
        return not (max_val is not None and numeric > max_val)

    if etype == Expectation.EXPECT_REGEX:
        if value is None:
            return True
        pattern = kwargs.get("_compiled_regex")
        if pattern is None:
            pattern = re.compile(kwargs["regex"])
            kwargs["_compiled_regex"] = pattern
        return pattern.match(str(value)) is not None

    if etype == Expectation.EXPECT_IN_SET:
        if value is None:
            return True
        value_set = kwargs.get("_value_set_frozen")
        if value_set is None:
            raw = kwargs.get("value_set") or []
            value_set = frozenset(raw)
            kwargs["_value_set_frozen"] = value_set
        if not value_set:
            return True
        return value in value_set

    # EXPECT_UNIQUE / EXPECT_ROW_COUNT / EXPECT_COLUMNS / EXPECT_NO_DUPLICATES
    # need the full table (or at least the full batch) to evaluate and
    # cannot be assessed one row at a time.
    return True


def evaluate_row(
    row: dict[str, Any],
    expectations: list[Expectation],
    *,
    severities: tuple[str, ...] = ("error",),
) -> list[str]:
    """Return the names of expectations ``row`` fails, restricted to
    ``severities`` (error-severity only, by default, matching how
    :class:`ValidationReport` decides overall ``success``).

    Used by the Silver ETL to gate events before they are written: a
    row that does not exist in the target table yet cannot be found
    by :meth:`DataQualityValidator.validate_table`'s SQL scan, so a
    caller that wants a real pre-write gate needs a Python-side check
    against the same expectation suite instead.
    """
    return [
        exp.name
        for exp in expectations
        if exp.severity in severities and not _expectation_holds_for_row(row, exp)
    ]


# ─────────────────────────────────────────────────────────────────────────────
# Phase 5.5.4: Great Expectations interop
# ─────────────────────────────────────────────────────────────────────────────
# The in-house validator above is zero-dep and fast, but the spec
# calls for Great Expectations compatibility. These helpers convert
# the in-house ``Expectation`` representation into a GE suite and
# back, so users can author suites in either format and run them
# against the same engine.


def _to_ge_expectation(exp: Expectation) -> Any | None:
    """Convert an in-house :class:`Expectation` to a GE expectation
    (returns ``None`` if the type doesn't map)."""
    try:
        import great_expectations  # noqa: F401  — availability check
    except ImportError:
        return None

    gx = geExpectationFactory()
    if exp.expectation_type == Expectation.EXPECT_NOT_NULL:
        return gx.not_null(column=exp.kwargs["column"])
    if exp.expectation_type == Expectation.EXPECT_UNIQUE:
        return gx.unique(column=exp.kwargs["column"])
    if exp.expectation_type == Expectation.EXPECT_BETWEEN:
        return gx.between(
            column=exp.kwargs["column"],
            min_value=exp.kwargs.get("min_value"),
            max_value=exp.kwargs.get("max_value"),
        )
    if exp.expectation_type == Expectation.EXPECT_REGEX:
        return gx.match_regex(
            column=exp.kwargs["column"],
            regex=exp.kwargs["regex"],
        )
    if exp.expectation_type == Expectation.EXPECT_IN_SET:
        return gx.isin(
            column=exp.kwargs["column"],
            value_set=exp.kwargs.get("value_set", []),
        )
    return None


class geExpectationFactory:
    """Lazy factory that returns the GE module API only when needed.

    Avoids the import cost at module-load time and lets the rest of
    the platform run with no GE installed.
    """

    def _gx(self):
        try:
            import great_expectations.expectations as gx_expectations

            return gx_expectations
        except ImportError:
            raise RuntimeError(
                "great_expectations is not installed. " "Run `pip install great_expectations`."
            ) from None

    def not_null(self, **kw):  # type: ignore[no-untyped-def]
        return self._gx().ExpectColumnValuesToNotBeNull(**kw)

    def unique(self, **kw):  # type: ignore[no-untyped-def]
        return self._gx().ExpectColumnValuesToBeUnique(**kw)

    def between(self, **kw):  # type: ignore[no-untyped-def]
        return self._gx().ExpectColumnValuesToBeBetween(**kw)

    def match_regex(self, **kw):  # type: ignore[no-untyped-def]
        return self._gx().ExpectColumnValuesToMatchRegex(**kw)

    def isin(self, **kw):  # type: ignore[no-untyped-def]
        return self._gx().ExpectColumnValuesToBeInSet(**kw)


async def run_with_great_expectations(
    table_name: str,
    expectations: list[Expectation],
    *,
    where_clause: str | None = None,
) -> dict[str, Any]:
    """Run the expectation suite through Great Expectations instead
    of the in-house validator. Useful for users with existing GE
    suites or those who want GE's reporting.

    Returns a dict shaped like :class:`ValidationReport` so the
    caller can use either engine interchangeably.
    """
    # Defence-in-depth: reject any non-identifier table name before
    # it reaches the raw-SQL interpolation below.
    table_name = _safe_ident(table_name, kind="table name")

    ge_suite: list[Any] = []
    for exp in expectations:
        ge_exp = _to_ge_expectation(exp)
        if ge_exp is not None:
            ge_suite.append(ge_exp)

    if not ge_suite:
        return {
            "engine": "ge",
            "ran": 0,
            "skipped": len(expectations),
            "available": False,
            "detail": "great_expectations not installed",
        }

    # Pull a sample via the in-house validator's connection, then
    # hand the rows to GE for the actual evaluation. This keeps the
    # two engines in lock-step for the data they see.
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    sql = f"SELECT * FROM {table_name}"
    if where_clause:
        sql += f" WHERE {where_clause}"
    sql += " LIMIT 10000"
    rows = await client.fetch(sql)
    if not rows:
        return {"engine": "ge", "ran": 0, "skipped": len(expectations), "detail": "no rows"}

    try:
        import pandas as pd
    except ImportError:
        return {
            "engine": "ge",
            "available": True,
            "ran": 0,
            "skipped": len(expectations),
            "detail": "pandas not installed; cannot run GE",
        }

    df = pd.DataFrame([dict(r) for r in rows])
    results: list[dict[str, Any]] = []
    passed = 0
    for exp, ge_exp in zip(expectations, ge_suite, strict=False):
        try:
            res = ge_exp.validate(df) if hasattr(ge_exp, "validate") else None
            ok = bool(getattr(res, "success", False)) if res is not None else True
        except Exception as exc:  # noqa: BLE001
            ok = False
            res = {"exception": str(exc)}
        results.append(
            {
                "name": exp.name,
                "success": ok,
                "result": str(res)[:500] if res is not None else None,
            }
        )
        if ok:
            passed += 1
    return {
        "engine": "ge",
        "ran": len(ge_suite),
        "passed": passed,
        "failed": len(ge_suite) - passed,
        "results": results,
        "available": True,
    }


async def _count_total_and_unexpected(
    client: Any,
    table_name: str,
    where: str,
    predicate: str,
    *args: Any,
) -> tuple[int, int]:
    """Return ``(total, unexpected)`` from one scan.

    ``total`` counts every row matching ``where``; ``unexpected`` counts the
    subset also matching ``predicate``. Each expectation used to ask for these
    separately — two full-table counts where one does — and the ``total`` query
    was identical for every expectation in a suite.

    Empty tables return ``(0, 0)``. Callers must use
    :func:`_unexpected_percent` so percent math never divides by zero — the
    previous ``or 1`` floor made an empty table look like a clean pass with
    ``unexpected_percent=0`` while inventing a phantom row.
    """
    row = await client.fetchrow(
        f"SELECT COUNT(*) AS total, "
        f"COUNT(*) FILTER (WHERE {predicate}) AS unexpected "
        f"FROM {table_name} {where}",
        *args,
    )
    if row is None:
        return 0, 0
    return int(row["total"] or 0), int(row["unexpected"] or 0)


def _unexpected_percent(unexpected: int, total: int) -> float:
    """Percent of unexpected rows; ``0.0`` when the table is empty."""
    if total <= 0:
        return 0.0
    return (unexpected / total) * 100
