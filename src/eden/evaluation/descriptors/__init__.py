"""Layer A — deterministic agent-trajectory descriptors.

Pure-Python graders over structured trace fields (tool calls, args,
results, outcomes). No LLM. Designed to run on every finalized trace.
"""

from __future__ import annotations

from eden.evaluation.descriptors.engine import (
    DescriptorEngine,
    DescriptorResult,
    TraceDescriptorReport,
    describe_trace,
)
from eden.evaluation.descriptors.taxonomy import DESCRIPTOR_IDS, DescriptorId

__all__ = [
    "DESCRIPTOR_IDS",
    "DescriptorEngine",
    "DescriptorId",
    "DescriptorResult",
    "TraceDescriptorReport",
    "describe_trace",
]
