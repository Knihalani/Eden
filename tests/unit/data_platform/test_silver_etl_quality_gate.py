"""The Silver ETL quality gate must actually gate.

Two compounding defects made ``quarantine_on_violation`` a no-op
(docs/ops/known-issues.md #2):

1. ``_validate_quality`` inserted the batch's ``silver_event_id``s into
   a temp table, then asked ``DataQualityValidator.validate_silver_events``
   to scan ``silver_events`` filtered to those ids. This runs at step 6
   of ``run_batch``, *before* the batch is written at step 7 — none of
   those ids exist in ``silver_events`` yet, so the scan always matched
   zero rows and ``report.error_count`` was always 0, independent of
   what the batch actually contained.

2. A broad ``except Exception: return events, 0`` on top of that meant
   an outright query failure was reported identically to a clean pass.

Both paths returned the *original* ``events`` list as "the events that
passed", so ``run_batch``'s ``normalized = passed`` was always a no-op:
a batch could not be quarantined no matter how invalid its contents.

``_validate_quality`` now evaluates each event directly against
``SILVER_EVENT_EXPECTATIONS`` in Python, before it is written anywhere.
"""

from __future__ import annotations

import pytest

from eden.data_platform.quality import SILVER_EVENT_EXPECTATIONS, evaluate_row
from eden.data_platform.silver_etl import SilverETLPipeline


def _valid_normalized_event(**overrides) -> dict:
    base = {
        "silver_event_id": "11111111-1111-1111-1111-111111111111",
        "bronze_event_id": "b-1",
        "org_id": "22222222-2222-2222-2222-222222222222",
        "user_id": "u-1",
        "event_type": "llm_call",
        "trace_id": "trc-1",
        "cost_usd": 0.05,
        "total_tokens": 100,
        "duration_ms": 250,
        "metadata": {},
        "timestamp": "2026-07-31T00:00:00+00:00",
    }
    base.update(overrides)
    return base


class TestEvaluateRow:
    """Pure-function checks against the expectation suite."""

    def test_valid_event_has_no_failures(self) -> None:
        failed = evaluate_row(_valid_normalized_event(), SILVER_EVENT_EXPECTATIONS)
        assert failed == []

    def test_missing_trace_id_fails(self) -> None:
        event = _valid_normalized_event(trace_id=None)
        failed = evaluate_row(event, SILVER_EVENT_EXPECTATIONS)
        assert "trace_id_not_null" in failed

    def test_missing_org_id_fails(self) -> None:
        event = _valid_normalized_event(org_id=None)
        failed = evaluate_row(event, SILVER_EVENT_EXPECTATIONS)
        assert "org_id_not_null" in failed

    def test_negative_cost_fails(self) -> None:
        event = _valid_normalized_event(cost_usd=-5.0)
        failed = evaluate_row(event, SILVER_EVENT_EXPECTATIONS)
        assert "cost_usd_non_negative" in failed

    def test_warning_severity_never_gates_by_default(self) -> None:
        """``duration_ms_sane`` and friends are severity='warning' — they
        must not appear in the default (error-only) failure list."""
        event = _valid_normalized_event(duration_ms=999_999_999)
        failed = evaluate_row(event, SILVER_EVENT_EXPECTATIONS)
        assert "duration_ms_sane" not in failed
        # But asking for warnings explicitly still finds it.
        failed_with_warnings = evaluate_row(
            event, SILVER_EVENT_EXPECTATIONS, severities=("error", "warning")
        )
        assert "duration_ms_sane" in failed_with_warnings

    def test_row_count_style_expectations_never_gate_a_single_row(self) -> None:
        """Aggregate-only expectation types must pass trivially per-row."""
        from eden.data_platform.quality import Expectation

        agg = Expectation(
            name="always_would_need_a_table_scan",
            severity="error",
            expectation_type=Expectation.EXPECT_ROW_COUNT,
            kwargs={"min_value": 10, "max_value": 20},
        )
        assert evaluate_row({}, [agg]) == []


class TestSilverETLValidateQuality:
    """Integration through ``SilverETLPipeline._validate_quality``."""

    @pytest.fixture
    def pipeline(self) -> SilverETLPipeline:
        return SilverETLPipeline()

    @pytest.mark.asyncio
    async def test_empty_batch_short_circuits(self, pipeline: SilverETLPipeline) -> None:
        passing, failing, violations = pipeline._validate_quality([])
        assert passing == []
        assert failing == []
        assert violations == 0

    @pytest.mark.asyncio
    async def test_all_valid_events_all_pass(self, pipeline: SilverETLPipeline) -> None:
        events = [_valid_normalized_event(silver_event_id=f"id-{i}") for i in range(5)]
        passing, failing, violations = pipeline._validate_quality(events)
        assert len(passing) == 5
        assert failing == []
        assert violations == 0

    @pytest.mark.asyncio
    async def test_invalid_events_are_excluded_from_passing(
        self, pipeline: SilverETLPipeline
    ) -> None:
        good = _valid_normalized_event(silver_event_id="id-good")
        bad = _valid_normalized_event(silver_event_id="id-bad", trace_id=None, org_id=None)
        passing, failing, violations = pipeline._validate_quality([good, bad])
        passing_ids = {e["silver_event_id"] for e in passing}
        assert passing_ids == {"id-good"}
        assert {e["silver_event_id"] for e in failing} == {"id-bad"}
        assert violations == 2  # trace_id_not_null + org_id_not_null

    @pytest.mark.asyncio
    async def test_does_not_touch_postgres(
        self, pipeline: SilverETLPipeline, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The old implementation required a live Postgres connection
        (temp table create/drop) to evaluate a batch that hadn't even
        been written yet. The fixed version needs none."""

        async def _boom() -> None:
            raise AssertionError("must not touch Postgres to validate a batch")

        monkeypatch.setattr(pipeline, "_get_postgres", _boom)
        bad = _valid_normalized_event(cost_usd=-1.0)
        passing, failing, violations = pipeline._validate_quality([bad])
        assert passing == []
        assert len(failing) == 1
        assert violations == 1


class TestRunBatchQuarantineOnViolation:
    """End-to-end: ``run_batch`` must actually drop failing events when
    ``quarantine_on_violation=True``, and must not when it is False."""

    @pytest.fixture
    def pipeline_with_stubbed_writes(self, monkeypatch: pytest.MonkeyPatch):
        written: dict[str, list] = {"silver": [], "quarantine": []}

        async def _write_silver(self, events):
            written["silver"].extend(events)
            return len(events)

        async def _write_quarantine(self, events):
            written["quarantine"].extend(events)
            return None

        monkeypatch.setattr(SilverETLPipeline, "_write_silver", _write_silver)
        monkeypatch.setattr(SilverETLPipeline, "_write_quarantine", _write_quarantine)
        return written

    def _raw_events(self) -> list[dict]:
        # Both events satisfy UsageEventContract (required_fields: org_id,
        # event_type, resource, quantity, unit, timestamp) so they clear
        # step 2 (contract validation) and reach step 6 (quality). "b-bad"
        # has a negative cost_usd, which the contract only type-checks
        # (int|float) but SILVER_EVENT_EXPECTATIONS' cost_usd_non_negative
        # (error severity) rejects.
        ts = "2026-07-31T00:00:00+00:00"
        return [
            {
                "id": "b-good",
                "event_type": "llm_call",
                "org_id": "22222222-2222-2222-2222-222222222222",
                "user_id": "u-1",
                "resource": "tokens",
                "quantity": 100,
                "unit": "tokens",
                "cost_usd": 0.05,
                "metadata": {"trace_id": "trc-1"},
                "created_at": ts,
                "timestamp": ts,
            },
            {
                "id": "b-bad",
                "event_type": "llm_call",
                "org_id": "22222222-2222-2222-2222-222222222222",
                "user_id": "u-2",
                "resource": "tokens",
                "quantity": 100,
                "unit": "tokens",
                "cost_usd": -5.0,
                "metadata": {"trace_id": "trc-2"},
                "created_at": ts,
                "timestamp": ts,
            },
        ]

    @pytest.mark.asyncio
    async def test_quarantine_on_violation_true_drops_bad_events(
        self, pipeline_with_stubbed_writes: dict
    ) -> None:
        pipeline = SilverETLPipeline(quarantine_on_violation=True)
        report = await pipeline.run_batch(self._raw_events())

        assert report.quality_violations > 0
        assert report.silver_inserted == 1
        assert len(pipeline_with_stubbed_writes["silver"]) == 1
        assert pipeline_with_stubbed_writes["silver"][0]["bronze_event_id"] == "b-good"
        assert len(pipeline_with_stubbed_writes["quarantine"]) == 1
        assert pipeline_with_stubbed_writes["quarantine"][0]["id"] == "b-bad"
        assert set(report.terminal_bronze_ids) == {"b-good", "b-bad"}

    @pytest.mark.asyncio
    async def test_quarantine_on_violation_false_keeps_bad_events(
        self, pipeline_with_stubbed_writes: dict
    ) -> None:
        pipeline = SilverETLPipeline(quarantine_on_violation=False)
        report = await pipeline.run_batch(self._raw_events())

        assert report.quality_violations > 0
        assert report.silver_inserted == 2
        assert len(pipeline_with_stubbed_writes["silver"]) == 2
        assert pipeline_with_stubbed_writes["quarantine"] == []
        assert set(report.terminal_bronze_ids) == {"b-good", "b-bad"}
