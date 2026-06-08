"""Observability context provider.

Produces a compact markdown summary of recent traces, latency, cost,
and failure modes for the agent under development, sized to fit
within a small token budget (~2k tokens by default).

The summary is pre-computed by the API (see
``/v1/orgs/{org}/observability/summary``) so we don't have to do
local aggregation — we just render what the API gives us.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Optional

from eden.api_client import EdenAPIClient, EdenAPIError
from eden.config import ContextConfig

logger = logging.getLogger("eden.cli.observability_context")


@dataclass
class ObservabilityContext:
    """Rendered observability summary for system-prompt injection."""

    text: str
    hit_count: int
    truncated: bool = False
    cached: bool = False

    @property
    def empty(self) -> bool:
        return not self.text


# 4 chars ≈ 1 token (rough, sufficient for context budgeting).
_CHARS_PER_TOKEN = 4


def _approx_tokens(text: str) -> int:
    return max(1, len(text) // _CHARS_PER_TOKEN)


def _truncate_to_budget(text: str, budget: int) -> tuple[str, bool]:
    cap = budget * _CHARS_PER_TOKEN
    if len(text) <= cap:
        return text, False
    return text[:cap].rsplit("\n", 1)[0] + "\n…_(truncated)_", True


class ObservabilityContextProvider:
    """Fetches and renders the observability summary."""

    def __init__(
        self,
        client: EdenAPIClient,
        config: ContextConfig,
    ):
        self.client = client
        self.config = config

    async def get_context(
        self,
        *,
        window_hours: int = 24,
        budget: Optional[int] = None,
    ) -> ObservabilityContext:
        """Fetch the most recent observability summary and render it.

        ``window_hours`` controls the time window the API aggregates over.
        ``budget`` overrides the configured ``observability_token_budget``.
        """
        budget = budget or self.config.observability_token_budget
        try:
            resp = await self.client.observability_summary(
                window_hours=window_hours
            )
        except EdenAPIError as exc:
            logger.warning("Observability summary failed: %s", exc)
            return ObservabilityContext(text="", hit_count=0)

        text = self._render(resp)
        hit_count = self._count_traces(resp)
        text, truncated = _truncate_to_budget(text, budget)
        return ObservabilityContext(
            text=text, hit_count=hit_count, truncated=truncated
        )

    async def list_recent_traces(self, *, limit: int = 5) -> list[dict[str, Any]]:
        """Return raw trace summaries (used by ``/eden-traces``)."""
        try:
            resp = await self.client.list_traces(limit=limit)
        except EdenAPIError as exc:
            logger.warning("list_traces failed: %s", exc)
            return []
        # API may return {"traces": [...]} or a bare list
        if isinstance(resp, list):
            return resp
        if isinstance(resp, dict):
            traces = resp.get("traces") or resp.get("results") or []
            if isinstance(traces, list):
                return traces
        return []

    # ── Rendering ─────────────────────────────────────────────────────

    def _render(self, resp: dict[str, Any]) -> str:
        """Format the summary as compact markdown."""
        lines: list[str] = ["## [OBSERVABILITY CONTEXT]"]

        # Common summary fields
        if "window_hours" in resp:
            lines.append(f"_Window: last {resp['window_hours']}h_")
        if "total_traces" in resp:
            lines.append(f"- **Traces:** {resp['total_traces']}")
        if "error_rate" in resp:
            lines.append(f"- **Error rate:** {resp['error_rate']:.1%}")
        if "p50_latency_ms" in resp or "p95_latency_ms" in resp:
            p50 = resp.get("p50_latency_ms")
            p95 = resp.get("p95_latency_ms")
            p99 = resp.get("p99_latency_ms")
            lat = ", ".join(
                f"{name}={val:.0f}ms"
                for name, val in (
                    ("p50", p50),
                    ("p95", p95),
                    ("p99", p99),
                )
                if isinstance(val, (int, float))
            )
            if lat:
                lines.append(f"- **Latency:** {lat}")
        if "total_cost_usd" in resp:
            lines.append(f"- **Cost (window):** ${resp['total_cost_usd']:.2f}")
        if "top_failure_modes" in resp and isinstance(
            resp["top_failure_modes"], list
        ):
            fm = resp["top_failure_modes"][:3]
            if fm:
                lines.append("- **Top failure modes:**")
                for f in fm:
                    if isinstance(f, dict):
                        name = f.get("name") or f.get("category") or "?"
                        count = f.get("count", "?")
                        lines.append(f"    - {name} ({count})")
                    else:
                        lines.append(f"    - {f}")
        if "model_breakdown" in resp and isinstance(
            resp["model_breakdown"], list
        ):
            mb = resp["model_breakdown"][:3]
            if mb:
                lines.append("- **Top models (cost or call count):**")
                for m in mb:
                    if isinstance(m, dict):
                        model = m.get("model") or m.get("name") or "?"
                        n = m.get("calls") or m.get("count") or "?"
                        lines.append(f"    - {model}: {n}")

        # Drop the header line if it has no body
        body = "\n".join(line for line in lines if line)
        if body == "## [OBSERVABILITY CONTEXT]":
            return ""
        return body

    def _count_traces(self, resp: dict[str, Any]) -> int:
        for key in ("total_traces", "trace_count", "count"):
            v = resp.get(key)
            if isinstance(v, int):
                return v
        return 0
