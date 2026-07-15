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

Auth: ``metrics_bearer_token`` (env ``METRICS_BEARER_TOKEN``)
must match the ``Authorization: Bearer <token>`` header. When
the token is empty, the endpoint returns 503 — Prometheus will
silently skip the target. This prevents public scraping.
"""
from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status

from eden.config import get_settings
from eden.observability.slo import published_slos

logger = logging.getLogger(__name__)
router = APIRouter(tags=["observability"])


def _render(name: str, *, help_text: str, value: float, labels: dict[str, str] | None = None) -> str:
    label_str = ""
    if labels:
        kv = ",".join(f'{k}="{v}"' for k, v in sorted(labels.items()))
        label_str = f"{{{kv}}}"
    return f"# HELP {name} {help_text}\n# TYPE {name} gauge\n{name}{label_str} {value}\n"


def _render_histogram(name: str, *, help_text: str, buckets_ms: list, row: dict) -> str:
    """Render a single histogram row as Prometheus text format.

    ``row`` must contain keys for each bucket boundary in ``buckets_ms``
    plus ``+Inf``, ``_sum``, and ``_count``.
    """
    lines = [f"# HELP {name} {help_text}", f"# TYPE {name} histogram"]
    for b in buckets_ms:
        key = f"{b}"
        lines.append(f'{name}_bucket{{le="{b}"}} {row.get(key, 0)}')
    lines.append(f'{name}_bucket{{le="+Inf"}} {row.get("+Inf", 0)}')
    lines.append(f"{name}_sum {row.get('_sum', 0)}")
    lines.append(f"{name}_count {int(row.get('_count', 0))}")
    return "\n".join(lines) + "\n"


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

    # Audit (June 21 2026) — expose the request latency histogram from
    # ``api/middleware/latency.py`` so Prometheus can compute p95/p99
    # via ``histogram_quantile``.  The audit flagged this as "needs
    # proper middleware; defer to APM v1.5" — the histogram data
    # already exists, only the rendering was missing.
    try:
        from eden.api.middleware.latency import get_metrics_snapshot

        snap = get_metrics_snapshot()
        buckets_ms = snap.get("buckets_ms") or []
        for r in snap.get("rows") or []:
            raw = r.get("buckets") or {}
            row = {**raw, "_sum": r.get("sum_ms", 0), "_count": r.get("count", 0)}
            lines.append(
                _render_histogram(
                    "eden_request_duration_ms",
                    help_text="Per-route request duration in milliseconds.",
                    buckets_ms=buckets_ms,
                    row=row,
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

    body = "".join(lines)
    return Response(content=body, media_type="text/plain; version=0.0.4; charset=utf-8")
