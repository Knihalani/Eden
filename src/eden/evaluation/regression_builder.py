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

    def __init__(self, pg: Any | None = None, *, memory_only: bool = False) -> None:
        self._pg = pg
        self._memory_only = memory_only
        self._memory: list[RegressionCase] = []

    async def _client(self) -> Any | None:
        if self._memory_only:
            return None
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def list_for_issue(
        self, org_id: str, issue_id: str
    ) -> list[RegressionCase]:
        """Return permanent regression cases linked to an issue (D7)."""
        memory_hits = [
            c
            for c in self._memory
            if c.org_id == org_id and c.source_issue_id == issue_id
        ]
        client = await self._client()
        if client is None:
            return memory_hits
        rows = await client.fetch(
            """
            SELECT di.id, di.org_id, d.name AS dataset_name,
                   di.origin_issue_id AS source_issue_id,
                   di.origin_trace_id AS source_trace_id,
                   di.fingerprint, di.auto_generated, di.input,
                   di.expected_output, di.payload, di.created_at
            FROM dataset_items di
            JOIN datasets d ON d.id = di.dataset_id
            WHERE di.org_id = $1 AND di.origin_issue_id = $2
            ORDER BY di.created_at DESC
            """,
            org_id,
            issue_id,
        )
        db_cases = [_dataset_item_row_to_case(dict(r)) for r in rows]
        if memory_hits:
            seen = {c.id for c in db_cases}
            for c in memory_hits:
                if c.id not in seen:
                    db_cases.append(c)
        return db_cases

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
                SELECT di.id, di.org_id, d.name AS dataset_name,
                       di.origin_issue_id AS source_issue_id,
                       di.origin_trace_id AS source_trace_id,
                       di.fingerprint, di.auto_generated, di.input,
                       di.expected_output, di.payload, di.created_at
                FROM dataset_items di
                JOIN datasets d ON d.id = di.dataset_id
                WHERE di.org_id = $1
                  AND ($2::text IS NULL OR d.name = $2)
                ORDER BY di.created_at DESC
                LIMIT $3
                """,
                org_id,
                _dataset_name(agent_id) if agent_id else None,
                limit,
            )
            return [_dataset_item_row_to_case(dict(r)) for r in rows]
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
            SELECT di.id, di.org_id, d.name AS dataset_name,
                   di.origin_issue_id AS source_issue_id,
                   di.origin_trace_id AS source_trace_id,
                   di.fingerprint, di.auto_generated, di.input,
                   di.expected_output, di.payload, di.created_at
            FROM dataset_items di
            JOIN datasets d ON d.id = di.dataset_id
            WHERE di.org_id = $1 AND di.fingerprint = $2
            LIMIT 1
            """,
            org_id,
            fingerprint,
        )
        return _dataset_item_row_to_case(dict(row)) if row else None

    async def _trace_ids_for_issue(
        self, org_id: str, issue: Any, max_traces: int
    ) -> list[str]:
        ids: list[str] = []
        # A loop over ``issue.example_stumble_ids`` used to sit here whose
        # body had been lost to a refactor — it iterated and broke without
        # ever touching ``ids``, so it was pure spin. Deleted rather than
        # "completed": those are stumble ids, not trace ids, and resolving
        # stumbles to traces is exactly what the list_stumbles call below
        # already does correctly.
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

        # Legacy table (092): a free-text ``dataset_id`` VARCHAR that can
        # never join to the UUID-keyed ``datasets``/``dataset_items``
        # system (F53). Kept as a best-effort compatibility write only
        # because ``ClosedLoopOrchestrator._enrich_cases_for_replay``
        # still ``UPDATE``s it by id — nothing reads it as the source of
        # truth any more; see ``_find_by_fingerprint``/``list_cases``/
        # ``list_for_issue`` below, which are now on ``dataset_items``.
        try:
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
        except Exception as exc:
            logger.debug("regression_builder legacy persist failed: %s", exc)

        # Canonical (FEAT-74): resolve the free-text dataset name (e.g.
        # "checkout/regressions") to a real UUID ``datasets`` row via the
        # F53 hub, then write the case into ``dataset_items`` under it —
        # this is what makes regression cases finally joinable to the
        # rest of the dataset system.
        dataset_id = await self._resolve_dataset_id(client, case.org_id, case.dataset_id)
        if dataset_id is None:
            logger.debug(
                "regression_builder: could not resolve dataset for org=%s name=%s; "
                "case %s only persisted to legacy table",
                case.org_id,
                case.dataset_id,
                case.id,
            )
            return
        try:
            await client.execute(
                """
                INSERT INTO dataset_items (
                    id, dataset_id, input, expected_output, payload,
                    origin_trace_id, origin_issue_id, org_id, fingerprint,
                    auto_generated
                ) VALUES (
                    $1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8, $9, $10
                )
                ON CONFLICT DO NOTHING
                """,
                case.id,
                dataset_id,
                json.dumps(case.input_data),
                json.dumps(case.expected_data),
                json.dumps(case.metadata),
                case.source_trace_id,
                case.source_issue_id,
                case.org_id,
                case.fingerprint,
                case.auto_generated,
            )
        except Exception as exc:
            logger.debug("regression_builder dataset_items persist failed: %s", exc)

    async def _resolve_dataset_id(
        self, client: Any, org_id: str, name: str
    ) -> str | None:
        """Resolve — or lazily create — the UUID ``datasets`` row for ``name``.

        ``name`` is the free-text identifier (e.g. ``"checkout/regressions"``)
        that used to be written straight into
        ``regression_eval_cases.dataset_id``. Looking it up (or creating
        it) through ``DatasetHub`` gives regression cases a real UUID
        ``dataset_id`` while ``datasets.name`` keeps the original string
        around for display/lookup, mirroring how ``DatasetHub.promote_trace``
        resolves a dataset by name.
        """
        try:
            from eden.datasets.hub import DatasetHub

            hub = DatasetHub(pg=client)
            existing = await hub.list_datasets(org_id, limit=500)
            match = next((d for d in existing if d.name == name), None)
            if match:
                return match.id
            created = await hub.create_dataset(
                org_id,
                name=name,
                description="Auto-created for N01 regression cases",
                source_type="regression",
            )
            return created.id
        except Exception as exc:
            logger.debug(
                "regression_builder dataset resolve failed org=%s name=%s: %s",
                org_id,
                name,
                exc,
            )
            return None


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


def _loads_json_object(val: Any) -> dict[str, Any]:
    """Best-effort decode of a JSON object stored as text or jsonb."""
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val:
        try:
            loaded = json.loads(val)
        except (TypeError, ValueError):
            return {}
        if isinstance(loaded, dict):
            return loaded
    return {}


def _dataset_item_row_to_case(row: dict[str, Any]) -> RegressionCase:
    """Map a ``dataset_items`` (joined to ``datasets``) row to a case.

    ``dataset_items.input``/``expected_output`` are ``TEXT`` columns
    holding JSON-serialized dicts (see ``RegressionCaseBuilder._persist``);
    ``payload`` is the case ``metadata`` JSONB. ``dataset_name`` is
    ``datasets.name`` — the free-text identifier regression cases used
    to store directly as ``dataset_id`` — kept as ``RegressionCase.dataset_id``
    for API/display compatibility even though storage now keys off the
    UUID ``dataset_items.dataset_id``.
    """
    created = row.get("created_at")
    created_iso = (
        created.isoformat()
        if hasattr(created, "isoformat")
        else str(created or "")
    )
    return RegressionCase(
        id=str(row["id"]),
        org_id=row["org_id"],
        dataset_id=row.get("dataset_name") or "agent-regressions",
        source_issue_id=row.get("source_issue_id") or None,
        source_trace_id=row.get("source_trace_id") or None,
        fingerprint=row.get("fingerprint"),
        auto_generated=bool(row.get("auto_generated")),
        input_data=_loads_json_object(row.get("input")),
        expected_data=_loads_json_object(row.get("expected_output")),
        metadata=_loads_json_object(row.get("payload")),
        created_at=created_iso,
    )


__all__ = [
    "RegressionCase",
    "RegressionCaseBuilder",
    "on_issue_resolved",
]
