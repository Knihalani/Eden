"""Cat 10 v2 — :class:`RightToBeForgottenService`.

GDPR Article 17 (Right to Erasure) compliance. Processes RTBF
requests for a given ``user_id``:

1. Anonymise the user's traces in ``telemetry_events`` —
   content columns (payload, request/response bodies, reasoning,
   tool calls) are overwritten with ``"***"`` and their zstd
   shadow copies NULLed; the row stays so aggregate analytics
   still reflect the activity (the appendix's "preserve outcome
   counts but lose identity" stance). ``telemetry_events`` has no
   ``user_id`` column; end-user identity lives in ``attributes``
   under decoder-specific keys (see ``_TELEMETRY_USER_KEYS``).
2. Anonymise ``judge_scores.rationale`` for the user's traces
   (``judge_scores`` has no user column; scope is derived from
   the trace_ids gathered in step 1 — gathered *before* the
   telemetry scrub strips the attributes the lookup needs).
3. Anonymise ``user_feedback`` rows (Cat 9 table).
4. Anonymise ``user_sessions`` (Cat 9 table) — replace user_id
   with the SHA256-hashed anonymous id.
5. Anonymise ``conversation_messages.content`` via the user's
   conversation ids (``conversation_messages`` has no user
   column), then re-key + scrub the ``conversations`` rows.
6. Audit-log the RTBF action with full lineage (which tables
   touched, how many rows, who requested, when).

Fail-closed: a SQL error on any table does NOT silently report
``rows_matched: 0`` — the request returns an ``error`` envelope
naming the failed table(s), so an erasure is never certified as
complete when part of it did not run.

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
from dataclasses import dataclass, field
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


#: Tables the v0 RTBF sweep touches, in processing order.
#: Per-table SQL lives in the ``_count_*`` / ``_anonymise_*``
#: helpers below — the org column (``tenant_id`` vs ``org_id``),
#: the user-matching predicate and the anonymised columns all
#: differ per table and were verified against live
#: ``information_schema`` on 2026-08-02.
_RTBF_TABLES: tuple[str, ...] = (
    "telemetry_events",
    "judge_scores",
    "user_feedback",
    "user_sessions",
    "conversation_messages",
    "conversations",
)

#: ``attributes`` JSONB keys under which ingesters record the
#: end-user identity on a telemetry event. Eden's own SDK does
#: not stamp a user id; the keys below come from the Langfuse /
#: Helicone decoders plus the OTel ``enduser.id`` convention and
#: the plain ``user_id`` key future-first-party ingesters should
#: use.
_TELEMETRY_USER_KEYS: tuple[str, ...] = (
    "user_id",
    "langfuse.user_id",
    "helicone.user_id",
    "enduser.id",
)

#: telemetry_events content columns scrubbed to ``'"***"'::jsonb``.
_TELEMETRY_JSONB_SCRUB_COLS: tuple[str, ...] = (
    "payload",
    "request_body",
    "response_body",
    "reasoning",
    "tool_calls_full",
    "tool_results",
)

#: telemetry_events columns nulled outright (bytea zstd shadows
#: of the scrubbed JSONB, plus misc content blobs).
_TELEMETRY_NULL_COLS: tuple[str, ...] = (
    "images",
    "audio",
    "logprobs",
    "citations",
    "payload_zstd",
    "request_body_zstd",
    "response_body_zstd",
    "reasoning_zstd",
    "tool_calls_full_zstd",
    "tool_results_zstd",
    "attributes_zstd",
)


def _telemetry_user_clause(param: str) -> str:
    """SQL predicate matching any known user-id attribute key."""
    return " OR ".join(
        f"attributes->>'{key}' = {param}" for key in _TELEMETRY_USER_KEYS
    )


def _error_envelope(
    feature: str, message: str, data: dict[str, Any]
) -> dict[str, Any]:
    """Fail-closed envelope — same shape as the ``ok`` envelope so
    the front-end renders it, but ``status="error"`` so a partial
    erasure can never be mistaken for a completed one."""
    return {
        "status": "error",
        "feature": feature,
        "live": True,
        "trace_id": _new_id("gov"),
        "timestamp": _now_iso(),
        "data": {**data, "message": message},
    }


@dataclass(frozen=True)
class _RtbfScope:
    """Cross-table erasure scope, derived before any writes."""

    trace_ids: list[str] = field(default_factory=list)
    conversation_ids: list[Any] = field(default_factory=list)


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
        if client is None:
            return _error_envelope(
                self.name,
                "postgres unavailable — no erasure performed",
                {
                    "request_id": request_id,
                    "dry_run": dry_run,
                    "complete": False,
                },
            )

        # ── Derive cross-table scope FIRST ──────────────────────
        # judge_scores has no user column; it is scoped through the
        # user's telemetry trace_ids. conversation_messages has no
        # user column; it is scoped through the user's conversation
        # ids. Both lookups must run BEFORE any anonymisation —
        # scrubbing telemetry attributes or re-keying conversations
        # first would make the lookups match nothing.
        try:
            trace_ids = await self._user_trace_ids(client, org_id, user_id)
            conversation_ids = await self._user_conversation_ids(
                client, org_id, user_id
            )
        except Exception as exc:
            logger.warning("rtbf scope derivation failed: %s", exc)
            return _error_envelope(
                self.name,
                f"failed to derive per-user scope: {exc}",
                {
                    "request_id": request_id,
                    "dry_run": dry_run,
                    "complete": False,
                },
            )
        ctx = _RtbfScope(trace_ids=trace_ids, conversation_ids=conversation_ids)

        # ── For each table: count then anonymise ────────────────
        per_table: list[dict[str, Any]] = []
        failures: list[dict[str, str]] = []
        total_rows = 0

        for table in _RTBF_TABLES:
            try:
                count = await self._count_rows(client, table, org_id, user_id, ctx)
                touched = 0
                if count > 0 and not dry_run:
                    touched = await self._anonymise_table(
                        client, table, org_id, user_id, anon_id, ctx
                    )
            except Exception as exc:
                logger.warning("rtbf failed for %s: %s", table, exc)
                failures.append({"table": table, "error": str(exc)[:300]})
                per_table.append({
                    "table": table,
                    "status": "failed",
                    "rows_matched": 0,
                    "rows_anonymised": 0,
                })
                continue
            per_table.append({
                "table": table,
                "status": "ok",
                "rows_matched": count,
                "rows_anonymised": touched if not dry_run else 0,
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
                        "failures": failures,
                        "fanout": fanout_results,
                        "fanout_incomplete": len(fanout_incomplete) > 0,
                    }),
                ))
            except Exception as exc:
                logger.debug("rtbf.audit_log failed: %s", exc)

        data: dict[str, Any] = {
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
        }
        if failures:
            data["failures"] = failures
            data["complete"] = False
            return _error_envelope(
                self.name,
                f"erasure incomplete — {len(failures)} table(s) failed: "
                + ", ".join(f["table"] for f in failures),
                data,
            )
        data["complete"] = len(fanout_incomplete) == 0
        return _ok_envelope(self.name, data)

    # ── Scope derivation ─────────────────────────────────────────

    async def _user_trace_ids(
        self, client: Any, org_id: str, user_id: str
    ) -> list[str]:
        """trace_ids of the user's telemetry events. Also the scope
        for ``judge_scores``, which carries no user column."""
        rows = await client.fetch(
            "SELECT DISTINCT trace_id FROM telemetry_events "
            f"WHERE tenant_id = $1 AND ({_telemetry_user_clause('$2')})",
            org_id,
            user_id,
        )
        return [str(r["trace_id"]) for r in rows or [] if r.get("trace_id")]

    async def _user_conversation_ids(
        self, client: Any, org_id: str, user_id: str
    ) -> list[Any]:
        """ids of the user's conversations. Scope for
        ``conversation_messages``, which carries no user column."""
        rows = await client.fetch(
            "SELECT id FROM conversations "
            "WHERE org_id = $1 AND user_id = $2",
            org_id,
            user_id,
        )
        return [r["id"] for r in rows or [] if r.get("id") is not None]

    # ── Per-table count / anonymise ──────────────────────────────

    async def _count_rows(
        self,
        client: Any,
        table: str,
        org_id: str,
        user_id: str,
        ctx: _RtbfScope,
    ) -> int:
        sql, args = self._count_sql(table, org_id, user_id, ctx)
        if sql is None:
            return 0
        rows = await client.fetch(sql, *args)
        if not rows:
            return 0
        row = rows[0]
        return int(row.get("count") or next(iter(row.values()), 0) or 0)

    def _count_sql(
        self,
        table: str,
        org_id: str,
        user_id: str,
        ctx: _RtbfScope,
    ) -> tuple[str | None, tuple[Any, ...]]:
        if table == "telemetry_events":
            return (
                "SELECT COUNT(*) AS count FROM telemetry_events "
                f"WHERE tenant_id = $1 AND ({_telemetry_user_clause('$2')})"
            ), (org_id, user_id)
        if table == "judge_scores":
            if not ctx.trace_ids:
                return None, ()
            return (
                "SELECT COUNT(*) AS count FROM judge_scores "
                "WHERE tenant_id = $1 AND trace_id = ANY($2)"
            ), (org_id, ctx.trace_ids)
        if table == "conversation_messages":
            if not ctx.conversation_ids:
                return None, ()
            return (
                "SELECT COUNT(*) AS count FROM conversation_messages "
                "WHERE org_id = $1 AND conversation_id = ANY($2)"
            ), (org_id, ctx.conversation_ids)
        # user_feedback / user_sessions / conversations: plain
        # org_id + user_id keying (verified against live schema).
        return (
            f"SELECT COUNT(*) AS count FROM {table} "
            "WHERE org_id = $1 AND user_id = $2"
        ), (org_id, user_id)

    async def _anonymise_table(
        self,
        client: Any,
        table: str,
        org_id: str,
        user_id: str,
        anon_id: str,
        ctx: _RtbfScope,
    ) -> int:
        """Anonymise one table; returns rows matched by the
        preceding count (the UPDATE either succeeds — touching
        exactly those rows — or raises into the fail-closed path).
        """
        statements = self._anonymise_sql(table)
        if table == "telemetry_events":
            args: tuple[Any, ...] = (org_id, user_id)
        elif table == "judge_scores":
            if not ctx.trace_ids:
                return 0
            args = (org_id, ctx.trace_ids)
        elif table == "conversation_messages":
            if not ctx.conversation_ids:
                return 0
            args = (org_id, ctx.conversation_ids)
        else:
            args = (anon_id, org_id, user_id)
        count = await self._count_rows(client, table, org_id, user_id, ctx)
        for sql in statements:
            await _maybe_await(client.execute(sql, *args))
        return count

    def _anonymise_sql(self, table: str) -> tuple[str, ...]:
        if table == "telemetry_events":
            jsonb_sets = ", ".join(
                f"{col} = '\"***\"'::jsonb"
                for col in _TELEMETRY_JSONB_SCRUB_COLS
            )
            null_sets = ", ".join(
                f"{col} = NULL" for col in _TELEMETRY_NULL_COLS
            )
            attr_strip = " - ".join(
                [""] + [f"'{k}'" for k in _TELEMETRY_USER_KEYS]
            )
            return (
                "UPDATE telemetry_events SET "
                f"{jsonb_sets}, {null_sets}, "
                f"attributes = attributes{attr_strip} "
                f"WHERE tenant_id = $1 AND ({_telemetry_user_clause('$2')})",
            )
        if table == "judge_scores":
            return (
                "UPDATE judge_scores SET rationale = '***' "
                "WHERE tenant_id = $1 AND trace_id = ANY($2)",
            )
        if table == "user_feedback":
            return (
                "UPDATE user_feedback SET comment = '***', user_id = $1 "
                "WHERE org_id = $2 AND user_id = $3",
            )
        if table == "user_sessions":
            return (
                "UPDATE user_sessions SET user_id = $1 "
                "WHERE org_id = $2 AND user_id = $3",
            )
        if table == "conversation_messages":
            return (
                "UPDATE conversation_messages SET content = '***' "
                "WHERE org_id = $1 AND conversation_id = ANY($2)",
            )
        # conversations — title is free text that can echo user
        # content, so it is scrubbed alongside the re-key.
        return (
            "UPDATE conversations SET user_id = $1, title = '***' "
            "WHERE org_id = $2 AND user_id = $3",
        )


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
