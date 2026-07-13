"""Production trace → regression eval case builder (N01)."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class RegressionCase:
    id: str
    org_id: str
    dataset_id: str
    source_issue_id: str | None
    source_trace_id: str | None
    fingerprint: str | None
    auto_generated: bool
    input_data: dict[str, Any] = field(default_factory=dict)
    expected_data: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "dataset_id": self.dataset_id,
            "source_issue_id": self.source_issue_id,
            "source_trace_id": self.source_trace_id,
            "fingerprint": self.fingerprint,
            "auto_generated": self.auto_generated,
            "input": self.input_data,
            "expected": self.expected_data,
            "metadata": self.metadata,
            "created_at": self.created_at,
        }


class RegressionCaseBuilder:
    """Materialize regression eval cases from resolved issues."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg
        self._memory: list[RegressionCase] = []

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def from_issue(
        self,
        org_id: str,
        issue_id: str,
        *,
        max_traces: int = 3,
        auto: bool = True,
    ) -> list[RegressionCase]:
        """Build regression cases from an issue's example traces."""
        try:
            from eden.issues.repo import IssuesRepo

            issue = await IssuesRepo().get_issue(org_id, issue_id)
        except Exception as exc:
            logger.debug("regression_builder load issue: %s", exc)
            return []
        if issue is None:
            return []

        fingerprint = _issue_fingerprint(issue.kind, issue.fingerprint)
        existing = await self._find_by_fingerprint(org_id, fingerprint)
        if existing:
            return [existing]

        trace_ids = await self._trace_ids_for_issue(org_id, issue, max_traces)
        created: list[RegressionCase] = []
        for tid in trace_ids:
            case = RegressionCase(
                id=str(uuid.uuid4()),
                org_id=org_id,
                dataset_id=_dataset_name(issue.agent_id),
                source_issue_id=issue_id,
                source_trace_id=tid,
                fingerprint=fingerprint if not created else f"{fingerprint}:{tid[:8]}",
                auto_generated=auto,
                input_data=await self._trace_input(tid),
                expected_data={
                    "no_stumble_kinds": [issue.kind],
                    "statgate_pass": True,
                },
                metadata={
                    "source_issue_id": issue_id,
                    "source_trace_ids": trace_ids,
                    "fingerprint": fingerprint,
                    "auto_generated": auto,
                    "triage_summary": (issue.triage_result or {}).get("summary")
                    or issue.title,
                },
            )
            await self._persist(case)
            created.append(case)
        return created

    async def list_cases(
        self,
        org_id: str,
        *,
        agent_id: str | None = None,
        limit: int = 50,
    ) -> list[RegressionCase]:
        client = await self._client()
        if client is None:
            rows = [c for c in self._memory if c.org_id == org_id]
            if agent_id:
                prefix = _dataset_name(agent_id)
                rows = [c for c in rows if c.dataset_id == prefix]
            return rows[:limit]
        try:
            rows = await client.fetch(
                """
                SELECT id, org_id, dataset_id, source_issue_id, source_trace_id,
                       fingerprint, auto_generated, input_data, expected_data,
                       metadata, created_at
                FROM regression_eval_cases
                WHERE org_id = $1
                  AND ($2::text IS NULL OR dataset_id = $2)
                ORDER BY created_at DESC
                LIMIT $3
                """,
                org_id,
                _dataset_name(agent_id) if agent_id else None,
                limit,
            )
            return [_row_to_case(dict(r)) for r in rows]
        except Exception as exc:
            logger.debug("list_cases failed: %s", exc)
            return []

    async def _find_by_fingerprint(
        self, org_id: str, fingerprint: str
    ) -> RegressionCase | None:
        client = await self._client()
        if client is None:
            for c in self._memory:
                if c.org_id == org_id and c.fingerprint == fingerprint:
                    return c
            return None
        row = await client.fetchrow(
            """
            SELECT id, org_id, dataset_id, source_issue_id, source_trace_id,
                   fingerprint, auto_generated, input_data, expected_data,
                   metadata, created_at
            FROM regression_eval_cases
            WHERE org_id = $1 AND fingerprint = $2
            LIMIT 1
            """,
            org_id,
            fingerprint,
        )
        return _row_to_case(dict(row)) if row else None

    async def _trace_ids_for_issue(
        self, org_id: str, issue: Any, max_traces: int
    ) -> list[str]:
        ids: list[str] = []
        for sid in issue.example_stumble_ids or []:
            if len(ids) >= max_traces:
                break
        try:
            from eden.issues.repo import IssuesRepo

            stumbles = await IssuesRepo().list_stumbles(
                org_id, fingerprint=issue.fingerprint, limit=max_traces
            )
            for s in stumbles or []:
                tid = getattr(s, "trace_id", None) or (
                    s.get("trace_id") if isinstance(s, dict) else None
                )
                if tid and tid not in ids:
                    ids.append(str(tid))
        except Exception as exc:
            logger.debug("stumbles for regression: %s", exc)
        triage = issue.triage_result or {}
        for key in ("trace_id", "example_trace_id"):
            val = triage.get(key)
            if val and str(val) not in ids:
                ids.append(str(val))
        return ids[:max_traces]

    async def _trace_input(self, trace_id: str) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            return {"trace_id": trace_id, "messages": []}
        try:
            row = await client.fetchrow(
                """
                SELECT payload
                FROM telemetry_events
                WHERE trace_id = $1
                ORDER BY timestamp ASC
                LIMIT 1
                """,
                trace_id,
            )
            if row and row.get("payload"):
                payload = row["payload"]
                if isinstance(payload, str):
                    payload = json.loads(payload)
                if isinstance(payload, dict):
                    return {"trace_id": trace_id, "messages": payload.get("messages", [])}
        except Exception:
            pass
        return {"trace_id": trace_id, "messages": []}

    async def _persist(self, case: RegressionCase) -> None:
        self._memory.append(case)
        client = await self._client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO regression_eval_cases (
                id, org_id, dataset_id, source_issue_id, source_trace_id,
                fingerprint, auto_generated, input_data, expected_data, metadata
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
            ON CONFLICT DO NOTHING
            """,
            case.id,
            case.org_id,
            case.dataset_id,
            case.source_issue_id,
            case.source_trace_id,
            case.fingerprint,
            case.auto_generated,
            json.dumps(case.input_data),
            json.dumps(case.expected_data),
            json.dumps(case.metadata),
        )


async def on_issue_resolved(
    org_id: str, issue_id: str, *, auto: bool = True
) -> list[dict[str, Any]]:
    """Hook for issue.resolved — auto-create regression cases."""
    builder = RegressionCaseBuilder()
    cases = await builder.from_issue(org_id, issue_id, auto=auto)
    return [c.to_dict() for c in cases]


def _issue_fingerprint(kind: str, fp: str) -> str:
    raw = f"{kind}:{fp}".encode()
    return hashlib.sha256(raw).hexdigest()[:32]


def _dataset_name(agent_id: str | None) -> str:
    if not agent_id:
        return "agent-regressions"
    safe = agent_id.replace("/", "-").replace(" ", "-")
    return f"{safe}/regressions"


def _row_to_case(row: dict[str, Any]) -> RegressionCase:
    for key in ("input_data", "expected_data", "metadata"):
        val = row.get(key)
        if isinstance(val, str):
            row[key] = json.loads(val)
    created = row.get("created_at")
    created_iso = (
        created.isoformat()
        if hasattr(created, "isoformat")
        else str(created or "")
    )
    return RegressionCase(
        id=str(row["id"]),
        org_id=row["org_id"],
        dataset_id=row.get("dataset_id") or "agent-regressions",
        source_issue_id=str(row["source_issue_id"])
        if row.get("source_issue_id")
        else None,
        source_trace_id=row.get("source_trace_id"),
        fingerprint=row.get("fingerprint"),
        auto_generated=bool(row.get("auto_generated")),
        input_data=dict(row.get("input_data") or {}),
        expected_data=dict(row.get("expected_data") or {}),
        metadata=dict(row.get("metadata") or {}),
        created_at=created_iso,
    )


__all__ = [
    "RegressionCase",
    "RegressionCaseBuilder",
    "on_issue_resolved",
]
