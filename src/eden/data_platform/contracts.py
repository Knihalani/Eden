"""Data contracts — upstream schema validation for Bronze-layer events.

Every upstream service that emits events to the Bronze layer defines a contract.
The Silver ETL validates incoming events against these contracts and quarantines
violations for review.

Usage:
    from eden.data_platform.contracts import AgentTraceContract, ContractValidator
    validator = ContractValidator()
    result = validator.validate(event, AgentTraceContract)
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class FieldContract:
    """Contract for a single field in an event."""

    name: str
    required: bool = True
    field_type: type = str
    max_length: int | None = None
    max_size_bytes: int | None = None
    pattern: str | None = None  # regex pattern for string validation
    allowed_values: list[Any] | None = None
    default: Any = None


@dataclass
class EventContract:
    """Contract defining the schema for an event type."""

    event_type: str
    version: str = "1.0"
    required_fields: list[str] = field(default_factory=list)
    field_types: dict[str, type] = field(default_factory=dict)
    field_contracts: list[FieldContract] = field(default_factory=list)
    valid_event_types: list[str] = field(default_factory=list)
    max_payload_size_bytes: int = 10_000_000  # 10 MB
    max_nested_depth: int = 10

    def __post_init__(self) -> None:
        if not self.field_contracts and self.field_types:
            # Auto-generate FieldContracts from field_types
            self.field_contracts = [
                FieldContract(name=k, required=k in self.required_fields, field_type=v)
                for k, v in self.field_types.items()
            ]


class AgentTraceContract(EventContract):
    """Contract for agent trace events."""

    def __init__(self) -> None:
        super().__init__(
            event_type="agent_trace",
            version="1.0",
            required_fields=[
                "trace_id",
                "org_id",
                "job_id",
                "event_type",
                "timestamp",
                "payload",
            ],
            field_types={
                "trace_id": str,
                "org_id": str,
                "job_id": str,
                "event_type": str,
                "timestamp": str,
                "payload": dict,
                "duration_ms": int,
                "input_tokens": int,
                "output_tokens": int,
            },
            valid_event_types=[
                "agent.start",
                "agent.think",
                "agent.act",
                "agent.tool_call",
                "agent.tool_result",
                "agent.complete",
                "agent.error",
                "agent.pause",
                "agent.resume",
            ],
            max_payload_size_bytes=10_000_000,
        )


class UsageEventContract(EventContract):
    """Contract for usage metering events."""

    def __init__(self) -> None:
        super().__init__(
            event_type="usage_event",
            version="1.0",
            required_fields=[
                "org_id",
                "event_type",
                "resource",
                "quantity",
                "unit",
                "timestamp",
            ],
            field_types={
                "org_id": str,
                "user_id": str,
                "event_type": str,
                "resource": str,
                "quantity": (int, float),
                "unit": str,
                "model": str,
                "cost_usd": (int, float),
                "metadata": dict,
                "correlation_id": str,
                "timestamp": str,
            },
            valid_event_types=[
                "llm_call",
                "job_start",
                "job_complete",
                "job_cancel",
                "storage",
                "sandbox",
                "api_request",
                "benchmark_run",
            ],
            max_payload_size_bytes=1_000_000,
        )


class PipelineEventContract(EventContract):
    """Contract for pipeline stage events."""

    def __init__(self) -> None:
        super().__init__(
            event_type="pipeline_event",
            version="1.0",
            required_fields=[
                "job_id",
                "org_id",
                "stage",
                "status",
                "timestamp",
            ],
            field_types={
                "job_id": str,
                "org_id": str,
                "stage": str,
                "status": str,
                "duration_ms": int,
                "error_message": str,
                "metadata": dict,
                "timestamp": str,
            },
            valid_event_types=[
                "pipeline.stage_start",
                "pipeline.stage_complete",
                "pipeline.stage_error",
                "pipeline.job_start",
                "pipeline.job_complete",
                "pipeline.job_failed",
            ],
            max_payload_size_bytes=5_000_000,
        )


class BenchmarkEventContract(EventContract):
    """Contract for benchmark execution events."""

    def __init__(self) -> None:
        super().__init__(
            event_type="benchmark_event",
            version="1.0",
            required_fields=[
                "benchmark_id",
                "org_id",
                "event_type",
                "timestamp",
            ],
            field_types={
                "benchmark_id": str,
                "org_id": str,
                "job_id": str,
                "event_type": str,
                "score": (int, float),
                "passed": bool,
                "duration_ms": int,
                "metadata": dict,
                "timestamp": str,
            },
            valid_event_types=[
                "benchmark.start",
                "benchmark.run_complete",
                "benchmark.suite_complete",
                "benchmark.failed",
            ],
            max_payload_size_bytes=5_000_000,
        )


# Registry of all known contracts
CONTRACT_REGISTRY: dict[str, EventContract] = {
    "agent_trace": AgentTraceContract(),
    "usage_event": UsageEventContract(),
    "pipeline_event": PipelineEventContract(),
    "benchmark_event": BenchmarkEventContract(),
}


@dataclass
class ValidationResult:
    """Result of a contract validation."""

    valid: bool
    event_type: str
    violations: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    quarantine: bool = False


class ContractValidator:
    """Validates events against registered data contracts."""

    def __init__(self, contracts: dict[str, EventContract] | None = None) -> None:
        self.contracts = contracts or CONTRACT_REGISTRY

    def validate(self, event: dict[str, Any], contract: EventContract | str) -> ValidationResult:
        """Validate a single event against a contract.

        Args:
            event: The event dict to validate.
            contract: Either an EventContract instance or a registered event type string.

        Returns:
            ValidationResult with violations, warnings, and quarantine flag.
        """
        if isinstance(contract, str):
            contract = self.contracts.get(contract)
            if not contract:
                return ValidationResult(
                    valid=False,
                    event_type=contract if isinstance(contract, str) else "unknown",
                    violations=[f"No contract registered for event type: {contract}"],
                    quarantine=True,
                )

        violations: list[str] = []
        warnings: list[str] = []

        # Check payload size
        payload_json = json.dumps(event, default=str)
        payload_size = len(payload_json.encode("utf-8"))
        if payload_size > contract.max_payload_size_bytes:
            violations.append(
                f"Payload size {payload_size} bytes exceeds maximum "
                f"{contract.max_payload_size_bytes} bytes"
            )

        # Check required fields
        for field_name in contract.required_fields:
            if field_name not in event or event[field_name] is None:
                violations.append(f"Missing required field: {field_name}")

        # Check field types
        for field_name, expected_type in contract.field_types.items():
            if field_name in event and event[field_name] is not None:
                value = event[field_name]
                if isinstance(expected_type, tuple):
                    if not isinstance(value, expected_type):
                        violations.append(
                            f"Field '{field_name}' expected type {expected_type}, "
                            f"got {type(value).__name__}"
                        )
                elif not isinstance(value, expected_type):
                    violations.append(
                        f"Field '{field_name}' expected type {expected_type.__name__}, "
                        f"got {type(value).__name__}"
                    )

        # Check event_type value against allowed values
        if contract.valid_event_types and "event_type" in event:
            event_type_value = event["event_type"]
            if event_type_value not in contract.valid_event_types:
                warnings.append(
                    f"Event type '{event_type_value}' not in allowed list: "
                    f"{contract.valid_event_types}"
                )

        # Check field-level contracts
        for fc in contract.field_contracts:
            if fc.name in event and event[fc.name] is not None:
                value = event[fc.name]
                if fc.max_length and isinstance(value, str) and len(value) > fc.max_length:
                    violations.append(
                        f"Field '{fc.name}' exceeds max length {fc.max_length}"
                    )
                if fc.max_size_bytes and isinstance(value, str):
                    if len(value.encode("utf-8")) > fc.max_size_bytes:
                        violations.append(
                            f"Field '{fc.name}' exceeds max size {fc.max_size_bytes} bytes"
                        )
                if fc.pattern and isinstance(value, str):
                    import re
                    if not re.match(fc.pattern, value):
                        violations.append(
                            f"Field '{fc.name}' does not match pattern: {fc.pattern}"
                        )
                if fc.allowed_values is not None and value not in fc.allowed_values:
                    violations.append(
                        f"Field '{fc.name}' value '{value}' not in allowed values"
                    )

        # Quarantine if any violations exist
        quarantine = len(violations) > 0

        return ValidationResult(
            valid=not violations,
            event_type=contract.event_type,
            violations=violations,
            warnings=warnings,
            quarantine=quarantine,
        )

    def validate_batch(
        self,
        events: list[dict[str, Any]],
        contract: EventContract | str,
    ) -> list[ValidationResult]:
        """Validate a batch of events against a contract."""
        return [self.validate(event, contract) for event in events]
