"""Cat 10 v2 — :class:`ComplianceDashboardService`.

Aggregates every Cat 10 surface into a single dashboard
payload: the latest evidence pack per framework, the
approval-request inbox stats, the most recent scan run, and
the open RTBF queue.

This is what the **CISO dashboard tile** in the portal calls;
it's the "one query, one card" view of compliance posture.

Two services:

* :meth:`ComplianceDashboardService.aggregate` — the headline
  rollup. Returns a single envelope with sub-sections per
  surface.
* :meth:`ComplianceDashboardService.posture_summary` — the
  exec-facing 2-line summary ("47/50 SOC2 controls passing;
  3 high-severity PII findings; 2 RTBF requests due in 3
  days"). Used by the email digest.
"""

from __future__ import annotations

import json
import logging
from typing import Any, cast

from eden.services.governance_intel._common import (
    SUPPORTED_FRAMEWORKS,
    _get_client,
    _new_id,
    _now,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


class ComplianceDashboardService:
    """Aggregate compliance posture into a single dashboard payload."""

    name = "compliance_dashboard"

    async def aggregate(
        self, org_id: str,
    ) -> dict[str, Any]:
        """Return the full dashboard payload.

        Sections:

        * ``frameworks`` — per-framework status from the latest
          evidence pack in ``compliance_evidence``.
        * ``approvals`` — pending / approved / denied counts
          from ``approval_requests``.
        * ``scans`` — last scan run + total open findings from
          ``security_scan_runs``.
        * ``rtbf`` — open / overdue RTBF requests from the
          ``org_audit_log`` filtered to ``rtbf.processed``.
        """
        client = await _get_client()
        frameworks_out = await self._framework_rollup(client, org_id)
        approvals_out = await self._approvals_rollup(client, org_id)
        scans_out = await self._scans_rollup(client, org_id)
        rtbf_out = await self._rtbf_rollup(client, org_id)

        return _ok_envelope(
            self.name,
            {
                "dashboard_id": _new_id("dash"),
                "generated_at": _now().isoformat(),
                "frameworks": frameworks_out,
                "approvals": approvals_out,
                "scans": scans_out,
                "rtbf": rtbf_out,
                "headline": self._headline(
                    frameworks_out, approvals_out, scans_out, rtbf_out,
                ),
            },
        )

    async def posture_summary(
        self, org_id: str,
    ) -> dict[str, Any]:
        """Two-line summary used by the email digest + the
        org-list portal tile.
        """
        full = await self.aggregate(org_id)
        if full.get("status") != "ok":
            return full
        return _ok_envelope(
            self.name,
            {
                "summary": full["data"]["headline"],
                "generated_at": full["data"]["generated_at"],
            },
        )

    # ── Internals ────────────────────────────────────────────────

    async def _framework_rollup(
        self, client: Any, org_id: str,
    ) -> list[dict[str, Any]]:
        out = []
        for fw in sorted(SUPPORTED_FRAMEWORKS):
            entry = {
                "framework": fw,
                "evidence_pack_id": None,
                "generated_at": None,
                "controls_passing": 0,
                "controls_failing": 0,
                "controls_warning": 0,
            }
            if client is not None:
                try:
                    rows = list(await client.fetch(
                        "SELECT id, evidence_json, generated_at "
                        "FROM compliance_evidence "
                        "WHERE org_id = $1 AND framework = $2 "
                        "ORDER BY generated_at DESC LIMIT 1",
                        org_id, fw,
                    ))
                except Exception as exc:
                    logger.debug(
                        "dashboard.framework fetch failed: %s", exc,
                    )
                    rows = []
                if rows:
                    r = rows[0]
                    entry["evidence_pack_id"] = r.get("id")
                    entry["generated_at"] = _iso(r.get("generated_at"))
                    try:
                        body = json.loads(
                            r.get("evidence_json") or "{}"
                        )
                    except (TypeError, ValueError):
                        body = {}
                    entry["controls_passing"] = int(
                        body.get("passing", 0)
                    )
                    entry["controls_failing"] = int(
                        body.get("failing", 0)
                    )
                    entry["controls_warning"] = int(
                        body.get("warnings", 0)
                    )
            out.append(entry)
        return out

    async def _approvals_rollup(
        self, client: Any, org_id: str,
    ) -> dict[str, Any]:
        rollup = {
            "pending": 0, "approved": 0, "denied": 0, "expired": 0,
        }
        if client is None:
            return rollup
        try:
            rows = list(await client.fetch(
                "SELECT state, COUNT(*) AS count "
                "FROM approval_requests "
                "WHERE org_id = $1 GROUP BY state",
                org_id,
            ))
        except Exception as exc:
            logger.debug(
                "dashboard.approvals fetch failed: %s", exc,
            )
            return rollup
        for r in rows:
            state = r.get("state")
            count = int(
                r.get("count") or next(iter(r.values()), 0) or 0
            )
            if state in rollup:
                rollup[state] = count
        return rollup

    async def _scans_rollup(
        self, client: Any, org_id: str,
    ) -> dict[str, Any]:
        rollup = {
            "last_scan_at": None,
            "last_severity": None,
            "findings_last_7d": 0,
            "open_critical": 0,
            "open_high": 0,
        }
        if client is None:
            return rollup
        try:
            rows = list(await client.fetch(
                "SELECT severity, findings_json, created_at "
                "FROM security_scan_runs "
                "WHERE org_id = $1 "
                "ORDER BY created_at DESC LIMIT 30",
                org_id,
            ))
        except Exception as exc:
            logger.debug("dashboard.scans fetch failed: %s", exc)
            return rollup
        if not rows:
            return rollup
        rollup["last_scan_at"] = _iso(rows[0].get("created_at"))
        rollup["last_severity"] = rows[0].get("severity")
        for r in rows:
            try:
                body = json.loads(r.get("findings_json") or "{}")
            except (TypeError, ValueError):
                body = {}
            for f in body.get("findings", []):
                count = int(f.get("count", 0))
                sev = f.get("severity")
                rollup["findings_last_7d"] += count
                if sev == "critical":
                    rollup["open_critical"] += count
                elif sev == "high":
                    rollup["open_high"] += count
        return rollup

    async def _rtbf_rollup(
        self, client: Any, org_id: str,
    ) -> dict[str, Any]:
        rollup = {"processed": 0, "last_processed_at": None}
        if client is None:
            return rollup
        try:
            rows = list(await client.fetch(
                "SELECT COUNT(*) AS count, MAX(created_at) AS last_at "
                "FROM org_audit_log "
                "WHERE org_id = $1 AND action = 'rtbf.processed'",
                org_id,
            ))
        except Exception as exc:
            logger.debug("dashboard.rtbf fetch failed: %s", exc)
            return rollup
        if rows:
            row = rows[0]
            rollup["processed"] = int(row.get("count") or 0)
            rollup["last_processed_at"] = _iso(row.get("last_at"))
        return rollup

    def _headline(
        self,
        frameworks: list[dict[str, Any]],
        approvals: dict[str, Any],
        scans: dict[str, Any],
        rtbf: dict[str, Any],
    ) -> str:
        """Build the exec-facing one-line headline.

        Format:
        ``"<framework>: P/N passing | <pending> pending approvals
        | <crit+high> high-sev findings | <rtbf> RTBF processed"``.
        """
        fw_parts = []
        for fw in frameworks:
            n = (
                fw["controls_passing"] + fw["controls_warning"]
                + fw["controls_failing"]
            )
            if n == 0:
                continue
            short = fw["framework"].replace("_type_ii", "").upper()
            fw_parts.append(
                f"{short}: {fw['controls_passing']}/{n}"
            )
        fw_str = " · ".join(fw_parts) if fw_parts else "no evidence yet"
        high_sev = scans["open_critical"] + scans["open_high"]
        return (
            f"{fw_str} | {approvals['pending']} pending approvals "
            f"| {high_sev} high-sev PII findings "
            f"| {rtbf['processed']} RTBF processed"
        )


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            return cast(str | None, value.isoformat())
        except Exception:
            return str(value)
    return str(value)
