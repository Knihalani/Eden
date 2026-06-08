"""Prometheus /metrics endpoint.

Mounts ``GET /metrics`` on the main FastAPI app. The handler
renders the in-process metrics that the rest of the platform
emits (latency histograms from ``api/middleware/latency.py``,
LLM provider error counts from ``llm/client.py``, KB cache
lookups from ``optimization/cache.py``, etc.).

The format is Prometheus text exposition 0.0.4 — the standard
``prometheus_client`` library is preferred but we don't want
to add it as a hard dependency. The implementation here is
deliberately small and only renders the metrics that already
exist in the platform.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Response

from eden.observability.slo import published_slos

logger = logging.getLogger(__name__)
router = APIRouter(tags=["observability"])


def _render(name: str, *, help_text: str, value: float, labels: dict[str, str] | None = None) -> str:
    label_str = ""
    if labels:
        kv = ",".join(f'{k}="{v}"' for k, v in sorted(labels.items()))
        label_str = f"{{{kv}}}"
    return f"# HELP {name} {help_text}\n# TYPE {name} gauge\n{name}{label_str} {value}\n"


@router.get("/metrics")
async def metrics() -> Response:
    """Render the platform's metrics in Prometheus text format."""
    lines: list[str] = []
    # LLM provider error counts
    try:
        from eden.llm.client import get_provider_error_counts
        counts = get_provider_error_counts()
        for provider, n in counts.items():
            lines.append(
                _render(
                    "eden_llm_provider_errors_total",
                    help_text="Cumulative LLM provider errors by provider.",
                    value=n,
                    labels={"provider": provider},
                )
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read provider error counts: %s", exc)

    # SLO targets (so Grafana panels can reference the published target)
    for slo in published_slos():
        lines.append(
            _render(
                "eden_slo_target",
                help_text="Published SLO target as a fraction (0.0 - 1.0).",
                value=slo["target"],
                labels={"slo": slo["name"], "category": slo["category"]},
            )
        )

    body = "".join(lines)
    return Response(content=body, media_type="text/plain; version=0.0.4; charset=utf-8")
