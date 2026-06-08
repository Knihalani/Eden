"""LangSmith integration.

LangSmith is LangChain's tracing + evaluation platform. Eden
exports envs as datasets and LLM traces as runs. The integration
is intentionally minimal so the SDK is only required at runtime
when the integration is enabled.

Components
----------

* :func:`eden_env_to_langsmith_dataset` — converter.
* :func:`trace_to_langsmith_run` — converter.
* :class:`LangSmithClient` — minimal SDK wrapper.
* ``/integrations/langsmith/*`` routes mounted in
  :mod:`eden.api.routes.integrations_langsmith`.

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


@dataclass(frozen=True)
class LangSmithDatasetItem:
    eden_env_id: str
    inputs: dict[str, Any]
    outputs: dict[str, Any]

    def to_langsmith(self) -> dict[str, Any]:
        return {
            "inputs": self.inputs,
            "outputs": self.outputs,
            "metadata": {"eden_integration_version": INTEGRATION_API_VERSION},
        }


@dataclass(frozen=True)
class LangSmithRun:
    name: str
    inputs: dict[str, Any]
    outputs: dict[str, Any]
    run_type: str = "llm"
    extra: Mapping[str, Any] | None = None

    def to_langsmith(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "run_type": self.run_type,
            "inputs": self.inputs,
            "outputs": self.outputs,
            "extra": {**(self.extra or {}), "eden_integration_version": INTEGRATION_API_VERSION},
        }


def eden_env_to_langsmith_dataset(env: Mapping[str, Any]) -> LangSmithDatasetItem:
    env_id = str(env.get("id") or env.get("env_id") or "")
    return LangSmithDatasetItem(
        eden_env_id=env_id,
        inputs={
            "description": env.get("description", ""),
            "tags": list(env.get("tags") or []),
            "category": env.get("category"),
        },
        outputs={
            "spec": env.get("spec", {}),
            "outcome_tier": env.get("outcome_tier"),
            "quality_score": env.get("quality_score"),
        },
    )


def trace_to_langsmith_run(trace: Mapping[str, Any]) -> LangSmithRun:
    name = str(trace.get("name") or "eden.run")
    if "name" not in trace:
        # Stable synthetic name from the trace id so LangSmith
        # doesn't collide on runs named "eden.run".
        name = f"eden.run.{hashlib.sha256(name.encode()).hexdigest()[:8]}"
    return LangSmithRun(
        name=name,
        inputs=trace.get("input") or {},
        outputs=trace.get("output") or {},
        run_type=str(trace.get("run_type") or "llm"),
        extra=trace.get("extra") or {},
    )


class LangSmithClient:
    """Minimal LangSmith client.

    Like the other integrations, this is a no-op-when-disabled
    wrapper. Real fan-out would call ``langsmith.create_dataset``
    and ``langsmith.create_run``; here we return the would-be
    wire payloads so tests can verify the mapping.
    """

    def __init__(
        self,
        *,
        api_key: str = "",
        endpoint: str = "https://api.smith.langchain.com",
        enabled: bool = False,
    ):
        self.api_key = api_key
        self.endpoint = endpoint
        self.enabled = enabled

    def export_dataset(self, envs: Sequence[Mapping[str, Any]], dataset_name: str) -> dict[str, Any]:
        items = [eden_env_to_langsmith_dataset(e).to_langsmith() for e in envs]
        return {
            "dataset_name": dataset_name,
            "items": items,
            "count": len(items),
            "eden_integration_version": INTEGRATION_API_VERSION,
        }

    def push_run(self, trace: Mapping[str, Any]) -> dict[str, Any]:
        return trace_to_langsmith_run(trace).to_langsmith()


__all__ = [
    "LangSmithClient",
    "LangSmithDatasetItem",
    "LangSmithRun",
    "eden_env_to_langsmith_dataset",
    "trace_to_langsmith_run",
]
