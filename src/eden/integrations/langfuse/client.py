"""Langfuse integration — client and dataset/trace helpers.

Langfuse is an open-source LLM observability platform. Eden
integrates by:

  1. **Datasets** — exporting Eden envs as Langfuse datasets so
     customers can score runs in Langfuse's UI.
  2. **Traces** — pushing Eden LLM traces into Langfuse so the
     customer has a single pane of glass for all their LLM
     observability.

Integration surface
-------------------

* :class:`LangfuseClient` — minimal client wrapper (lazy import
  of the Langfuse SDK so this is a no-op when the SDK is not
  installed).
* :func:`eden_env_to_langfuse_dataset` — converter.
* :func:`trace_to_langfuse_event` — converter.
* ``/integrations/langfuse/*`` routes mounted in
  :mod:`eden.api.routes.integrations_langfuse`.

Versioning
----------

All outbound calls and inbound webhooks include the
``X-Eden-Integration-Version`` header. See
:mod:`eden.integrations` for the policy.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from eden.integrations import INTEGRATION_API_VERSION

logger = logging.getLogger(__name__)


# Langfuse's dataset item shape, per the v2 SDK. We construct the
# dicts directly so the integration is testable without the SDK.
LANFUSE_DATASET_ITEM_KEY = "eden_env_id"


@dataclass(frozen=True)
class LangfuseDatasetItem:
    """A single item in a Langfuse dataset, derived from an Eden env."""

    eden_env_id: str
    input: dict[str, Any]
    expected_output: dict[str, Any]
    metadata: dict[str, Any]

    def to_langfuse(self) -> dict[str, Any]:
        return {
            "input": self.input,
            "expected_output": self.expected_output,
            "metadata": {**self.metadata, "eden_integration_version": INTEGRATION_API_VERSION},
        }


@dataclass(frozen=True)
class LangfuseTraceEvent:
    """A single Langfuse-ready trace event derived from an Eden trace."""

    trace_id: str
    name: str
    input: dict[str, Any]
    output: dict[str, Any]
    metadata: dict[str, Any]
    start_time: str | None
    end_time: str | None

    def to_langfuse(self) -> dict[str, Any]:
        return {
            "id": self.trace_id,
            "name": self.name,
            "input": self.input,
            "output": self.output,
            "metadata": {**self.metadata, "eden_integration_version": INTEGRATION_API_VERSION},
            "startTime": self.start_time,
            "endTime": self.end_time,
        }


def eden_env_to_langfuse_dataset(env: Mapping[str, Any]) -> LangfuseDatasetItem:
    """Convert an Eden env record into a Langfuse dataset item."""
    env_id = str(env.get("id") or env.get("env_id") or "")
    return LangfuseDatasetItem(
        eden_env_id=env_id,
        input={
            "description": env.get("description", ""),
            "tags": list(env.get("tags") or []),
        },
        expected_output={
            "spec": env.get("spec", {}),
            "outcome_tier": env.get("outcome_tier"),
        },
        metadata={
            "eden_env_id": env_id,
            "category": env.get("category"),
            "quality_score": env.get("quality_score"),
        },
    )


def trace_to_langfuse_event(trace: Mapping[str, Any]) -> LangfuseTraceEvent:
    """Convert an Eden trace to a Langfuse trace event."""
    trace_id = str(trace.get("id") or trace.get("trace_id") or "")
    return LangfuseTraceEvent(
        trace_id=trace_id or hashlib.sha256(str(trace).encode()).hexdigest()[:32],
        name=str(trace.get("name") or "eden.trace"),
        input=trace.get("input") or {},
        output=trace.get("output") or {},
        metadata=trace.get("metadata") or {},
        start_time=trace.get("start_time"),
        end_time=trace.get("end_time"),
    )


class LangfuseClient:
    """Minimal Langfuse client.

    Like :class:`eden.integrations.wandb.WeaveClient`, this is a
    no-op-when-disabled wrapper. Real fan-out would call
    ``langfuse.trace(...)`` / ``langfuse.flush()``; here we
    return the would-be wire payloads so tests can verify the
    mapping without depending on the SDK.
    """

    def __init__(self, *, public_key: str = "", secret_key: str = "", host: str = "https://cloud.langfuse.com", enabled: bool = False):
        self.public_key = public_key
        self.secret_key = secret_key
        self.host = host
        self.enabled = enabled

    def export_dataset(self, envs: Sequence[Mapping[str, Any]], dataset_name: str) -> list[dict[str, Any]]:
        items = [eden_env_to_langfuse_dataset(e).to_langfuse() for e in envs]
        return [{"_dataset_name": dataset_name, "_items": items, "count": len(items)}]

    def push_trace(self, trace: Mapping[str, Any]) -> dict[str, Any]:
        return trace_to_langfuse_event(trace).to_langfuse()


__all__ = [
    "LANFUSE_DATASET_ITEM_KEY",
    "LangfuseClient",
    "LangfuseDatasetItem",
    "LangfuseTraceEvent",
    "eden_env_to_langfuse_dataset",
    "trace_to_langfuse_event",
]
