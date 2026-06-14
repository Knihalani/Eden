"""Cat 10 — :class:`SecurityScanner`.

Datadog Sensitive Data Scanner parity. Periodically scans
historical telemetry for PII patterns and redacts on the way
out. Reads the per-tenant ``org_pii_policies`` table for the
canonical regex set, falling back to the conservative
:data:`DEFAULT_PII_PATTERNS` when the tenant has no policy yet.

The scanner is intentionally idempotent — re-running on an
already-scanned window is safe (it counts hits but doesn't
double-redact). It writes a row to ``security_scan_runs`` per
invocation so the dashboard tile + the auditor's evidence
drill-down can reconstruct who scanned what and when.

Fires :func:`PromotionHook.on_drift_alert` with
``drift_type="security:<scanner>"`` for any finding whose
severity is ``critical`` or ``high``.

Scope:

* ``payload`` — scan the ``telemetry_events.payload_json``
  (the captured prompt + response body)
* ``metadata`` — scan the ``telemetry_events.metadata_json``
* ``all`` — both

The route layer takes a ``scope`` string ∈
``{"payload", "metadata", "all"}``; the default in the
appendix is ``"all"``.
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
from collections.abc import Iterable
from typing import Any, cast

from eden.services.governance_intel._common import (
    DEFAULT_PII_PATTERNS,
    DEFAULT_SCANNERS,
    SCAN_PAGE_MAX,
    SCANNER_SEVERITY,
    _bad_request_envelope,
    _fire_security_violation,
    _get_client,
    _maybe_await,
    _new_id,
    _now,
    _ok_envelope,
    _parse_iso8601,
    _redact_match,
)

logger = logging.getLogger(__name__)


# ── Allowed scope tokens — keep narrow to prevent SQL-injection ────
_ALLOWED_SCOPES: frozenset[str] = frozenset(
    {"payload", "metadata", "all"}
)


class SecurityScanner:
    """Periodic PII / sensitive-data leak scan."""

    name = "security_scanner"

    async def scan_for_pii_leakage(
        self,
        org_id: str,
        *,
        window_start: str | None = None,
        window_end: str | None = None,
        scanners: Iterable[str] | None = None,
        scope: str = "all",
        redact_in_place: bool = True,
        limit: int = SCAN_PAGE_MAX,
    ) -> dict[str, Any]:
        """Run a PII scan over the telemetry stream.

        Args:
            window_start, window_end: ISO 8601 bounds. Default
                is the last 24 hours.
            scanners: which scanner family to run. Defaults to
                :data:`DEFAULT_SCANNERS` if not supplied. Unknown
                scanners are dropped (with a ``dropped_scanners``
                key in the response).
            scope: ``"payload"`` / ``"metadata"`` / ``"all"``.
                Anything else returns a bad-request envelope.
            redact_in_place: if True, the matched event is
                rewritten with ``"***"`` in place of the match.
                Defaults to True (matches the appendix's
                production default).
            limit: hard cap on events fetched. ≤
                :data:`SCAN_PAGE_MAX`.

        Returns:
            The :func:`_ok_envelope` response with the scan_id,
            findings list, redacted-count, and the
            ``policy_violations`` counter (≥1 ⇒ the closed-loop
            hook fired).
        """
        if scope not in _ALLOWED_SCOPES:
            return _bad_request_envelope(
                self.name,
                f"scope must be one of {sorted(_ALLOWED_SCOPES)}",
            )

        now = _now()
        end_dt = _parse_iso8601(window_end) or now
        start_dt = _parse_iso8601(window_start)
        if start_dt is None:
            from datetime import timedelta
            start_dt = end_dt - timedelta(days=1)
        if end_dt <= start_dt:
            return _bad_request_envelope(
                self.name,
                "window_end must be after window_start",
            )

        limit = max(1, min(SCAN_PAGE_MAX, int(limit)))

        # ── Resolve scanner set ─────────────────────────────────
        requested = (
            tuple(scanners) if scanners is not None
            else DEFAULT_SCANNERS
        )

        # ── Fetch per-tenant patterns + fall back ────────────────
        client = await _get_client()
        patterns = await self._fetch_patterns(client, org_id)

        active: list[tuple[str, str]] = []
        dropped: list[str] = []
        for s in requested:
            s = s.strip().lower() if isinstance(s, str) else None
            if not s:
                continue
            if s in patterns:
                active.append((s, patterns[s]))
            else:
                dropped.append(s)

        if not active:
            # Nothing to scan, still write the scan-run row so
            # the dashboard reflects the empty pass.
            scan_id = await self._persist_run(
                client, org_id, [], 0, severity="info",
            )
            return _ok_envelope(
                self.name,
                {
                    "scan_id": scan_id,
                    "window_start": start_dt.isoformat(),
                    "window_end": end_dt.isoformat(),
                    "scope": scope,
                    "n_events_scanned": 0,
                    "n_events_redacted": 0,
                    "findings": [],
                    "policy_violations": 0,
                    "dropped_scanners": dropped,
                },
            )

        # ── Fetch the candidate events ──────────────────────────
        events = await self._fetch_events(
            client, org_id, start_dt, end_dt, scope, limit,
        )

        # ── Run scanners ─────────────────────────────────────────
        findings_by_scanner: dict[str, dict[str, Any]] = {}
        total_redacted = 0
        events_to_rewrite: list[tuple[str, str, str]] = []  # (event_id, column, new_text)

        for ev in events:
            event_id = ev.get("id") or ev.get("event_id")
            trace_id = ev.get("trace_id") or ""
            for column in self._columns_for_scope(scope):
                raw = ev.get(column)
                if not raw:
                    continue
                text = raw if isinstance(raw, str) else json.dumps(raw)
                for scanner_name, pattern in active:
                    try:
                        compiled = _compile_pattern(pattern)
                    except re.error:
                        continue
                    if not compiled.search(text):
                        continue
                    entry = findings_by_scanner.setdefault(
                        scanner_name,
                        {
                            "scanner": scanner_name,
                            "count": 0,
                            "severity": SCANNER_SEVERITY.get(
                                scanner_name, "low"
                            ),
                            "events": [],
                            "action_taken": (
                                "redacted_at_ingest"
                                if redact_in_place
                                else "flagged_only"
                            ),
                        },
                    )
                    entry["count"] += 1
                    if len(entry["events"]) < 100:
                        entry["events"].append(trace_id or event_id)
                    if redact_in_place:
                        text = _redact_match(text, pattern)
                        events_to_rewrite.append((
                            str(event_id), column, text,
                        ))
                        total_redacted += 1

        # ── Apply rewrites + audit log ──────────────────────────
        await self._apply_redactions(
            client, org_id, events_to_rewrite,
        )

        findings = sorted(
            findings_by_scanner.values(),
            key=lambda f: (-_severity_rank(f["severity"]), f["scanner"]),
        )
        policy_violations = sum(
            f["count"] for f in findings
            if f["severity"] in ("critical", "high")
        )

        # Pick the high-water-mark severity for the scan-run row.
        top_severity = "info"
        for f in findings:
            if _severity_rank(f["severity"]) > _severity_rank(top_severity):
                top_severity = f["severity"]

        scan_id = await self._persist_run(
            client, org_id, findings, len(events), severity=top_severity,
        )

        # ── Fire the closed-loop hook for each severe finding ──
        for f in findings:
            _fire_security_violation(
                org_id,
                scanner=f["scanner"],
                count=f["count"],
                severity=f["severity"],
            )

        return _ok_envelope(
            self.name,
            {
                "scan_id": scan_id,
                "window_start": start_dt.isoformat(),
                "window_end": end_dt.isoformat(),
                "scope": scope,
                "n_events_scanned": len(events),
                "n_events_redacted": total_redacted,
                "findings": findings,
                "policy_violations": policy_violations,
                "dropped_scanners": dropped,
            },
        )

    # ── Reads ─────────────────────────────────────────────────────

    async def _fetch_patterns(
        self, client: Any, org_id: str,
    ) -> dict[str, str]:
        """Resolve the per-tenant PII pattern set.

        Reads ``org_pii_policies`` (created in migration 013).
        The schema there exposes ``pattern_name`` + ``regex``.
        Falls back to :data:`DEFAULT_PII_PATTERNS` for any name
        the tenant didn't override.
        """
        patterns: dict[str, str] = dict(DEFAULT_PII_PATTERNS)
        if client is None:
            return patterns
        try:
            rows = list(await client.fetch(
                "SELECT pattern_name, regex FROM org_pii_policies "
                "WHERE org_id = $1 AND enabled = TRUE",
                org_id,
            ))
        except Exception as exc:
            logger.debug(
                "security.fetch_patterns failed: %s", exc
            )
            return patterns
        for r in rows:
            name = r.get("pattern_name")
            regex = r.get("regex")
            if isinstance(name, str) and isinstance(regex, str) and regex:
                # Validate; bad regex from the tenant is silently
                # dropped (the tenant gets a config-page warning
                # elsewhere — not the scanner's job).
                try:
                    re.compile(regex)
                except re.error:
                    continue
                patterns[name.strip().lower()] = regex
        return patterns

    async def _fetch_events(
        self,
        client: Any,
        org_id: str,
        start_dt: Any,
        end_dt: Any,
        scope: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        """Pull the candidate event rows. Returns ``[]`` if no DB.

        The event schema varies between deployments
        (``telemetry_events`` is the production table; some test
        envs have a slimmer rollup). The scanner consumes the
        union of ``payload_json`` / ``metadata_json`` /
        ``payload`` / ``metadata`` keys.
        """
        if client is None:
            return []
        columns = ["id", "trace_id"]
        for c in self._columns_for_scope(scope):
            columns.append(c)
        col_sql = ", ".join(columns)
        sql = (
            f"SELECT {col_sql} FROM telemetry_events "
            "WHERE org_id = $1 AND created_at BETWEEN $2 AND $3 "
            "ORDER BY created_at ASC LIMIT " + str(limit)
        )
        try:
            rows = await client.fetch(sql, org_id, start_dt, end_dt)
            return list(rows)
        except Exception as exc:
            logger.debug("security.fetch_events failed: %s", exc)
            return []

    def _columns_for_scope(self, scope: str) -> tuple[str, ...]:
        if scope == "payload":
            return ("payload_json",)
        if scope == "metadata":
            return ("metadata_json",)
        return ("payload_json", "metadata_json")

    # ── Writes ────────────────────────────────────────────────────

    async def _apply_redactions(
        self,
        client: Any,
        org_id: str,
        rewrites: list[tuple[str, str, str]],
    ) -> None:
        """Apply each (event_id, column, new_text) rewrite and
        write one ``audit_log`` row per rewrite.

        Defensive — any single write that fails is logged and
        skipped; the scan still reports the finding.
        """
        if not rewrites or client is None:
            return
        for event_id, column, new_text in rewrites:
            sql = (
                f"UPDATE telemetry_events SET {column} = $1 "
                "WHERE id = $2 AND org_id = $3"
            )
            try:
                await _maybe_await(client.execute(
                    sql, new_text, event_id, org_id,
                ))
            except Exception as exc:
                logger.debug(
                    "security.apply_redactions failed for %s: %s",
                    event_id, exc,
                )
                continue
            try:
                await _maybe_await(client.execute(
                    "INSERT INTO org_audit_log "
                    "(org_id, user_id, action, target_type, "
                    "target_id, metadata) VALUES "
                    "($1, $2, $3, $4, $5, $6::jsonb)",
                    org_id,
                    org_id,  # system actor
                    "security.scan.redact",
                    "telemetry_event",
                    event_id,
                    json.dumps({"column": column}),
                ))
            except Exception as exc:
                logger.debug(
                    "security.audit_log redact failed: %s", exc
                )

    async def _persist_run(
        self,
        client: Any,
        org_id: str,
        findings: list[dict[str, Any]],
        n_events_scanned: int,
        *,
        severity: str = "info",
    ) -> str:
        """Insert one row in ``security_scan_runs``. Returns
        the scan_id. Defensive: failure returns the locally-
        generated id but doesn't raise.
        """
        scan_id = _new_id("scan")
        if client is None:
            return scan_id
        try:
            await _maybe_await(client.execute(
                "INSERT INTO security_scan_runs "
                "(id, org_id, scan_type, findings_json, "
                "severity, created_at) "
                "VALUES ($1, $2, 'pii_leak', $3, $4, NOW())",
                scan_id, org_id,
                json.dumps({
                    "findings": findings,
                    "n_events_scanned": n_events_scanned,
                }),
                severity,
            ))
        except Exception as exc:
            logger.debug(
                "security.persist_run failed: %s", exc
            )
        return scan_id

    # ── Read paths ────────────────────────────────────────────────

    async def list_runs(
        self,
        org_id: str,
        *,
        limit: int = 50,
    ) -> dict[str, Any]:
        """List historical scan runs for the dashboard tile.
        Latest first; capped at ``limit`` ∈ [1, 200].
        """
        limit = max(1, min(200, int(limit)))
        client = await _get_client()
        rows: list[dict[str, Any]] = []
        if client is not None:
            try:
                rows = list(await client.fetch(
                    "SELECT id, scan_type, severity, "
                    "findings_json, created_at "
                    "FROM security_scan_runs "
                    "WHERE org_id = $1 "
                    "ORDER BY created_at DESC LIMIT " + str(limit),
                    org_id,
                ))
            except Exception as exc:
                logger.debug("security.list_runs failed: %s", exc)
                rows = []

        out = []
        for r in rows:
            try:
                body = json.loads(r.get("findings_json") or "{}")
            except (TypeError, ValueError):
                body = {}
            findings = body.get("findings", [])
            out.append({
                "scan_id": r.get("id"),
                "scan_type": r.get("scan_type"),
                "severity": r.get("severity"),
                "n_events_scanned": int(
                    body.get("n_events_scanned", 0)
                ),
                "n_findings": sum(
                    f.get("count", 0) for f in findings
                ),
                "created_at": _iso(r.get("created_at")),
            })
        return _ok_envelope(
            self.name, {"runs": out, "count": len(out)},
        )


# ── Helpers ─────────────────────────────────────────────────────────


_SEVERITY_RANKS: dict[str, int] = {
    "info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4,
}


def _severity_rank(severity: str) -> int:
    return _SEVERITY_RANKS.get(severity, 0)


# Tiny LRU so we don't recompile patterns per event. Trades a
# few KB for a meaningful speed-up on large scans (1M events ×
# 5 scanners = 5M compile calls otherwise).
_PATTERN_CACHE: dict[str, re.Pattern[str]] = {}
_PATTERN_CACHE_MAX = 256


def _compile_pattern(pattern: str) -> re.Pattern[str]:
    cached = _PATTERN_CACHE.get(pattern)
    if cached is not None:
        return cached
    compiled = re.compile(pattern, re.IGNORECASE | re.MULTILINE)
    if len(_PATTERN_CACHE) >= _PATTERN_CACHE_MAX:
        # Cheap eviction — drop one arbitrary entry. We don't
        # need LRU semantics on the hot path; the cache exists
        # to amortise across a single scan, not across runs.
        with contextlib.suppress(StopIteration):  # pragma: no cover
            _PATTERN_CACHE.pop(next(iter(_PATTERN_CACHE)))
    _PATTERN_CACHE[pattern] = compiled
    return compiled


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            return cast(str | None, value.isoformat())
        except Exception:
            return str(value)
    return str(value)
