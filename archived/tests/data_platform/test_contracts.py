"""Tests for the data contracts module."""

import pytest

from eden.data_platform.contracts import (
    AgentTraceContract,
    BenchmarkEventContract,
    ContractValidator,
    PipelineEventContract,
    UsageEventContract,
    ValidationResult,
)


class TestContractValidator:
    def test_valid_agent_trace(self):
        validator = ContractValidator()
        event = {
            "trace_id": "t1",
            "org_id": "o1",
            "job_id": "j1",
            "event_type": "agent.start",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {"thought": "thinking"},
        }
        result = validator.validate(event, "agent_trace")
        assert isinstance(result, ValidationResult)
        assert result.valid is True
        assert result.quarantine is False

    def test_missing_required_field(self):
        validator = ContractValidator()
        event = {
            "trace_id": "t1",
            "org_id": "o1",
            "event_type": "agent.start",
            "timestamp": "2024-01-01T00:00:00Z",
            # missing job_id, payload
        }
        result = validator.validate(event, "agent_trace")
        assert result.valid is False
        assert result.quarantine is True
        assert any("job_id" in v for v in result.violations)
        assert any("payload" in v for v in result.violations)

    def test_unknown_event_type(self):
        validator = ContractValidator()
        event = {
            "trace_id": "t1",
            "org_id": "o1",
            "job_id": "j1",
            "event_type": "agent.unknown",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {},
        }
        result = validator.validate(event, "agent_trace")
        assert result.valid is True  # warning only, not violation
        assert len(result.warnings) > 0

    def test_payload_size_exceeded(self):
        validator = ContractValidator()
        contract = AgentTraceContract()
        contract.max_payload_size_bytes = 10
        event = {
            "trace_id": "t1",
            "org_id": "o1",
            "job_id": "j1",
            "event_type": "agent.start",
            "timestamp": "2024-01-01T00:00:00Z",
            "payload": {"data": "x" * 100},
        }
        result = validator.validate(event, contract)
        assert result.valid is False
        assert result.quarantine is True

    def test_usage_event_valid(self):
        validator = ContractValidator()
        event = {
            "org_id": "o1",
            "event_type": "llm_call",
            "resource": "tokens",
            "quantity": 1500,
            "unit": "tokens",
            "timestamp": "2024-01-01T00:00:00Z",
        }
        result = validator.validate(event, "usage_event")
        assert result.valid is True

    def test_usage_event_invalid_quantity_type(self):
        validator = ContractValidator()
        event = {
            "org_id": "o1",
            "event_type": "llm_call",
            "resource": "tokens",
            "quantity": "not_a_number",
            "unit": "tokens",
            "timestamp": "2024-01-01T00:00:00Z",
        }
        result = validator.validate(event, "usage_event")
        assert result.valid is False
        assert any("quantity" in v for v in result.violations)

    def test_pipeline_event_valid(self):
        validator = ContractValidator()
        event = {
            "job_id": "j1",
            "org_id": "o1",
            "stage": "planning",
            "status": "complete",
            "timestamp": "2024-01-01T00:00:00Z",
        }
        result = validator.validate(event, "pipeline_event")
        assert result.valid is True

    def test_benchmark_event_valid(self):
        validator = ContractValidator()
        event = {
            "benchmark_id": "b1",
            "org_id": "o1",
            "event_type": "benchmark.start",
            "timestamp": "2024-01-01T00:00:00Z",
        }
        result = validator.validate(event, "benchmark_event")
        assert result.valid is True

    def test_unregistered_contract(self):
        validator = ContractValidator()
        result = validator.validate({}, "unknown_contract")
        assert result.valid is False
        assert result.quarantine is True

    def test_batch_validation(self):
        validator = ContractValidator()
        events = [
            {
                "org_id": "o1",
                "event_type": "llm_call",
                "resource": "tokens",
                "quantity": 100,
                "unit": "tokens",
                "timestamp": "2024-01-01T00:00:00Z",
            },
            {
                "org_id": "o1",
                "event_type": "llm_call",
                "resource": "tokens",
                "quantity": 200,
                "unit": "tokens",
                "timestamp": "2024-01-01T00:00:00Z",
            },
        ]
        results = validator.validate_batch(events, "usage_event")
        assert len(results) == 2
        assert all(r.valid for r in results)
