"""Cat 10 v2 — :class:`RightToBeForgottenService`.

GDPR Article 17 (Right to Erasure) compliance. Processes RTBF
requests for a given ``user_id`` / ``email``:

1. Anonymise the user's traces in ``telemetry_events`` —
   payload + metadata get pattern-replaced; the row stays so
   aggregate analytics still reflect the activity (the
   appendix's "preserve outcome counts but lose identity"
   stance).
2. Anonymise ``judge_scores`` (overwrite ``raw_input`` /
   ``raw_output`` text columns with ``"***"``).
3. Anonymise ``user_feedback`` rows (Cat 9 table).
4. Anonymise ``user_sessions`` (Cat 9 table) — replace user_id
   with the SHA256-hashed anonymous id.
5. Audit-log the RTBF action with full lineage (which tables
   touched, how many rows, who requested, when).

The v0 ships an "in-Eden" RTBF — child systems (Salesforce,
S3, etc.) are out of scope (the appendix's v2 webhook path
is what does that).

GDPR SLA is 30 days; the appendix v0 default is 14 days. The
service stamps a ``due_at`` so a cron sweep can surface
overdue requests.
"""

from __future__ import annotations

import hashlib
import json
import logging
from datetime import timedelta
from typing import Any

from eden.services.governance_intel._common import (
    _bad_request_envelope,
    _get_client,
    _maybe_await,
    _new_id,
    _now,
    _now_iso,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


#: Default SLA (days) for RTBF processing. GDPR mandates 30;
#: Eden's v0 ships a tighter 14-day default. Tenants can
#: configure higher via ``organizations.features.rtbf_sla_days``.
DEFAULT_RTBF_SLA_DAYS: int = 14


#: Tables the v0 RTBF sweep touches. Each entry is
#: ``(table, user_column, anonymise_columns)``. The
#: ``user_column`` is the foreign key to the user being
#: forgotten; ``anonymise_columns`` get rewritten with
#: ``"***"`` for any matching row.
_RTBF_TABLES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("telemetry_events", "user_id", ("payload_json", "metadata_json")),
    ("judge_scores", "user_id", ("raw_input", "raw_output")),
    ("user_feedback", "user_id", ("comment",)),
    ("user_sessions", "user_id", ()),
    ("conversation_messages", "user_id", ("content",)),
    ("conversations", "user_id", ()),
)


class RightToBeForgottenService:
    """Process GDPR Article 17 erasure requests."""

    name = "rtbf"

    async def process_request(
        self,
        org_id: str,
        *,
        user_id: str,
        requested_by: str | None = None,
        sla_days: int = DEFAULT_RTBF_SLA_DAYS,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Anonymise the user across the Cat 10 RTBF table set.

        Args:
            user_id: subject of the erasure.
            requested_by: who filed the request (audit log).
            sla_days: 14 by default. Bounded to ``[1, 90]``.
            dry_run: if True, only counts rows that would be
                touched without writing.
        """
        if not isinstance(user_id, str) or not user_id.strip():
            return _bad_request_envelope(
                self.name, "user_id is required"
            )
        sla_days = max(1, min(90, int(sla_days)))

        anon_id = _anon_id_for(user_id)
        request_id = _new_id("rtbf")
        due_at = _now() + timedelta(days=sla_days)

        client = await _get_client()

        # ── For each table: count then anonymise ────────────────
        per_table: list[dict[str, Any]] = []
        total_rows = 0

        for table, user_col, anon_cols in _RTBF_TABLES:
            count = await self._count_rows(client, table, user_col, org_id, user_id)
            touched = 0
            if count > 0 and not dry_run and client is not None:
                touched = await self._anonymise_table(
                    client, table, user_col, anon_cols,
                    org_id, user_id, anon_id,
                )
            per_table.append({
                "table": table,
                "user_column": user_col,
                "rows_matched": count,
                "rows_anonymised": touched if not dry_run else 0,
                "anonymised_columns": list(anon_cols),
            })
            total_rows += count

        # W9 — cross-store fanout (fail visibly when store missing)
        fanout_results: list[dict[str, Any]] = []
        if not dry_run:
            try:
                from eden.services.governance_intel.rtbf_fanout import fanout_rtbf

                fanout_results = await fanout_rtbf(
                    org_id, user_id=user_id, dry_run=False
                )
            except Exception as exc:
                logger.warning("rtbf fanout crashed: %s", exc)
                fanout_results = [
                    {"store": "*", "status": "failed", "error": str(exc)}
                ]
        else:
            try:
                from eden.services.governance_intel.rtbf_fanout import fanout_rtbf

                fanout_results = await fanout_rtbf(
                    org_id, user_id=user_id, dry_run=True
                )
            except Exception as exc:
                fanout_results = [
                    {"store": "*", "status": "failed", "error": str(exc)}
                ]

        # "unsupported" means the store has no scoped-erasure implementation at
        # all. It must count as incomplete: reporting an erasure as complete
        # when a store was never touched is the failure mode this list exists
        # to prevent.
        fanout_incomplete = [
            r
            for r in fanout_results
            if r.get("status") in ("failed", "unavailable", "unsupported")
        ]

        # Audit log
        if not dry_run and client is not None:
            try:
                await _maybe_await(client.execute(
                    "INSERT INTO org_audit_log "
                    "(org_id, user_id, action, target_type, "
                    "target_id, metadata) VALUES "
                    "($1, $2, $3, $4, $5, $6::jsonb)",
                    org_id,
                    requested_by or org_id,
                    "rtbf.processed",
                    "user",
                    anon_id,  # store the hashed id; original user_id is gone
                    json.dumps({
                        "request_id": request_id,
                        "tables": [p["table"] for p in per_table],
                        "total_rows": total_rows,
                        "sla_days": sla_days,
                        "fanout": fanout_results,
                        "fanout_incomplete": len(fanout_incomplete) > 0,
                    }),
                ))
            except Exception as exc:
                logger.debug("rtbf.audit_log failed: %s", exc)

        return _ok_envelope(
            self.name,
            {
                "request_id": request_id,
                "user_id_hash": anon_id,
                "requested_by": requested_by,
                "due_at": due_at.isoformat(),
                "sla_days": sla_days,
                "dry_run": dry_run,
                "tables": per_table,
                "total_rows_matched": total_rows,
                "total_rows_anonymised": (
                    sum(p["rows_anonymised"] for p in per_table)
                    if not dry_run else 0
                ),
                "fanout": fanout_results,
                "fanout_complete": len(fanout_incomplete) == 0,
                "fanout_incomplete": fanout_incomplete,
                "processed_at": _now_iso(),
            },
        )

    # ── Helpers ──────────────────────────────────────────────────

    async def _count_rows(
        self,
        client: Any,
        table: str,
        user_col: str,
        org_id: str,
        user_id: str,
    ) -> int:
        if client is None:
            return 0
        sql = (
            f"SELECT COUNT(*) AS count FROM {table} "
            f"WHERE org_id = $1 AND {user_col} = $2"
        )
        try:
            rows = await client.fetch(sql, org_id, user_id)
        except Exception as exc:
            logger.debug(
                "rtbf count failed for %s: %s", table, exc
            )
            return 0
        if not rows:
            return 0
        row = rows[0]
        return int(row.get("count") or next(iter(row.values()), 0) or 0)

    async def _anonymise_table(
        self,
        client: Any,
        table: str,
        user_col: str,
        anon_cols: tuple[str, ...],
        org_id: str,
        user_id: str,
        anon_id: str,
    ) -> int:
        """Issue the UPDATE that anonymises ``anon_cols`` + sets
        ``user_col`` to the hashed id. Returns the affected count
        on a best-effort basis (the driver's affected-count
        signalling isn't portable — we re-count after).
        """
        # 1. Overwrite content columns
        for col in anon_cols:
            sql = (
                f"UPDATE {table} SET {col} = '***' "
                f"WHERE org_id = $1 AND {user_col} = $2"
            )
            try:
                await _maybe_await(client.execute(
                    sql, org_id, user_id,
                ))
            except Exception as exc:
                logger.debug(
                    "rtbf anonymise content failed for %s.%s: %s",
                    table, col, exc,
                )
        # 2. Re-key the user column to the hashed id
        sql = (
            f"UPDATE {table} SET {user_col} = $1 "
            f"WHERE org_id = $2 AND {user_col} = $3"
        )
        try:
            await _maybe_await(client.execute(
                sql, anon_id, org_id, user_id,
            ))
        except Exception as exc:
            logger.debug(
                "rtbf rekey failed for %s.%s: %s",
                table, user_col, exc,
            )
        # Count what's now keyed to the anon id (the post-state)
        try:
            rows = await client.fetch(
                f"SELECT COUNT(*) AS count FROM {table} "
                f"WHERE org_id = $1 AND {user_col} = $2",
                org_id, anon_id,
            )
        except Exception as exc:
            logger.debug(
                "rtbf post-count failed for %s: %s", table, exc
            )
            return 0
        if not rows:
            return 0
        row = rows[0]
        return int(row.get("count") or next(iter(row.values()), 0) or 0)


def _anon_id_for(user_id: str) -> str:
    """Stable SHA-256 hash of the user_id with a Cat 10 namespace
    prefix. Deterministic so re-running RTBF (e.g., a retry after
    a child-system webhook failure) hits the same key.

    Format: ``"anon_<sha256[:16]>"``. The full 64-char digest
    would overflow the ``VARCHAR(128)`` user-id columns when
    combined with the existing prefix conventions.
    """
    digest = hashlib.sha256(
        f"gdpr_rtbf:{user_id}".encode()
    ).hexdigest()
    return f"anon_{digest[:16]}"
