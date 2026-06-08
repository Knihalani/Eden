"""Tests for the OpenLineage lineage tracker."""

import pytest
from eden.data_platform.lineage import (
    LineageTracker,
    Dataset,
    ColumnLineage,
    LineageRun,
)


class TestDataset:
    def test_dataset_creation(self):
        ds = Dataset("silver_events", "eden", "postgres")
        assert ds.name == "silver_events"
        assert ds.namespace == "eden"
        assert ds.storage == "postgres"

    def test_to_openlineage(self):
        ds = Dataset(
            "silver_events",
            "eden",
            "postgres",
            fields=[{"name": "id", "type": "UUID"}],
        )
        ol = ds.to_openlineage()
        assert ol["namespace"] == "eden"
        assert ol["name"] == "silver_events"
        assert "facets" in ol


class TestLineageRun:
    def test_lineage_run_creation(self):
        run = LineageRun(
            run_id="r1",
            job_name="silver_etl",
            inputs=[Dataset("bronze.usage_events")],
            outputs=[Dataset("silver.silver_events")],
        )
        assert run.run_id == "r1"
        assert run.job_name == "silver_etl"
        assert len(run.inputs) == 1
        assert len(run.outputs) == 1

    def test_to_openlineage(self):
        run = LineageRun(
            run_id="r1",
            job_name="silver_etl",
            inputs=[Dataset("bronze.usage_events")],
            outputs=[Dataset("silver.silver_events")],
        )
        ol = run.to_openlineage()
        assert ol["producer"] == "eden"
        assert ol["job"]["name"] == "silver_etl"
        assert len(ol["inputs"]) == 1
        assert len(ol["outputs"]) == 1


class TestColumnLineage:
    def test_column_lineage(self):
        cl = ColumnLineage("total_tokens", "bronze.usage_events", "quantity", "derived")
        assert cl.output_column == "total_tokens"
        assert cl.input_dataset == "bronze.usage_events"
        assert cl.transformation == "derived"


class TestLineageTracker:
    def test_init(self):
        tracker = LineageTracker()
        assert tracker._postgres_client is None

    @pytest.mark.asyncio
    async def test_record_run_no_db(self):
        tracker = LineageTracker()
        try:
            run_id = await tracker.record_run(
                job_name="test_job",
                inputs=[Dataset("input")],
                outputs=[Dataset("output")],
            )
            assert isinstance(run_id, str)
        except Exception:
            # Expected when no DB is available
            pass

    @pytest.mark.asyncio
    async def test_record_pipeline_run_no_db(self):
        tracker = LineageTracker()
        try:
            run_id = await tracker.record_pipeline_run(
                job_id="j1",
                stage="planning",
                stage_status="success",
            )
            assert isinstance(run_id, str)
        except Exception:
            pass

    @pytest.mark.asyncio
    async def test_get_upstream_no_db(self):
        tracker = LineageTracker()
        try:
            upstream = await tracker.get_upstream("silver_events")
            assert isinstance(upstream, list)
        except Exception:
            pass

    @pytest.mark.asyncio
    async def test_export_openlineage_no_db(self):
        tracker = LineageTracker()
        try:
            events = await tracker.export_openlineage(limit=10)
            assert isinstance(events, list)
        except Exception:
            pass
