"""CustomMetricRegistry — the per-tenant metric store (Galileo "metric store" parity).

A thin CRUD service over the ``organizations.features.custom_metrics``
JSONB array. The registry is the single source of truth for
"what custom metrics does this org have, in what state, with
what score statistics". The JudgeFactory handles the
runtime-judge registration; the Synthesiser handles the
rubric-creation audit log; the registry is purely the org-
level metric store.

Lifecycle
---------
A metric goes through three states:

1. **draft** — registered, judge is in the global
   :class:`JudgeRegistry`, but the metric has not been
   promoted to production. The judge runs in opt-in mode
   (per-tenant gate) and the metric does not appear in the
   production dashboard.
2. **production** — promoted by an org admin via
   :meth:`approve`. The metric appears in the production
   dashboard and the :func:`MetricStudioHook.on_metric_promotion`
   hook fires. The judge continues to be opt-in (the v1.4
   opt-in policy is independent of the metric status).
3. **deprecated** — set explicitly by the customer; the metric
   stays in the store for audit purposes but the judge is
   unregistered and the metric is hidden from the production
   dashboard.

Persistence
-----------
The store is ``organizations.features.custom_metrics`` — a
JSONB array of metric dicts. Each entry has the shape::

    {
        "metric_id": "metric_xxxxxxxxxxxx",
        "name": "Brand Voice v1",
        "rubric_id": "rubric_xxxxxxxxxxxx",
        "version": "1.0",
        "status": "draft" | "production" | "deprecated",
        "judge_id": "custom_metric_xxxxxxxxxxxx",
        "domain": "marketing",
        "created_at": "2026-06-11T12:34:56+00:00",
        "created_by": "user@example.com",
    }

Score statistics (``n_scores_30d``, ``median_score``) are
NOT persisted in the store — they are computed on the fly by
:meth:`list` from the ``custom_metric_runs`` table (the
per-score run log the judge writes).

See ``docs/observability-gap/21-custom-metric-studio.md``.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from ._common import (
    _fetch_run_runs,
    _load_org_custom_metrics,
    _ok_envelope,
    _save_org_custom_metrics,
)

logger = logging.getLogger(__name__)


class CustomMetricRegistry:
    """The per-tenant custom-metric store."""

    name = "custom_metric_registry"

    async def register(
        self,
        org_id: str,
        *,
        name: str,
        rubric_id: str,
        version: str = "1.0",
        status: str = "draft",
        created_by: str | None = None,
        domain: str | None = None,
    ) -> dict[str, Any]:
        """Register a new custom metric from an approved rubric.

        Reads the synthesised rubric from the
        ``custom_metric_runs`` audit log, wraps it as a
        runtime judge via :class:`JudgeFactory`, and stores
        the metric in ``organizations.features.custom_metrics``.

        Returns the live envelope with ``metric_id`` (the
        customer-facing identifier) and ``judge_id`` (the
        registered name in the global
        :class:`JudgeRegistry`).
        """
        if not rubric_id:
            return _ok_envelope(
                self.name,
                {"registered": False, "reason": "missing rubric_id"},
            )
        if not name:
            return _ok_envelope(
                self.name,
                {"registered": False, "reason": "missing name"},
            )

        # Read the synthesised rubric from the audit log.
        rubric_prompt, existing_name, existing_domain = await _fetch_rubric(
            org_id, rubric_id
        )
        if not rubric_prompt:
            return _ok_envelope(
                self.name,
                {
                    "registered": False,
                    "reason": f"no synthesised rubric found for rubric_id={rubric_id!r}",
                },
            )

        # Allocate the metric_id and persist the metric
        # entry to org features BEFORE registering the
        # judge — the judge name is derived from
        # metric_id, so the order matters.
        metric_id = f"metric_{uuid.uuid4().hex[:12]}"
        created_at = datetime.now(UTC).isoformat()
        entry = {
            "metric_id": metric_id,
            "name": name or existing_name or "Custom Metric",
            "rubric_id": rubric_id,
            "version": version or "1.0",
            "status": status if status in {"draft", "production", "deprecated"} else "draft",
            "judge_id": None,  # backfilled below
            "domain": domain or existing_domain or "general",
            "created_at": created_at,
            "created_by": created_by or "",
        }
        metrics = await _load_org_custom_metrics(org_id)
        metrics.append(entry)
        await _save_org_custom_metrics(org_id, metrics)

        # Wrap the rubric as a runtime judge. The factory
        # also backfills the audit-log row with the
        # metric_id + judge_name.
        from .judge_factory import JudgeFactory
        wrap = await JudgeFactory().wrap_rubric_as_judge(
            org_id,
            metric_id=metric_id,
            rubric_prompt=rubric_prompt,
            name=entry["name"],
            rubric_id=rubric_id,
            domain=entry["domain"],
        )
        if not wrap.get("data", {}).get("wrapped"):
            # The judge registration failed; back out the
            # metric entry to keep the store consistent.
            metrics = await _load_org_custom_metrics(org_id)
            metrics = [m for m in metrics if m.get("metric_id") != metric_id]
            await _save_org_custom_metrics(org_id, metrics)
            return _ok_envelope(
                self.name,
                {
                    "registered": False,
                    "reason": wrap.get("data", {}).get("reason", "judge_wrap_failed"),
                },
            )

        # Backfill the metric entry's judge_id now that
        # the judge is registered.
        judge_name = wrap["data"]["judge_name"]
        metrics = await _load_org_custom_metrics(org_id)
        for m in metrics:
            if m.get("metric_id") == metric_id:
                m["judge_id"] = judge_name
                break
        await _save_org_custom_metrics(org_id, metrics)

        return _ok_envelope(
            self.name,
            {
                "registered": True,
                "metric_id": metric_id,
                "judge_id": judge_name,
                "name": entry["name"],
                "status": entry["status"],
                "domain": entry["domain"],
                "rubric_id": rubric_id,
            },
        )

    async def list(self, org_id: str) -> dict[str, Any]:
        """List the org's custom metrics, enriched with score stats.

        For each metric we compute:

        * ``n_scores_30d`` — number of scored events in the
          last 30 days
        * ``median_score`` — median of the scores in the
          same window

        Both are computed on the fly from the
        ``custom_metric_runs`` table; the metric store
        itself stays a thin CRUD list. The 30-day window is
        a deliberate product choice — customers want to
        know "is this metric still pulling its weight in
        the last month" not "all-time".

        Returns the live envelope with a ``metrics`` array
        sorted by ``created_at`` DESC (newest first).
        """
        metrics = await _load_org_custom_metrics(org_id)
        since = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        out: list[dict[str, Any]] = []
        for m in metrics:
            enriched = dict(m)
            try:
                runs = await _fetch_run_runs(
                    org_id, m["metric_id"], since_iso=since
                )
                enriched["n_scores_30d"] = len(runs)
                if runs:
                    scores = sorted(
                        r.get("score")
                        for r in runs
                        if isinstance(r.get("score"), (int, float))
                    )
                    if scores:
                        mid = len(scores) // 2
                        if len(scores) % 2:
                            enriched["median_score"] = float(scores[mid])
                        else:
                            enriched["median_score"] = float(
                                (scores[mid - 1] + scores[mid]) / 2.0
                            )
                    else:
                        enriched["median_score"] = None
                else:
                    enriched["median_score"] = None
            except Exception as exc:  # pragma: no cover - defensive
                logger.debug(
                    "metric_studio.registry: score stats failed for %s: %s",
                    m.get("metric_id"),
                    exc,
                )
                enriched["n_scores_30d"] = 0
                enriched["median_score"] = None
            out.append(enriched)
        # Newest first
        out.sort(key=lambda x: x.get("created_at", ""), reverse=True)
        return _ok_envelope(self.name, {"metrics": out, "count": len(out)})

    async def get(self, org_id: str, metric_id: str) -> dict[str, Any]:
        """Return a single metric entry (no score stats)."""
        metrics = await _load_org_custom_metrics(org_id)
        for m in metrics:
            if m.get("metric_id") == metric_id:
                return _ok_envelope(self.name, {"metric": m, "found": True})
        return _ok_envelope(
            self.name,
            {"metric": None, "found": False, "metric_id": metric_id},
        )

    async def approve(
        self, org_id: str, metric_id: str, *, approved_by: str
    ) -> dict[str, Any]:
        """Promote a metric from ``draft`` to ``production``.

        Admin-only at the route layer
        (:func:`eden.api.deps.require_org_admin`). The
        closed-loop hook
        :func:`MetricStudioHook.on_metric_promotion` fires
        after the status flip so a Cat 3 judge regression
        can auto-roll-back a promoted custom metric.

        No-op if the metric is already in ``production``.
        """
        metrics = await _load_org_custom_metrics(org_id)
        target: dict[str, Any] | None = None
        for m in metrics:
            if m.get("metric_id") == metric_id:
                target = m
                break
        if target is None:
            return _ok_envelope(
                self.name,
                {"approved": False, "reason": f"no metric with id={metric_id!r}"},
            )
        if target.get("status") == "production":
            return _ok_envelope(
                self.name,
                {
                    "approved": True,
                    "already_production": True,
                    "metric_id": metric_id,
                },
            )
        if target.get("status") == "deprecated":
            return _ok_envelope(
                self.name,
                {
                    "approved": False,
                    "reason": "cannot re-approve a deprecated metric",
                    "metric_id": metric_id,
                },
            )

        # Flip the status + record the approver.
        target["status"] = "production"
        target["promoted_at"] = datetime.now(UTC).isoformat()
        target["promoted_by"] = approved_by or ""
        await _save_org_custom_metrics(org_id, metrics)

        # Fire the closed-loop hook.
        try:
            from eden.llmops.promotion_hooks import get_metric_studio_hook
            hook = get_metric_studio_hook()
            # ``on_metric_promotion`` is ``async def``; ``approve`` is
            # async, so await it — a bare call dropped every promotion
            # notification.
            await hook.on_metric_promotion(
                org_id=org_id,
                metric_id=metric_id,
                judge_name=target.get("judge_id") or "",
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug(
                "metric_studio.registry: hook fire failed: %s", exc
            )

        return _ok_envelope(
            self.name,
            {
                "approved": True,
                "metric_id": metric_id,
                "status": "production",
                "approved_by": approved_by,
            },
        )


# ── Internal helpers (module-private) ───────────────────────────────


async def _fetch_rubric(
    org_id: str, rubric_id: str
) -> tuple[str | None, str | None, str | None]:
    """Read the synthesised rubric prompt + name + domain from
    the ``custom_metric_runs`` audit log. Mirrors the
    :func:`eden.metric_studio.synthesiser._fetch_rubric_row`
    helper — duplicated here so the registry has no runtime
    dependency on the synthesiser module (lazy-imported
    instead)."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("metric_studio.registry: postgres import failed: %s", exc)
        return None, None, None
    client = await get_postgres_client()
    if client is None:
        return None, None, None
    try:
        row = await client.fetchrow(
            "SELECT synthesised_rubric, metric_name, domain "
            "FROM custom_metric_runs WHERE org_id = $1 AND id = $2",
            org_id,
            rubric_id,
        )
    except Exception as exc:
        logger.debug("metric_studio.registry: fetch_rubric failed: %s", exc)
        return None, None, None
    if row is None:
        return None, None, None
    return (
        row.get("synthesised_rubric"),
        row.get("metric_name"),
        row.get("domain"),
    )
