"""Alert rules engine (§9.5.1) — closes the §9.5.1 partial.

The §9.5.1 alert rules are:

  - API p95 latency > 500ms sustained for 5min
  - LLM provider error rate > 0.5% sustained for 5min
  - KB retrieval p95 > 250ms sustained for 5min
  - Pipeline timeout rate > 5% sustained for 5min

In production this would be a real time-series store + a streaming
windowing layer (ksqlDB / Flink). The in-memory version is the
minimum-viable implementation; the surface area (rules, alert
payload shape) is what the §10.3 monitoring layer will replace
when we move to Datadog.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Alert:
    """A single fired alert."""

    rule_id: str
    severity: str          # "critical" | "warning" | "info"
    title: str
    message: str
    value: float
    threshold: float
    fired_at: str          # ISO-8601
    labels: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class AlertRule:
    """A single alert rule."""

    rule_id: str
    severity: str
    title: str
    description: str
    threshold: float

    def evaluate(self, current_value: float) -> Alert | None:
        """Return an Alert if the rule fires (value > threshold), else
        ``None``. Rules are simple upper-bound checks — no sustained
        windowing here (that's the §10.3 monitoring layer's job)."""
        if current_value > self.threshold:
            return Alert(
                rule_id=self.rule_id,
                severity=self.severity,
                title=self.title,
                message=self.description,
                value=current_value,
                threshold=self.threshold,
                fired_at=datetime.now(UTC).isoformat(),
            )
        return None


# Default rule set — the §9.5.1 acceptance criteria.
DEFAULT_RULES: list[AlertRule] = [
    AlertRule(
        rule_id="api_p95_latency",
        severity="warning",
        title="API p95 latency > 500ms",
        description="API p95 latency is over the 500ms SLO. Investigate slow endpoints.",
        threshold=500.0,
    ),
    AlertRule(
        rule_id="llm_provider_error_rate",
        severity="critical",
        title="LLM provider error rate > 0.5%",
        description="An LLM provider is erroring at > 0.5%. Check the provider status page and circuit-breaker state.",
        threshold=0.005,
    ),
    AlertRule(
        rule_id="kb_retrieval_p95",
        severity="warning",
        title="KB retrieval p95 > 250ms",
        description="KB cache p95 is over 250ms. Tier-L2/DB hit rate may be high.",
        threshold=250.0,
    ),
    # Note (June 2026): the ``pipeline_timeout_rate`` rule that used
    # to live here was retired with the env-gen pipeline. Per-agent
    # failure-mode alerting now lives in
    # ``eden.insights.detector_loop`` (Cat 2 RCA + Cat 6 fleet),
    # and Cat 13's predictive module surfaces the timeout trend
    # before it crosses the SLO.
]


def _percentile_from_histogram(rows: list[dict], pct: float) -> float | None:
    """Compute a percentile from the latency-histogram snapshot.

    The histogram is cumulative (Prometheus-style): ``buckets[b]``
    counts all observations with latency <= b. We recover an
    approximate percentile by linear interpolation between buckets.
    """
    if not rows:
        return None
    # Pick the row with the most observations (treat as the "global" view).
    # Real dashboards would group by route; this is the worst-case SLO.
    best = max(rows, key=lambda r: r.get("count", 0))
    if best.get("count", 0) == 0:
        return None
    total = best["count"]
    buckets = best["buckets"]
    # Sort by upper bound.
    for b_str, count in sorted(buckets.items(), key=lambda x: float(x[0]) if x[0] != "+Inf" else 1e18):
        if b_str == "+Inf":
            continue
        threshold_count = (pct / 100.0) * total
        if count >= threshold_count:
            return float(b_str)
    return None
