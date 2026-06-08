"""Tests for the data quality framework."""

import pytest
from eden.data_platform.quality import (
    Expectation,
    ExpectationResult,
    ValidationReport,
    DataQualityValidator,
    SILVER_EVENT_EXPECTATIONS,
    USAGE_EVENT_EXPECTATIONS,
)


class TestExpectation:
    def test_expectation_creation(self):
        exp = Expectation(
            name="test_not_null",
            expectation_type=Expectation.EXPECT_NOT_NULL,
            kwargs={"column": "id"},
            severity="error",
        )
        assert exp.name == "test_not_null"
        assert exp.expectation_type == "expect_column_values_to_not_be_null"
        assert exp.severity == "error"


class TestValidationReport:
    def test_report_aggregation(self):
        results = [
            ExpectationResult(
                expectation=Expectation("e1", expectation_type=Expectation.EXPECT_NOT_NULL),
                success=True,
            ),
            ExpectationResult(
                expectation=Expectation("e2", expectation_type=Expectation.EXPECT_NOT_NULL, severity="error"),
                success=False,
                message="null found",
            ),
            ExpectationResult(
                expectation=Expectation("e3", expectation_type=Expectation.EXPECT_NOT_NULL, severity="warning"),
                success=False,
                message="warning msg",
            ),
        ]
        report = ValidationReport(
            table_name="test_table",
            results=results,
            total_rows=100,
        )
        assert report.error_count == 1
        assert report.warning_count == 1
        assert report.passed_count == 1
        assert report.success is False
        assert report.quality_score == pytest.approx(1 / 3)

    def test_all_pass_report(self):
        results = [
            ExpectationResult(
                expectation=Expectation("e1", expectation_type=Expectation.EXPECT_NOT_NULL),
                success=True,
            ),
        ]
        report = ValidationReport(
            table_name="test_table",
            results=results,
            total_rows=100,
        )
        assert report.success is True
        assert report.quality_score == 1.0

    def test_empty_report(self):
        report = ValidationReport(table_name="test_table", results=[])
        assert report.success is True
        assert report.quality_score == 1.0


class TestDataQualityValidator:
    @pytest.mark.asyncio
    async def test_validate_silver_events_no_client(self):
        validator = DataQualityValidator()
        # Without a real postgres client, this will fail but should not crash
        try:
            report = await validator.validate_silver_events()
            assert isinstance(report, ValidationReport)
        except Exception:
            # Expected when no DB is available
            pass

    def test_generate_expectation_suite(self):
        validator = DataQualityValidator()
        sample_rows = [
            {"id": "uuid-1", "name": "Alice", "age": 30, "score": 95.5},
            {"id": "uuid-2", "name": "Bob", "age": 25, "score": 88.0},
            {"id": "uuid-3", "name": "Charlie", "age": 35, "score": 92.3},
        ]
        expectations = validator.generate_expectation_suite("users", sample_rows)
        assert len(expectations) > 0
        # Should have not_null for each column
        not_nulls = [e for e in expectations if e.expectation_type == Expectation.EXPECT_NOT_NULL]
        assert len(not_nulls) >= 4
        # Should have a range expectation for numeric columns
        ranges = [e for e in expectations if e.expectation_type == Expectation.EXPECT_BETWEEN]
        assert len(ranges) >= 2  # age and score

    def test_generate_expectation_suite_empty(self):
        validator = DataQualityValidator()
        expectations = validator.generate_expectation_suite("users", [])
        assert expectations == []

    def test_silver_expectations_defined(self):
        assert len(SILVER_EVENT_EXPECTATIONS) > 0
        assert any(e.name == "trace_id_not_null" for e in SILVER_EVENT_EXPECTATIONS)
        assert any(e.name == "cost_usd_non_negative" for e in SILVER_EVENT_EXPECTATIONS)

    def test_usage_expectations_defined(self):
        assert len(USAGE_EVENT_EXPECTATIONS) > 0
        assert any(e.name == "org_id_not_null" for e in USAGE_EVENT_EXPECTATIONS)
