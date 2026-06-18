"""ksqlDB integration for real-time complex event processing.

Phase 5.4.5: ksqlDB runs streaming SQL over Kafka topics to compute
windowed aggregations, joins, and anomaly detection at sub-second
latency. Eden's data platform feeds raw events into the ``eden-events``
topic; ksqlDB continuously materialises aggregates into derived
streams (e.g. per-tenant error rate, per-pipeline-stage p95 latency)
that the platform API exposes.

If ksqlDB is not configured (``KSQLDB_ENABLED != true``), this module
is a no-op and falls back to the in-process rolling-window aggregator
in :mod:`eden.realtime.alert_stream`.

ksqlDB API surface used:

- ``POST /ksql`` with statement header — execute DDL/DML.
- ``POST /query`` — execute ``SELECT`` and stream results.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Pre-built statements
# ─────────────────────────────────────────────────────────────────────────────

# Each tuple: (statement_name, ksql_statement)
KSQL_STATEMENTS: dict[str, str] = {
    # Per-tenant error rate over a tumbling 1-minute window
    "tenant_error_rate_1m": """
        CREATE TABLE tenant_error_rate_1m AS
        SELECT
            org_id,
            COUNT(*) FILTER (WHERE event_type = 'error') AS errors,
            COUNT(*) AS total,
            (CAST(COUNT(*) FILTER (WHERE event_type = 'error') AS DOUBLE)
                / CAST(COUNT(*) AS DOUBLE)) AS error_rate
        FROM eden-events
        WINDOW TUMBLING (SIZE 1 MINUTE)
        GROUP BY org_id
        EMIT CHANGES;
    """,

    # Per-pipeline-stage p95 duration (approximation via ksqlDB's PERCENTILE
    # in 0.29+; falls back to a sampled series otherwise)
    "stage_latency_p95": """
        CREATE TABLE stage_latency_p95 AS
        SELECT
            current_stage,
            PERCENTILE(duration_ms, 0.95) AS p95_ms
        FROM eden-events
        WINDOW TUMBLING (SIZE 1 MINUTE)
        GROUP BY current_stage
        EMIT CHANGES;
    """,

    # Cost burn rate (USD / minute per org)
    "cost_burn_rate_1m": """
        CREATE TABLE cost_burn_rate_1m AS
        SELECT
            org_id,
            SUM(cost_usd) AS burn_usd_per_min
        FROM eden-events
        WINDOW TUMBLING (SIZE 1 MINUTE)
        GROUP BY org_id
        EMIT CHANGES;
    """,
}


# ─────────────────────────────────────────────────────────────────────────────
# Client
# ─────────────────────────────────────────────────────────────────────────────


class KsqlDBClient:
    """Async client for ksqlDB.

    Reads connection from env::

        KSQLDB_ENABLED=true
        KSQLDB_URL=http://localhost:8088
    """

    def __init__(self, base_url: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._session: aiohttp.ClientSession | None = None
        self._statements_applied: set[str] = set()

    @classmethod
    def from_env(cls) -> KsqlDBClient | None:
        """Return a client if ksqlDB is enabled in env, else None.

        The None return value lets the rest of the platform fall
        through to the in-process aggregator gracefully.
        """
        if os.environ.get("KSQLDB_ENABLED", "").lower() not in ("1", "true", "yes", "on"):
            return None
        url = os.environ.get("KSQLDB_URL", "http://localhost:8088")
        return cls(url)

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=30),
                headers={"Content-Type": "application/vnd.ksql.v1+json"},
            )
        return self._session

    async def apply_statements(self, names: list[str] | None = None) -> dict[str, bool]:
        """Apply DDL statements. Idempotent — ksqlDB rejects
        ``CREATE TABLE`` re-runs but a 400 is treated as 'already
        exists' and returned as success."""
        names = names or list(KSQL_STATEMENTS.keys())
        session = await self._ensure_session()
        results: dict[str, bool] = {}
        for name in names:
            if name in self._statements_applied:
                results[name] = True
                continue
            sql = KSQL_STATEMENTS[name].strip()
            try:
                async with session.post(
                    f"{self._base_url}/ksql",
                    json={"statement": sql, "streamsProperties": {}},
                    headers={"Accept": "application/vnd.ksql.v1+json"},
                ) as resp:
                    body = await resp.json()
                    if resp.status < 300 or "already exists" in json.dumps(body).lower():
                        results[name] = True
                        self._statements_applied.add(name)
                    else:
                        logger.warning(f"ksqlDB {name} failed: {body}")
                        results[name] = False
            except Exception as exc:
                logger.warning(f"ksqlDB {name} transport error: {exc}")
                results[name] = False
        return results

    async def query(
        self,
        sql: str,
        params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        """Run a SELECT and return the materialized rows."""
        session = await self._ensure_session()
        body: dict[str, Any] = {"statement": sql, "streamsProperties": {}}
        if params:
            body["parameters"] = params
        try:
            async with session.post(
                f"{self._base_url}/query",
                json=body,
                headers={"Accept": "application/vnd.ksql.v1+json"},
            ) as resp:
                if resp.status >= 300:
                    text = await resp.text()
                    raise RuntimeError(f"ksqlDB query failed ({resp.status}): {text[:200]}")
                rows: list[dict[str, Any]] = []
                # ksqlDB streams newline-delimited JSON for /query
                async for line in resp.content:
                    line = line.decode().strip()
                    if not line or line.startswith('"') and not line.startswith("{"):
                        # status / header lines
                        continue
                    try:
                        rows.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
                return rows
        except Exception as exc:
            logger.warning(f"ksqlDB query error: {exc}")
            return []

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


# ─────────────────────────────────────────────────────────────────────────────
# Module-level singleton
# ─────────────────────────────────────────────────────────────────────────────


_ksql_client: KsqlDBClient | None = None


def get_ksql_client() -> KsqlDBClient | None:
    """Lazy singleton. Returns None if ksqlDB is not enabled."""
    global _ksql_client
    if _ksql_client is None:
        _ksql_client = KsqlDBClient.from_env()
    return _ksql_client


async def close_ksql_client() -> None:
    global _ksql_client
    if _ksql_client is not None:
        await _ksql_client.close()
        _ksql_client = None
