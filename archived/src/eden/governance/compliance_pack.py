"""N06 — agent audit ledger + compliance pack automation."""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


class AgentAuditLedgerWriter:
    """Append-only agent audit ledger with hash chain (N06)."""

    name = "agent_audit_ledger"

    async def write(
        self,
        org_id: str,
        event_type: str,
        *,
        event_subtype: str | None = None,
        agent_id: str | None = None,
        actor_id: str | None = None,
        actor_type: str = "system",
        payload: dict[str, Any] | None = None,
        compliance_tags: list[str] | None = None,
    ) -> str | None:
        client = await self._client()
        if client is None:
            return None
        entry_id = str(uuid.uuid4())
        body = payload or {}
        prev_hash = await self._last_hash(org_id)
        created_at = datetime.now(UTC).isoformat()
        canonical = json.dumps(body, sort_keys=True, default=str)
        entry_hash = hashlib.sha256(
            f"{prev_hash or ''}:{canonical}:{created_at}".encode()
        ).hexdigest()
        try:
            await client.execute(
                "INSERT INTO agent_audit_ledger "
                "(id, org_id, event_type, event_subtype, agent_id, "
                "actor_id, actor_type, payload, prev_hash, entry_hash, "
                "compliance_tags, created_at) "
                "VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, "
                "$9, $10, $11, NOW())",
                entry_id,
                org_id,
                event_type,
                event_subtype,
                agent_id,
                actor_id,
                actor_type,
                json.dumps(body),
                prev_hash,
                entry_hash,
                compliance_tags or [],
            )
            return entry_id
        except Exception as exc:
            logger.debug("agent_audit_ledger.write failed: %s", exc)
            return None

    async def _last_hash(self, org_id: str) -> str | None:
        client = await self._client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                "SELECT entry_hash FROM agent_audit_ledger "
                "WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1",
                org_id,
            )
            return row["entry_hash"] if row else None
        except Exception:
            return None

    async def verify_chain(
        self,
        org_id: str,
        *,
        agent_id: str | None = None,
        limit: int = 500,
    ) -> dict[str, Any]:
        """Recompute hash chain for tamper-evidence attestation (N06)."""
        events = await self.query(
            org_id, agent_id=agent_id, limit=limit
        )
        chronological = list(reversed(events))
        prev_hash: str | None = None
        ok_rows = 0
        broken: list[dict[str, Any]] = []
        for entry in chronological:
            payload = entry.get("payload") or {}
            created_at = entry.get("created_at") or ""
            if hasattr(created_at, "isoformat"):
                created_at = created_at.isoformat()
            canonical = json.dumps(payload, sort_keys=True, default=str)
            expected = hashlib.sha256(
                f"{prev_hash or ''}:{canonical}:{created_at}".encode()
            ).hexdigest()
            actual = entry.get("entry_hash") or ""
            stored_prev = entry.get("prev_hash")
            if actual == expected and stored_prev == prev_hash:
                ok_rows += 1
            else:
                broken.append(
                    {
                        "id": entry.get("id"),
                        "expected_hash": expected,
                        "actual_hash": actual,
                        "prev_hash_ok": stored_prev == prev_hash,
                    }
                )
            prev_hash = actual
        total = len(chronological)
        return {
            "total_rows": total,
            "ok_rows": ok_rows,
            "broken_rows": len(broken),
            "verified": total > 0 and len(broken) == 0,
            "broken": broken[:20],
        }

    async def query(
        self,
        org_id: str,
        *,
        agent_id: str | None = None,
        event_type: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            raise RuntimeError("postgres unavailable")
        clauses = ["org_id = $1"]
        args: list[Any] = [org_id]
        if agent_id:
            args.append(agent_id)
            clauses.append(f"agent_id = ${len(args)}")
        if event_type:
            args.append(event_type)
            clauses.append(f"event_type = ${len(args)}")
        args.append(limit)
        sql = (
            "SELECT id, event_type, event_subtype, agent_id, actor_id, "
            "actor_type, payload, prev_hash, entry_hash, compliance_tags, created_at "
            "FROM agent_audit_ledger WHERE "
            + " AND ".join(clauses)
            + f" ORDER BY created_at DESC LIMIT ${len(args)}"
        )
        try:
            rows = await client.fetch(sql, *args)
            out = []
            for r in rows:
                d = dict(r)
                if d.get("created_at"):
                    d["created_at"] = d["created_at"].isoformat()
                d["id"] = str(d["id"])
                d["prev_hash"] = d.get("prev_hash")
                if isinstance(d.get("payload"), str):
                    with contextlib.suppress(Exception):
                        d["payload"] = json.loads(d["payload"])
                out.append(d)
            return out
        except Exception as exc:
            # Do not swallow as [] — portal would show a false empty state.
            logger.warning("agent_audit_ledger.query failed: %s", exc)
            raise

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None


class CompliancePackGenerator:
    """One-click agent compliance pack (extends N06 / Cat 10)."""

    name = "compliance_pack"

    async def generate_agent_pack(
        self,
        org_id: str,
        agent_id: str,
        *,
        period_start: str,
        period_end: str,
        framework: str = "soc2_type_ii",
        generated_by: str | None = None,
    ) -> dict[str, Any]:
        from eden.services.governance_intel import ComplianceEvidenceGenerator

        base = await ComplianceEvidenceGenerator().generate(
            org_id,
            framework=framework,
            period_start=period_start,
            period_end=period_end,
            generated_by=generated_by,
        )
        ledger = AgentAuditLedgerWriter()
        agent_events = await ledger.query(org_id, agent_id=agent_id, limit=500)
        heal_events = [
            e for e in agent_events if e.get("event_type") in ("autonomous", "runtime")
        ]
        attestation = await ledger.verify_chain(org_id, agent_id=agent_id, limit=500)
        pack_id = str(uuid.uuid4())
        enriched = {
            "pack_id": pack_id,
            "agent_id": agent_id,
            "framework": framework,
            "period_start": period_start,
            "period_end": period_end,
            "base_evidence": (base.get("data") if isinstance(base, dict) else base),
            "agent_audit_events": agent_events,
            "heal_history": heal_events,
            "chain_attestation": {
                "event_count": len(agent_events),
                "verified": attestation.get("verified", False),
                "ok_rows": attestation.get("ok_rows", 0),
                "broken_rows": attestation.get("broken_rows", 0),
            },
            "generated_at": datetime.now(UTC).isoformat(),
            "generated_by": generated_by or "system",
        }
        await ledger.write(
            org_id,
            "compliance",
            event_subtype="pack_export",
            agent_id=agent_id,
            actor_id=generated_by,
            actor_type="user" if generated_by else "system",
            payload={"pack_id": pack_id, "framework": framework},
            compliance_tags=["soc2", framework],
        )
        return {"status": "ok", "feature": self.name, "data": enriched}
