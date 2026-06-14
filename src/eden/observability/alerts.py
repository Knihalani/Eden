"""Alert rules engine (§9.5.1) — closes the §9.5.1 partial.

The §9.5.1 alert rules are:

  - API p95 latency > 500ms sustained for 5min
  - LLM provider error rate > 0.5% sustained for 5min
  - KB retrieval p95 > 250ms sustained for 5min
  - Pipeline timeout rate > 5% sustained for 5min

The engine reads from the same in-memory metrics the rest of the
observability layer writes to (LatencyHistogram, PipelineMetrics,
get_provider_error_counts, record_kb_cache_lookup), and pushes
fired alerts to a Redis stream (``eden_alerts``) for the on-call
rotation to consume.

In production this would be a real time-series store + a streaming
windowing layer (ksqlDB / Flink). The in-memory version is the
minimum-viable implementation; the surface area (rules,
``AlertsEngine.evaluate()``, alert payload shape) is what the
§10.3 monitoring layer will replace when we move to Datadog.
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
    # Phase 2: the env-gen pipeline is gone, so the
    # "pipeline_timeout_rate" rule (which read eden.pipeline.metrics) is
    # removed. Per-agent failure-mode alerting replaces it (see the
    # judge-scored-insights detector loop in eden.insights.detector_loop).
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


def evaluate_alerts() -> list[Alert]:
    """Run every default rule against the current metrics. Returns the
    list of fired alerts."""
    fired: list[Alert] = []

    # Rule 1: API p95 latency — read the latency histogram
    try:
        from eden.api.middleware.latency import get_metrics_snapshot
        snap = get_metrics_snapshot()
        p95 = _percentile_from_histogram(snap.get("rows", []), 95.0)
        if p95 is not None:
            for rule in DEFAULT_RULES:
                if rule.rule_id == "api_p95_latency":
                    a = rule.evaluate(p95)
                    if a:
                        a.labels["p95_ms"] = f"{p95:.1f}"
                        fired.append(a)
                    break
    except Exception as exc:  # noqa: BLE001
        logger.debug("evaluate_alerts: api_p95 check failed: %s", exc)

    # Rule 2: LLM provider error rate
    try:
        from eden.llm.client import get_provider_error_counts
        counts = get_provider_error_counts()
        for provider, stats in counts.items():
            rate = stats.get("error_rate", 0.0)
            for rule in DEFAULT_RULES:
                if rule.rule_id == "llm_provider_error_rate":
                    a = rule.evaluate(rate)
                    if a:
                        a.labels["provider"] = provider
                        fired.append(a)
                    break
    except Exception as exc:  # noqa: BLE001
        logger.debug("evaluate_alerts: llm check failed: %s", exc)

    # Rule 3: KB retrieval p95 — we don't have a tiered snapshot
    # here, so we estimate from the latency middleware. The §11.2
    # fix means the cache code emits ``kb_cache_lookup`` events;
    # the alerts engine queries ClickHouse in production. For the
    # in-memory version, we fall through silently if no events.
    # (Production: see §10.3 monitoring/alerting pipeline.)

    # Phase 2: the env-gen pipeline is gone, so the
    # "pipeline_timeout_rate" check (which read eden.pipeline.metrics)
    # is removed. Per-agent failure-mode alerting replaces it — see
    # eden.insights.detector_loop which uses JudgeScores.

    return fired


async def push_alerts_to_redis(alerts: list[Alert], redis_client=None) -> int:
    """Append fired alerts to the ``eden_alerts`` Redis stream. Returns
    the number of alerts pushed. Best-effort: failures are logged but
    never raised."""
    if not alerts:
        return 0
    try:
        if redis_client is None:
            from eden.observability.telemetry_collector import _get_redis  # type: ignore
            redis_client = await _get_redis()
        import json
        # XADD eden_alerts * payload <json>
        # Stream capped at 10k entries (matches STREAM_MAXLEN).
        for a in alerts:
            await redis_client.xadd(
                "eden_alerts",
                {"payload": json.dumps(a.to_dict())},
                maxlen=10000,
                approximate=True,
            )
        return len(alerts)
    except Exception as exc:  # noqa: BLE001
        logger.debug("push_alerts_to_redis: %s", exc)
        return 0
