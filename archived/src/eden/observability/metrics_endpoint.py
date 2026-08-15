"""Prometheus /metrics endpoint.

Mounts ``GET /metrics`` on the main FastAPI app. The handler
renders the in-process metrics that the rest of the platform
emits (latency histograms from ``api/middleware/latency.py``,
LLM provider error counts from ``llm/client.py``, KB cache
lookups from ``optimization/cache.py``, etc.).

The format is Prometheus text exposition 0.0.4, rendered by hand rather than
via ``prometheus_client`` so the library stays an optional dependency.

Everything goes through :func:`_render_family`, which emits ``# HELP`` and
``# TYPE`` exactly once per family. That is not a style preference: the format
permits only one of each per family, and ``expfmt.TextParser`` — what
Pushgateway and ``promtool check metrics`` use — aborts the whole scrape on
the second. Rendering per-sample inside a loop, as this module used to, made
the output invalid the moment a second provider, route or SLO appeared. Adding
a new metric means adding one ``_render_family`` call, never a loop of them.

``tests/unit/observability/test_metrics_exposition.py`` enforces this, along
with the rule that every sample of a family carries a distinct label set.

Auth: ``metrics_bearer_token`` (env ``METRICS_BEARER_TOKEN``)
must match the ``Authorization: Bearer <token>`` header. When
the token is empty, the endpoint returns 503 — Prometheus will
silently skip the target. This prevents public scraping.
"""
from __future__ import annotations

import hmac
import logging
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status

from eden.config import get_settings
from eden.observability.slo import published_slos

logger = logging.getLogger(__name__)
router = APIRouter(tags=["observability"])


#: One sample within a family: ``(name_suffix, labels, value)``. The suffix is
#: ``""`` for simple families and ``_bucket``/``_sum``/``_count`` for the
#: composite types.
Sample = tuple[str, Mapping[str, str] | None, float]


def _escape_help(text: str) -> str:
    """Escape a HELP string: backslash and newline only, per the format."""
    return text.replace("\\", r"\\").replace("\n", r"\n")


def _escape_label(value: str) -> str:
    """Escape a label *value*: backslash, double-quote and newline."""
    return value.replace("\\", r"\\").replace('"', r"\"").replace("\n", r"\n")


def _labels_to_str(labels: Mapping[str, str] | None) -> str:
    if not labels:
        return ""
    kv = ",".join(f'{k}="{_escape_label(str(v))}"' for k, v in sorted(labels.items()))
    return f"{{{kv}}}"


def _render_family(
    name: str,
    *,
    help_text: str,
    metric_type: str,
    samples: Iterable[Sample],
) -> str:
    """Render one metric family with ``# HELP``/``# TYPE`` emitted exactly once.

    The text exposition format allows only a single HELP and TYPE line per
    metric family. Emitting them per sample — which is what the previous
    per-sample renderer did inside a loop — makes the output invalid:
    ``expfmt.TextParser`` (used by Pushgateway and ``promtool check metrics``)
    aborts with *"second HELP line for metric name"*, so a whole scrape is
    rejected on account of one repeated family.

    Every sample of a family must also carry a *distinct* label set. Emitting
    the same series twice is not merely untidy — one of the two values is
    silently discarded, which is how the per-route latency histogram came to
    report a single arbitrary route's numbers as the whole service's.
    """
    lines = [
        f"# HELP {name} {_escape_help(help_text)}",
        f"# TYPE {name} {metric_type}",
    ]
    for suffix, labels, value in samples:
        lines.append(f"{name}{suffix}{_labels_to_str(labels)} {value}")
    return "\n".join(lines) + "\n"


def _render(name: str, *, help_text: str, value: float, labels: dict[str, str] | None = None) -> str:
    """Render a single-sample gauge family."""
    return _render_family(
        name,
        help_text=help_text,
        metric_type="gauge",
        samples=[("", labels, value)],
    )


def _render_summary(name: str, *, help_text: str, sum_value: float, count: int) -> str:
    """Render an unlabelled summary (sum + count) as one family."""
    return _render_family(
        name,
        help_text=help_text,
        metric_type="summary",
        samples=[("_sum", None, sum_value), ("_count", None, count)],
    )


def _render_histogram(
    name: str, *, help_text: str, buckets_ms: Sequence[float], rows: Iterable[Mapping[str, Any]]
) -> str:
    """Render every histogram row as a single family.

    Each row is one ``(method, route)`` series. Those two labels used to be
    dropped, which collapsed every route onto the identical series — with N
    routes the same bucket line was emitted N times and only one survived
    parsing. They are now carried through, so ``histogram_quantile`` computes
    a real per-route p95/p99.

    Rows must hold cumulative counts keyed by bucket boundary, plus ``+Inf``,
    ``_sum`` and ``_count``.
    """
    samples: list[Sample] = []
    for row in rows:
        base = {}
        if row.get("method"):
            base["method"] = str(row["method"])
        if row.get("route"):
            base["route"] = str(row["route"])
        buckets = row.get("buckets") or {}
        for b in buckets_ms:
            samples.append(("_bucket", {**base, "le": str(b)}, buckets.get(f"{b}", 0)))
        samples.append(("_bucket", {**base, "le": "+Inf"}, buckets.get("+Inf", 0)))
        samples.append(("_sum", base or None, row.get("sum_ms", 0)))
        samples.append(("_count", base or None, int(row.get("count", 0))))
    return _render_family(
        name, help_text=help_text, metric_type="histogram", samples=samples
    )


async def _check_metrics_auth(authorization: str | None = Header(default=None)) -> None:
    """Constant-time bearer check against ``metrics_bearer_token``.

    Empty token → 503 (the scraper is misconfigured). Wrong token → 401.
    """
    expected = get_settings().metrics_bearer_token
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="metrics endpoint not configured (METRICS_BEARER_TOKEN unset)",
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or malformed Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )
    presented = authorization[len("Bearer "):]
    if not hmac.compare_digest(presented, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid metrics bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


@router.get("/metrics", dependencies=[Depends(_check_metrics_auth)])
async def metrics() -> Response:
    """Render the platform's metrics in Prometheus text format."""
    lines: list[str] = []
    # LLM provider error counts
    try:
        from eden.llm.client import get_provider_error_counts

        # ``get_provider_error_counts`` returns a *nested* mapping —
        # ``{provider: {"calls", "errors", "error_rate"}}`` — but the value was
        # passed straight through as the sample, so the endpoint emitted a
        # Python dict repr where a float belongs:
        #   eden_llm_provider_errors_total{provider="openai"} {'calls': 5, ...}
        # That one line makes the entire scrape unparseable, independently of
        # the duplicate-HELP problem. Expose calls and errors as two counters
        # and let PromQL derive the rate; a pre-computed ratio cannot be
        # aggregated across instances, whereas rate(errors)/rate(calls) can.
        counts = get_provider_error_counts()
        rows = sorted(counts.items())
        lines.append(
            _render_family(
                "eden_llm_provider_errors_total",
                help_text="Cumulative LLM provider errors by provider.",
                # Cumulative and ``_total``-suffixed: a counter, not the gauge
                # the per-sample renderer hard-coded.
                metric_type="counter",
                samples=[
                    ("", {"provider": p}, float(v.get("errors", 0) or 0))
                    for p, v in rows
                ],
            )
        )
        lines.append(
            _render_family(
                "eden_llm_provider_calls_total",
                help_text="Cumulative LLM provider calls by provider.",
                metric_type="counter",
                samples=[
                    ("", {"provider": p}, float(v.get("calls", 0) or 0))
                    for p, v in rows
                ],
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read provider error counts: %s", exc)

    # FEAT-33: guardrail-bypass detections. Fires when a response from
    # ``InterventionEngine.evaluate_and_act`` (or a startup identity
    # check of it) carries the ``trajectory_guardrail`` marker — the
    # signature of the removed ``install_cat15_trajectory_replaces_intervention``
    # monkey-patch, which silently swapped the real content-safety
    # check for an unrelated cost/loop/latency check. Should be zero
    # in steady state; any nonzero value is a live incident.
    try:
        from eden.guardrails.intervention import get_guardrail_bypass_counts

        bypass_counts = get_guardrail_bypass_counts()
        lines.append(
            _render_family(
                "eden_guardrail_bypass_detected_total",
                help_text=(
                    "Cumulative count of evaluate_and_act responses tagged "
                    "feature=trajectory_guardrail (content-safety check bypassed), "
                    "by detection source:org_id key."
                ),
                metric_type="counter",
                samples=[
                    ("", {"source_org": key}, float(v))
                    for key, v in sorted(bypass_counts.items())
                ],
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read guardrail bypass counts: %s", exc)

    # SLO targets (so Grafana panels can reference the published target)
    lines.append(
        _render_family(
            "eden_slo_target",
            help_text="Published SLO target as a fraction (0.0 - 1.0).",
            metric_type="gauge",
            samples=[
                ("", {"slo": slo["name"], "category": slo["category"]}, slo["target"])
                for slo in published_slos()
            ],
        )
    )

    # Audit (June 21 2026) — expose the request latency histogram from
    # ``api/middleware/latency.py`` so Prometheus can compute p95/p99
    # via ``histogram_quantile``.  The audit flagged this as "needs
    # proper middleware; defer to APM v1.5" — the histogram data
    # already exists, only the rendering was missing.
    try:
        from eden.api.middleware.latency import get_metrics_snapshot

        snap = get_metrics_snapshot()
        lines.append(
            _render_histogram(
                "eden_request_duration_ms",
                help_text="Per-route request duration in milliseconds.",
                buckets_ms=snap.get("buckets_ms") or [],
                rows=snap.get("rows") or [],
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to render latency histogram: %s", exc)

    # Search metrics (eden_search_*)
    try:
        from eden.observability.search_service import get_search_stats
        stats = get_search_stats()
        dur_count = stats.get("duration_count", 0)
        dur_sum = stats.get("duration_sum_s", 0.0)
        fallback_total = stats.get("fallback_total", 0.0)
        lag_count = stats.get("index_lag_count", 0)
        lag_sum = stats.get("index_lag_sum_s", 0.0)
        lines.append(
            f"# HELP eden_search_duration_seconds Search request duration in seconds.\n"
            f"# TYPE eden_search_duration_seconds summary\n"
            f"eden_search_duration_seconds_sum {dur_sum}\n"
            f"eden_search_duration_seconds_count {int(dur_count)}\n"
        )
        lines.append(
            f"# HELP eden_search_fallback_total Searches served by Postgres fallback.\n"
            f"# TYPE eden_search_fallback_total counter\n"
            f"eden_search_fallback_total {int(fallback_total)}\n"
        )
        if lag_count > 0:
            lines.append(
                f"# HELP eden_search_index_lag_seconds Typesense index lag (event to indexed).\n"
                f"# TYPE eden_search_index_lag_seconds summary\n"
                f"eden_search_index_lag_seconds_sum {lag_sum}\n"
                f"eden_search_index_lag_seconds_count {int(lag_count)}\n"
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read search stats: %s", exc)

    # W9 — ingest shed + N09 dedupe ratio
    try:
        from eden.observability.ingestion.shed import get_shed_stats

        shed = get_shed_stats()
        lines.append(
            "# HELP eden_ingest_shed_total Ingest requests rejected by load shed.\n"
            "# TYPE eden_ingest_shed_total counter\n"
            f"eden_ingest_shed_total {int(shed.get('shed_total', 0))}\n"
        )
        lines.append(
            "# HELP eden_ingest_shed_depth Last observed ingest pressure depth.\n"
            "# TYPE eden_ingest_shed_depth gauge\n"
            f"eden_ingest_shed_depth {float(shed.get('last_depth', 0))}\n"
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read shed stats: %s", exc)

    try:
        from eden.observability.compression.blob_store import get_blob_store

        ratio = get_blob_store().dedupe_ratio()
        lines.append(
            "# HELP eden_blob_dedupe_ratio N09 content dedupe ratio (seen/stored).\n"
            "# TYPE eden_blob_dedupe_ratio gauge\n"
            f"eden_blob_dedupe_ratio {ratio}\n"
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read blob dedupe: %s", exc)

    # Issues layer metrics (F28 stumble writes / F20 scanner / F29 list).
    try:
        from eden.issues.metrics import (
            get_issue_stats,
            get_scan_stats,
            get_stumble_stats,
        )

        st = get_stumble_stats()
        lines.append(
            "# HELP eden_stumble_write_duration_seconds Stumble write path duration in seconds.\n"
            "# TYPE eden_stumble_write_duration_seconds summary\n"
            f"eden_stumble_write_duration_seconds_sum {st['write_duration_sum_s']}\n"
            f"eden_stumble_write_duration_seconds_count {int(st['write_duration_count'])}\n"
        )
        lines.append(
            "# HELP eden_stumble_created_total Stumbles inserted (real inserts).\n"
            "# TYPE eden_stumble_created_total counter\n"
            f"eden_stumble_created_total {int(st['created_total'])}\n"
        )
        lines.append(
            "# HELP eden_stumble_deduped_total Stumbles deduped (burst or ON CONFLICT).\n"
            "# TYPE eden_stumble_deduped_total counter\n"
            f"eden_stumble_deduped_total {int(st['deduped_total'])}\n"
        )

        scan = get_scan_stats()
        lines.append(
            "# HELP auto_issue_scan_duration_ms Auto-issue scan duration in milliseconds.\n"
            "# TYPE auto_issue_scan_duration_ms summary\n"
            f"auto_issue_scan_duration_ms_sum {scan['scan_duration_ms_sum']}\n"
            f"auto_issue_scan_duration_ms_count {int(scan['scan_duration_ms_count'])}\n"
        )
        lines.append(
            "# HELP auto_issue_queue_lag_seconds Lag from trace.finalized emit to consume.\n"
            "# TYPE auto_issue_queue_lag_seconds summary\n"
            f"auto_issue_queue_lag_seconds_sum {scan['queue_lag_seconds_sum']}\n"
            f"auto_issue_queue_lag_seconds_count {int(scan['queue_lag_seconds_count'])}\n"
        )
        hit_lines = ["# HELP auto_issue_detector_hits Detector hits by kind.",
                     "# TYPE auto_issue_detector_hits counter"]
        for detector, n in sorted(scan.get("detector_hits", {}).items()):
            hit_lines.append(f'auto_issue_detector_hits{{detector="{detector}"}} {int(n)}')
        lines.append("\n".join(hit_lines) + "\n")

        iss = get_issue_stats()
        lines.append(
            "# HELP eden_issue_list_duration_seconds Issue list query duration in seconds.\n"
            "# TYPE eden_issue_list_duration_seconds summary\n"
            f"eden_issue_list_duration_seconds_sum {iss['list_duration_sum_s']}\n"
            f"eden_issue_list_duration_seconds_count {int(iss['list_duration_count'])}\n"
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read issues stats: %s", exc)

    # N14 platform activation gauges (quality worker, wiring, hot path).
    try:
        from eden.observability.platform_activation import (
            get_platform_activation_metrics,
        )

        pa = get_platform_activation_metrics()
        lines.append(
            _render(
                "eden_quality_worker_running",
                help_text="1 when the quality sidecar worker task is alive.",
                value=float(pa["eden_quality_worker_running"]),
            )
        )
        lines.append(
            _render(
                "eden_wiring_install_success",
                help_text="1 when install_all() completed on this process.",
                value=float(pa["eden_wiring_install_success"]),
            )
        )
        lines.append(
            _render(
                "eden_quality_worker_lag_seconds",
                help_text="Seconds since the quality worker last watermark.",
                value=float(pa["eden_quality_worker_lag_seconds"]),
            )
        )
        hot_count = int(pa.get("eden_hot_path_guardrail_duration_seconds_count", 0))
        hot_sum = float(pa.get("eden_hot_path_guardrail_duration_seconds_sum", 0.0))
        lines.append(
            "# HELP eden_hot_path_guardrail_duration_seconds "
            "Hot-path guardrail evaluate_trajectory_step duration.\n"
            "# TYPE eden_hot_path_guardrail_duration_seconds summary\n"
            f"eden_hot_path_guardrail_duration_seconds_sum {hot_sum}\n"
            f"eden_hot_path_guardrail_duration_seconds_count {hot_count}\n"
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read platform activation stats: %s", exc)

    # A10 / A5 — ingest hot-path series (stable names).
    try:
        from eden.observability.ingest_hot_path_metrics import (
            get_ingest_hot_path_metrics,
        )

        hm = get_ingest_hot_path_metrics()
        lines.append(
            "# HELP eden_ingest_redis_commands Redis commands on ingest publish path.\n"
            "# TYPE eden_ingest_redis_commands counter\n"
            f"eden_ingest_redis_commands {int(hm.get('eden_ingest_redis_commands', 0))}\n"
        )
        ch_sum = float(hm.get("eden_ch_flush_batch_size_sum", 0.0) or 0.0)
        ch_count = int(hm.get("eden_ch_flush_batch_size_count", 0) or 0)
        lines.append(
            "# HELP eden_ch_flush_batch_size ClickHouse flush batch size samples.\n"
            "# TYPE eden_ch_flush_batch_size summary\n"
            f"eden_ch_flush_batch_size_sum {ch_sum}\n"
            f"eden_ch_flush_batch_size_count {ch_count}\n"
        )
        lines.append(
            "# HELP eden_sse_publish_skipped SSE publishes skipped when no subscribers.\n"
            "# TYPE eden_sse_publish_skipped counter\n"
            f"eden_sse_publish_skipped {int(hm.get('eden_sse_publish_skipped', 0))}\n"
        )
        lines.append(
            "# HELP eden_ingest_sampled_out Events dropped by the N16 sampling gate.\n"
            "# TYPE eden_ingest_sampled_out counter\n"
            f"eden_ingest_sampled_out {int(hm.get('eden_ingest_sampled_out', 0))}\n"
        )
        lines.append(
            "# HELP eden_ws_fanout_skipped WebSocket fan-outs skipped, no local subscriber.\n"
            "# TYPE eden_ws_fanout_skipped counter\n"
            f"eden_ws_fanout_skipped {int(hm.get('eden_ws_fanout_skipped', 0))}\n"
        )
        lines.append(
            "# HELP eden_ws_fanout_publish_skipped Cross-pod WS fanout PUBLISHes skipped, no subscriber.\n"
            "# TYPE eden_ws_fanout_publish_skipped counter\n"
            f"eden_ws_fanout_publish_skipped {int(hm.get('eden_ws_fanout_publish_skipped', 0))}\n"
        )
        lines.append(
            "# HELP eden_ingest_bytes Raw request body bytes accepted by ingest.\n"
            "# TYPE eden_ingest_bytes counter\n"
            f"eden_ingest_bytes {int(hm.get('eden_ingest_bytes', 0))}\n"
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read ingest hot-path stats: %s", exc)

    # F49 — playground run duration histogram + spend counter (stable names).
    try:
        from eden.observability.playground_metrics import (
            RUN_SECONDS_BUCKETS,
            get_playground_metrics,
        )

        pm = get_playground_metrics()
        pm_stats = pm["stats"]
        pm_buckets = pm["run_seconds_buckets"]
        pm_count = int(pm_stats.get("eden_playground_run_seconds_count", 0))
        hist = [
            "# HELP eden_playground_run_seconds Playground run duration in seconds.",
            "# TYPE eden_playground_run_seconds histogram",
        ]
        for bound in RUN_SECONDS_BUCKETS:
            hist.append(
                f'eden_playground_run_seconds_bucket{{le="{bound}"}} '
                f"{int(pm_buckets.get(bound, 0))}"
            )
        hist.append(f'eden_playground_run_seconds_bucket{{le="+Inf"}} {pm_count}')
        hist.append(
            "eden_playground_run_seconds_sum "
            f"{float(pm_stats.get('eden_playground_run_seconds_sum', 0.0))}"
        )
        hist.append(f"eden_playground_run_seconds_count {pm_count}")
        lines.append("\n".join(hist) + "\n")
        lines.append(
            "# HELP eden_playground_cost_usd_total Playground LLM spend in USD.\n"
            "# TYPE eden_playground_cost_usd_total counter\n"
            "eden_playground_cost_usd_total "
            f"{float(pm_stats.get('eden_playground_cost_usd_total', 0.0))}\n"
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read playground stats: %s", exc)

    # Events Eden discarded, by stage and reason. Seeded at zero so "no drops"
    # is an assertion rather than an absent series.
    try:
        from eden.observability.drop_metrics import get_drop_metrics

        lines.append(
            _render_family(
                "eden_events_dropped_total",
                help_text="Events discarded by Eden, by pipeline stage and reason.",
                metric_type="counter",
                samples=[
                    ("", {"stage": stage, "reason": reason}, value)
                    for (stage, reason), value in sorted(get_drop_metrics().items())
                ],
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read drop counters: %s", exc)

    # ClickHouse→Postgres fallbacks. A 100% fallback rate means the
    # columnar store is decorative; seed at zero so "no fallbacks" is an
    # assertion rather than an absent series.
    try:
        from eden.columnar.fallback_metrics import get_fallback_metrics

        lines.append(
            _render_family(
                "eden_columnar_fallback_total",
                help_text=(
                    "ClickHouse to Postgres fallbacks by surface and reason."
                ),
                metric_type="counter",
                samples=[
                    ("", {"surface": surface, "reason": reason}, value)
                    for (surface, reason), value in sorted(
                        get_fallback_metrics().items()
                    )
                ],
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to read columnar fallback counters: %s", exc)

    # Families registered through ``simple_metrics`` (checkpoint ingest hook,
    # quality-pipeline worker). These were previously written into
    # prometheus_client's default registry, which this endpoint never read.
    try:
        from eden.observability.simple_metrics import iter_families

        for family in iter_families():
            lines.append(
                _render_family(
                    family.name,
                    help_text=family.help_text,
                    metric_type=family.metric_type,
                    samples=family.samples(),
                )
            )
    except Exception as exc:  # noqa: BLE001
        logger.debug("metrics: failed to render simple_metrics families: %s", exc)

    body = "".join(lines)
    return Response(content=body, media_type="text/plain; version=0.0.4; charset=utf-8")
