"""F52 online scoring rules engine."""

from __future__ import annotations

import hashlib
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any

from eden.evaluation.online.scorer_cascade import OnlineScorerCascade
from eden.evaluation.online.slm_hook import budget_allows

logger = logging.getLogger(__name__)

# Documented filter tokens: agent_id / agent / trace_id / outcome
# Forms: key:value | key=value | key="value"
_FILTER_TOKEN = re.compile(
    r"""(?P<key>[\w.]+)\s*(?::|=)\s*(?P<val>"[^"]*"|'[^']*'|\S+)""",
    re.IGNORECASE,
)
_FILTER_KEY_ALIASES = {
    "agent": "agent_id",
    "agent_id": "agent_id",
    "trace_id": "trace_id",
    "outcome": "outcome",
}

# COST: sample rate applied to NEWLY created rules. Rules used to default
# to 1.0, so creating one rule meant an SLM judge call on every matching
# trace forever. 0.1 keeps the score distribution meaningful at a tenth of
# the spend; an operator who wants full coverage passes sample_rate=1.0
# explicitly. Deliberately NOT applied to already-persisted rules -- see
# ``_row_to_rule``, which still hydrates stored values as-is so this change
# cannot silently retune a customer's existing rules.
DEFAULT_NEW_RULE_SAMPLE_RATE = 0.1


@dataclass
class ScoringRule:
    id: str
    org_id: str
    name: str
    description: str
    scope: str
    filter_query: str
    scorer_type: str
    scorer_ref: str | None
    sample_rate: float
    enabled: bool
    version: int
    config: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "name": self.name,
            "description": self.description,
            "scope": self.scope,
            "filter_query": self.filter_query,
            "scorer_type": self.scorer_type,
            "scorer_ref": self.scorer_ref,
            "sample_rate": self.sample_rate,
            "enabled": self.enabled,
            "version": self.version,
            "config": self.config,
        }


def _row_to_rule(row: dict[str, Any]) -> ScoringRule:
    return ScoringRule(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        name=str(row["name"]),
        description=str(row.get("description") or ""),
        scope=str(row.get("scope") or "trace"),
        filter_query=str(row.get("filter_query") or ""),
        scorer_type=str(row.get("scorer_type") or "slm"),
        scorer_ref=row.get("scorer_ref"),
        sample_rate=float(row.get("sample_rate") or 1.0),
        enabled=bool(row.get("enabled", True)),
        version=int(row.get("version") or 1),
        config=dict(row.get("config") or {}),
    )


def _trace_events_limit() -> int:
    """The telemetry_events row cap applied by ``_fetch_trace_events``.

    Mirrored (not hard-coded) so the truncation guard in
    :meth:`OnlineScoringRulesEngine._load_content` stays in lockstep with
    the actual fetch limit.
    """
    try:
        from eden.insights.rca._common import TRACE_EVENTS_LIMIT

        return int(TRACE_EVENTS_LIMIT)
    except Exception:  # pragma: no cover - defensive
        return 2000


def _content_from_events(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Derive the judge content dict from an already-fetched event list.

    Events from ``_fetch_trace_events`` arrive in ``timestamp ASC`` order,
    so the last element is the newest — the same row
    :meth:`OnlineScoringRulesEngine._load_span_content`'s
    ``ORDER BY timestamp DESC LIMIT 1`` picks. Returns an empty dict for
    an empty list (mirroring the no-row result of the DB read).
    """
    out: dict[str, Any] = {}
    if not events:
        return out
    ev = events[-1]
    if ev.get("agent_id"):
        out["agent_id"] = str(ev["agent_id"])
    if ev.get("outcome"):
        out["outcome"] = str(ev["outcome"])
    if ev.get("name"):
        out["name"] = str(ev["name"])
    inp = ev.get("request_body")
    resp = ev.get("response_body")
    if inp is not None:
        out["input"] = inp
    if resp is not None:
        out["output"] = resp
        out["text"] = resp if isinstance(resp, str) else str(resp)
    return out


class OnlineScoringRulesEngine:
    """CRUD + apply online scoring rules on production traces/spans."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg
        self._cascade = OnlineScorerCascade()

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def list_rules(self, org_id: str) -> list[ScoringRule]:
        client = await self._client()
        if client is None:
            return []
        rows = await client.fetch(
            "SELECT * FROM online_scoring_rules WHERE org_id = $1 "
            "ORDER BY updated_at DESC",
            org_id,
        )
        return [_row_to_rule(dict(r)) for r in rows]

    async def get_rule(self, org_id: str, rule_id: str) -> ScoringRule | None:
        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            "SELECT * FROM online_scoring_rules WHERE org_id = $1 AND id = $2::uuid",
            org_id,
            rule_id,
        )
        return _row_to_rule(dict(row)) if row else None

    async def create_rule(
        self,
        org_id: str,
        *,
        name: str,
        description: str = "",
        scope: str = "trace",
        filter_query: str = "",
        scorer_type: str = "slm",
        scorer_ref: str | None = None,
        sample_rate: float = DEFAULT_NEW_RULE_SAMPLE_RATE,
        config: dict[str, Any] | None = None,
    ) -> ScoringRule | None:
        client = await self._client()
        if client is None:
            return None
        rid = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO online_scoring_rules
            (id, org_id, name, description, scope, filter_query, scorer_type,
             scorer_ref, sample_rate, config)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
            """,
            rid,
            org_id,
            name,
            description,
            scope,
            filter_query,
            scorer_type,
            scorer_ref,
            sample_rate,
            __import__("json").dumps(config or {}),
        )
        return await self.get_rule(org_id, rid)

    async def update_rule(
        self, org_id: str, rule_id: str, **fields: Any
    ) -> ScoringRule | None:
        rule = await self.get_rule(org_id, rule_id)
        if rule is None:
            return None
        client = await self._client()
        if client is None:
            return None
        name = fields.get("name", rule.name)
        description = fields.get("description", rule.description)
        scope = fields.get("scope", rule.scope)
        filter_query = fields.get("filter_query", rule.filter_query)
        scorer_type = fields.get("scorer_type", rule.scorer_type)
        scorer_ref = fields.get("scorer_ref", rule.scorer_ref)
        sample_rate = fields.get("sample_rate", rule.sample_rate)
        enabled = fields.get("enabled", rule.enabled)
        config = fields.get("config", rule.config)
        version = rule.version + 1
        await client.execute(
            """
            UPDATE online_scoring_rules SET
                name = $3, description = $4, scope = $5, filter_query = $6,
                scorer_type = $7, scorer_ref = $8, sample_rate = $9,
                enabled = $10, version = $11, config = $12::jsonb,
                updated_at = NOW()
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            rule_id,
            name,
            description,
            scope,
            filter_query,
            scorer_type,
            scorer_ref,
            sample_rate,
            enabled,
            version,
            __import__("json").dumps(config),
        )
        return await self.get_rule(org_id, rule_id)

    async def apply_rules_for_trace(
        self,
        org_id: str,
        trace_id: str,
        *,
        agent_id: str | None = None,
        span_id: str | None = None,
        events: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """Evaluate enabled rules; persist span/trace scores when cascade succeeds.

        ``events`` — when provided — is the trace's already-fetched event
        list (the trace.finalized pipeline threads it through every
        stage). It replaces the per-call ``telemetry_events`` read for
        the judge payload (see :meth:`_load_content`).
        """
        from eden.evaluation.online.span_scores import SpanScoreStore

        rules = [r for r in await self.list_rules(org_id) if r.enabled]
        if not rules:
            return []

        content = await self._load_content(
            org_id, trace_id, span_id=span_id, events=events
        )
        resolved_agent = agent_id or content.get("agent_id")
        outcome = content.get("outcome")

        store = SpanScoreStore(pg=self._pg)
        results: list[dict[str, Any]] = []
        for rule in rules:
            if rule.scope == "span" and not span_id:
                continue
            if not self._matches_filter(
                rule.filter_query,
                trace_id,
                resolved_agent,
                outcome=outcome if isinstance(outcome, str) else None,
            ):
                continue
            if not self._passes_sample(rule.sample_rate, trace_id, rule.id):
                continue
            payload: dict[str, Any] = {
                "agent_id": resolved_agent,
                "rule_id": rule.id,
                "trace_id": trace_id,
                "span_id": span_id,
                "input": content.get("input"),
                "output": content.get("output"),
                "text": content.get("text") or content.get("output"),
                "name": content.get("name"),
                "outcome": outcome,
            }
            scored = await self._cascade.score(
                org_id,
                trace_id=trace_id,
                span_id=span_id,
                scorer_type=rule.scorer_type,
                scorer_ref=rule.scorer_ref,
                payload=payload,
            )
            if scored is None:
                continue
            row_id = await store.persist(
                org_id,
                trace_id=trace_id,
                span_id=span_id or trace_id,
                rule_id=rule.id,
                scorer_type=rule.scorer_type,
                score=float(scored.get("score") or 0),
                passed=bool(scored.get("passed")),
                label=scored.get("label"),
                rationale=scored.get("rationale"),
                confidence=scored.get("confidence"),
                cost_usd=float(scored.get("cost_usd") or 0),
                judge_tier=str(scored.get("judge_tier") or "slm"),
            )
            if row_id:
                results.append({"rule_id": rule.id, "score_id": row_id, **scored})
                await self._maybe_fire_automations(org_id, rule, scored, trace_id)
        return results

    def _matches_filter(
        self,
        filter_query: str,
        trace_id: str,
        agent_id: str | None,
        *,
        outcome: str | None = None,
    ) -> bool:
        """Match documented filter tokens; empty/`*`/`true` = all; else AND."""
        if not filter_query or filter_query.strip() in ("*", "true"):
            return True
        ctx = {
            "agent_id": (agent_id or "").lower(),
            "trace_id": (trace_id or "").lower(),
            "outcome": (outcome or "").lower(),
        }
        tokens = list(_FILTER_TOKEN.finditer(filter_query))
        if not tokens:
            return False
        for match in tokens:
            raw_key = match.group("key").lower()
            key = _FILTER_KEY_ALIASES.get(raw_key)
            if key is None:
                return False
            want = match.group("val").strip("\"'").lower()
            have = ctx.get(key, "")
            if not have or have != want:
                return False
        return True

    @staticmethod
    def _passes_sample(sample_rate: float, trace_id: str, rule_id: str = "") -> bool:
        """Deterministic sample gate (stable per rule+trace)."""
        rate = float(sample_rate)
        if rate >= 1.0:
            return True
        if rate <= 0.0:
            return False
        key = f"{rule_id}:{trace_id}" if rule_id else trace_id
        bucket = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16) % 10_000
        return bucket < int(rate * 10_000)

    async def _load_content(
        self,
        org_id: str,
        trace_id: str,
        *,
        span_id: str | None = None,
        events: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Span/trace I/O for the judge payload — DB read OR in-memory events.

        When the caller already fetched the trace's events (the
        trace.finalized pipeline), derive content from the last event
        instead of re-reading ``telemetry_events`` — mirroring
        :meth:`_load_span_content`'s ``ORDER BY timestamp DESC LIMIT 1``
        semantics (events arrive in ``timestamp ASC`` order, so the last
        element is the newest). Falls back to the DB read when:

        * ``events`` was not provided at all (API / rewind callers), or
        * ``span_id`` targeting is required (the caller needs a specific
          span, which a flat event list cannot reliably resolve), or
        * the fetched events carry ``NULL`` request/response blobs —
          zstd-only storage leaves the plaintext columns empty and only
          the DB read can decode the compressed payloads, so judges keep
          seeing the same content they always did, or
        * the event list hit the fetch cap (``TRACE_EVENTS_LIMIT``) —
          ``events[-1]`` is then the *cap-th* oldest, not the newest,
          so the DB read is authoritative again.

        A threaded-but-empty list is authoritative (the shared fetch
        already decided the trace is empty for this run) — it returns
        ``{}`` without touching the DB.
        """
        if events is None or span_id is not None:
            return await self._load_span_content(
                org_id, trace_id, span_id=span_id
            )
        content = _content_from_events(events)
        if events and content.get("input") is None and content.get("output") is None:
            # zstd-only storage — plaintext blobs NULL on the fetched
            # events; only the DB read has the compressed payloads.
            content = await self._load_span_content(
                org_id, trace_id, span_id=None
            )
        elif len(events) >= _trace_events_limit():
            # ``_fetch_trace_events`` caps the ASC list at the limit, so a
            # list this long has almost certainly been truncated and
            # ``events[-1]`` is NOT the newest event. ``_load_span_content``
            # reads the true newest row — authoritative for judge content.
            content = await self._load_span_content(
                org_id, trace_id, span_id=None
            )
        return content

    async def _load_span_content(
        self,
        org_id: str,
        trace_id: str,
        *,
        span_id: str | None = None,
    ) -> dict[str, Any]:
        """Load span/trace I/O from telemetry for the judge payload."""
        out: dict[str, Any] = {}
        client = await self._client()
        if client is None:
            return out
        row = None
        try:
            if span_id:
                row = await client.fetchrow(
                    """
                    SELECT agent_id, outcome, name, request_body, response_body,
                           request_body_zstd, response_body_zstd
                    FROM telemetry_events
                    WHERE tenant_id = $1 AND trace_id = $2 AND span_id = $3
                    ORDER BY timestamp ASC
                    LIMIT 1
                    """,
                    org_id,
                    trace_id,
                    span_id,
                )
            if row is None:
                row = await client.fetchrow(
                    """
                    SELECT agent_id, outcome, name, request_body, response_body,
                           request_body_zstd, response_body_zstd
                    FROM telemetry_events
                    WHERE tenant_id = $1 AND trace_id = $2
                    ORDER BY timestamp DESC
                    LIMIT 1
                    """,
                    org_id,
                    trace_id,
                )
        except Exception:
            # Columns may differ pre/post zstd migration — fall back to lean select.
            try:
                if span_id:
                    row = await client.fetchrow(
                        """
                        SELECT agent_id, outcome, name, request_body, response_body
                        FROM telemetry_events
                        WHERE tenant_id = $1 AND trace_id = $2 AND span_id = $3
                        ORDER BY timestamp ASC
                        LIMIT 1
                        """,
                        org_id,
                        trace_id,
                        span_id,
                    )
                if row is None:
                    row = await client.fetchrow(
                        """
                        SELECT agent_id, outcome, name, request_body, response_body
                        FROM telemetry_events
                        WHERE tenant_id = $1 AND trace_id = $2
                        ORDER BY timestamp DESC
                        LIMIT 1
                        """,
                        org_id,
                        trace_id,
                    )
            except Exception as exc:
                logger.debug("rules_engine: span content load failed: %s", exc)
                return out
        if not row:
            return out

        def _decode(primary: Any, zstd_val: Any) -> Any:
            # Phase 4 storage: prefer *_zstd first (matches the canonical
            # reader in telemetry_collector.get_trace_tree) so this stays
            # correct once telemetry_plaintext_jsonb_write_enabled=False
            # stops populating ``primary``. Falls back to the plaintext
            # JSONB column when zstd is absent (pre-migration rows) or
            # fails to decompress (defensive; should not happen).
            if zstd_val:
                try:
                    from eden.storage.compression import decompress_jsonb

                    decoded = decompress_jsonb(zstd_val)
                    if decoded is not None:
                        return decoded
                except Exception:
                    pass
            return primary

        row_d = dict(row)
        inp = _decode(row_d.get("request_body"), row_d.get("request_body_zstd"))
        resp = _decode(row_d.get("response_body"), row_d.get("response_body_zstd"))
        if row_d.get("agent_id"):
            out["agent_id"] = str(row_d["agent_id"])
        if row_d.get("outcome"):
            out["outcome"] = str(row_d["outcome"])
        if row_d.get("name"):
            out["name"] = str(row_d["name"])
        if inp is not None:
            out["input"] = inp
        if resp is not None:
            out["output"] = resp
            out["text"] = resp if isinstance(resp, str) else str(resp)
        return out

    async def rewind(self, org_id: str, rule_id: str, *, limit: int = 100) -> str | None:
        """Enqueue reprocess of recent traces for a rule (F52 rewind)."""
        client = await self._client()
        if client is None:
            return None
        job_id = str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO online_scoring_rewind_jobs (id, org_id, rule_id, status)
            VALUES ($1::uuid, $2, $3::uuid, 'pending')
            """,
            job_id,
            org_id,
            rule_id,
        )
        rows = await client.fetch(
            """
            SELECT DISTINCT trace_id FROM telemetry_events
            WHERE tenant_id = $1 ORDER BY timestamp DESC LIMIT $2
            """,
            org_id,
            limit,
        )
        processed = 0
        stopped_early = False
        for row in rows:
            # COST: this loop fans out limit x N-rules judge calls in one
            # request. Re-check the org budget every trace so an exhausted
            # org stops mid-rewind instead of blowing through the ceiling.
            if not await budget_allows(org_id):
                logger.warning(
                    "rewind: budget exhausted after %d traces org=%s job=%s",
                    processed,
                    org_id,
                    job_id,
                )
                stopped_early = True
                break
            await self.apply_rules_for_trace(org_id, str(row["trace_id"]))
            processed += 1
        await client.execute(
            """
            UPDATE online_scoring_rewind_jobs
            SET status = $4, traces_processed = $3, completed_at = NOW()
            WHERE id = $1::uuid AND org_id = $2
            """,
            job_id,
            org_id,
            processed,
            "budget_exhausted" if stopped_early else "completed",
        )
        return job_id

    async def _maybe_fire_automations(
        self,
        org_id: str,
        rule: ScoringRule,
        scored: dict[str, Any],
        trace_id: str,
    ) -> None:
        try:
            from eden.automations.engine import AutomationsEngine

            await AutomationsEngine(pg=self._pg).on_score(
                org_id,
                rule_id=rule.id,
                trace_id=trace_id,
                score=float(scored.get("score") or 0),
                passed=bool(scored.get("passed")),
            )
        except Exception as exc:
            logger.debug("rules_engine: automation hook failed: %s", exc)
