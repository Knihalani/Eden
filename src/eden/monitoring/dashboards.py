"""F57 custom monitoring dashboards + editable Home."""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


class MonitoringDashboardService:
    """CRUD dashboards and widgets; execute widget queries."""

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            logger.debug("postgres client unavailable for dashboards", exc_info=True)
            return None

    @staticmethod
    def _empty_home(org_id: str) -> dict[str, Any]:
        return {
            "org_id": org_id,
            "name": "Home",
            "is_home": True,
            "widgets": [],
        }

    async def list_dashboards(self, org_id: str) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                "SELECT * FROM monitoring_dashboards WHERE org_id = $1 "
                "ORDER BY is_home DESC, updated_at DESC",
                org_id,
            )
            return [dict(r) for r in rows]
        except Exception as exc:
            # Missing migration 102 / table → empty list, never 500 the portal.
            logger.warning("list_dashboards failed org=%s: %s", org_id, exc)
            return []

    async def get_home(self, org_id: str) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return self._empty_home(org_id)
        try:
            row = await client.fetchrow(
                "SELECT * FROM monitoring_dashboards WHERE org_id = $1 AND is_home = true "
                "ORDER BY updated_at DESC LIMIT 1",
                org_id,
            )
            if not row:
                return await self.ensure_default_home(org_id)
            dash = dict(row)
            dash["widgets"] = await self.list_widgets(org_id, str(row["id"]))
            return dash
        except Exception as exc:
            logger.warning("get_home failed org=%s: %s", org_id, exc)
            return self._empty_home(org_id)

    async def ensure_default_home(self, org_id: str) -> dict[str, Any]:
        dashboards = await self.list_dashboards(org_id)
        if dashboards:
            home = next((d for d in dashboards if d.get("is_home")), dashboards[0])
            home["widgets"] = await self.list_widgets(org_id, str(home["id"]))
            return home
        client = await self._client()
        if client is None:
            return self._empty_home(org_id)
        did = str(uuid.uuid4())
        try:
            await client.execute(
                """
                INSERT INTO monitoring_dashboards (id, org_id, name, is_home)
                VALUES ($1::uuid, $2, 'Home', true)
                ON CONFLICT (org_id, name) DO NOTHING
                """,
                did,
                org_id,
            )
            # Concurrent first-load may have won the unique (org_id, name) race.
            existing = await client.fetchrow(
                "SELECT * FROM monitoring_dashboards WHERE org_id = $1 AND name = 'Home' "
                "ORDER BY updated_at DESC LIMIT 1",
                org_id,
            )
            if existing:
                did = str(existing["id"])
            else:
                # Conflict path didn't insert and no row found — fall back empty.
                return self._empty_home(org_id)

            widgets = await self.list_widgets(org_id, did)
            if not widgets:
                for i, (wtype, title, query) in enumerate(
                    [
                        ("traces", "Trace volume", "summary:traces"),
                        ("cost", "Cost (24h)", "summary:cost"),
                        ("scores", "Eval pass rate", "summary:eval_pass_rate"),
                        ("issues", "Open issues", "summary:issues"),
                    ]
                ):
                    await client.execute(
                        """
                        INSERT INTO dashboard_widgets
                        (id, dashboard_id, org_id, widget_type, title, query, position)
                        VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
                        ON CONFLICT (id) DO NOTHING
                        """,
                        str(uuid.uuid4()),
                        did,
                        org_id,
                        wtype,
                        title,
                        query,
                        i,
                    )
            dash = {"id": did, "org_id": org_id, "name": "Home", "is_home": True}
            dash["widgets"] = await self.list_widgets(org_id, did)
            return dash
        except Exception as exc:
            logger.warning("ensure_default_home failed org=%s: %s", org_id, exc)
            return self._empty_home(org_id)

    async def create_dashboard(
        self, org_id: str, *, name: str, is_home: bool = False
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        did = str(uuid.uuid4())
        if is_home:
            await client.execute(
                "UPDATE monitoring_dashboards SET is_home = false WHERE org_id = $1",
                org_id,
            )
        await client.execute(
            """
            INSERT INTO monitoring_dashboards (id, org_id, name, is_home)
            VALUES ($1::uuid, $2, $3, $4)
            """,
            did,
            org_id,
            name,
            is_home,
        )
        return {"id": did, "name": name, "is_home": is_home}

    async def list_widgets(self, org_id: str, dashboard_id: str) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        try:
            rows = await client.fetch(
                """
                SELECT * FROM dashboard_widgets
                WHERE org_id = $1 AND dashboard_id = $2::uuid
                ORDER BY position ASC
                """,
                org_id,
                dashboard_id,
            )
            return [dict(r) for r in rows]
        except Exception as exc:
            logger.warning(
                "list_widgets failed org=%s dashboard=%s: %s",
                org_id,
                dashboard_id,
                exc,
            )
            return []

    async def get_dashboard(
        self, org_id: str, dashboard_id: str
    ) -> dict[str, Any] | None:
        """Return a single dashboard row with its widgets, or None."""
        client = await self._client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                "SELECT * FROM monitoring_dashboards WHERE org_id = $1 AND id = $2::uuid",
                org_id,
                dashboard_id,
            )
            if not row:
                return None
            dash = dict(row)
            dash["widgets"] = await self.list_widgets(org_id, dashboard_id)
            return dash
        except Exception as exc:
            logger.warning(
                "get_dashboard failed org=%s dashboard=%s: %s",
                org_id,
                dashboard_id,
                exc,
            )
            return None

    async def upsert_widget(
        self,
        org_id: str,
        dashboard_id: str,
        *,
        widget_type: str,
        title: str,
        query: str,
        config: dict[str, Any] | None = None,
        position: int = 0,
        widget_id: str | None = None,
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        wid = widget_id or str(uuid.uuid4())
        await client.execute(
            """
            INSERT INTO dashboard_widgets
            (id, dashboard_id, org_id, widget_type, title, query, config, position)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8)
            ON CONFLICT (id) DO UPDATE SET
                widget_type = EXCLUDED.widget_type,
                title = EXCLUDED.title,
                query = EXCLUDED.query,
                config = EXCLUDED.config,
                position = EXCLUDED.position,
                updated_at = NOW()
            """,
            wid,
            dashboard_id,
            org_id,
            widget_type,
            title,
            query,
            json.dumps(config or {}),
            position,
        )
        return {"id": wid, "title": title, "query": query}

    async def delete_widget(
        self, org_id: str, dashboard_id: str, widget_id: str
    ) -> bool:
        """Delete a widget; returns True on success, False when not found/unavailable."""
        client = await self._client()
        if client is None:
            return False
        try:
            result = await client.execute(
                "DELETE FROM dashboard_widgets "
                "WHERE org_id = $1 AND dashboard_id = $2::uuid AND id = $3::uuid",
                org_id,
                dashboard_id,
                widget_id,
            )
            return result != "DELETE 0"
        except Exception as exc:
            logger.warning(
                "delete_widget failed org=%s dashboard=%s widget=%s: %s",
                org_id,
                dashboard_id,
                widget_id,
                exc,
            )
            return False

    async def execute_widget_query(
        self, org_id: str, query: str, *, agent_id: str | None = None
    ) -> dict[str, Any]:
        """Resolve preset or SQL/EQL widget queries."""
        if query.startswith("summary:"):
            key = query.split(":", 1)[1]
            return await self._summary_value(org_id, key, agent_id=agent_id)
        if query.strip().upper().startswith("SELECT"):
            from eden.observability.sql_executor import SqlExecutor

            executor = SqlExecutor()
            result = await executor.execute(org_id, query)
            return {"type": "sql", "result": result}
        return {"type": "unknown", "query": query}

    async def _summary_value(
        self, org_id: str, key: str, *, agent_id: str | None = None
    ) -> dict[str, Any]:
        client = await self._client()
        if client is None:
            return {"key": key, "value": None}
        if key == "traces":
            row = await client.fetchrow(
                """
                SELECT count(DISTINCT trace_id) AS n FROM telemetry_events
                WHERE tenant_id = $1 AND timestamp > NOW() - interval '24 hours'
                """,
                org_id,
            )
            return {"key": key, "value": int(row["n"] or 0) if row else 0}
        if key == "cost":
            row = await client.fetchrow(
                """
                -- telemetry_events has no cost_usd column (alembic 009);
                -- cost is carried in the metrics/payload/attributes JSONB.
                SELECT coalesce(sum(COALESCE(
                    NULLIF(metrics->>'cost_usd', '')::float,
                    NULLIF(payload->>'cost_usd', '')::float,
                    NULLIF(attributes->>'cost_usd', '')::float
                )), 0) AS cost FROM telemetry_events
                WHERE tenant_id = $1 AND timestamp > NOW() - interval '24 hours'
                """,
                org_id,
            )
            return {"key": key, "value": float(row["cost"] or 0) if row else 0.0}
        if key == "eval_pass_rate":
            q = (
                "SELECT avg(CASE WHEN passed THEN 1.0 ELSE 0.0 END) AS rate "
                "FROM production_eval_scores WHERE org_id = $1 "
                "AND scored_at > NOW() - interval '7 days'"
            )
            args: list[Any] = [org_id]
            if agent_id:
                q += " AND agent_id = $2"
                args.append(agent_id)
            row = await client.fetchrow(q, *args)
            return {"key": key, "value": float(row["rate"] or 0) if row else None}
        if key == "issues":
            row = await client.fetchrow(
                """
                SELECT count(*) AS n FROM agent_issues
                WHERE org_id = $1 AND status NOT IN ('resolved', 'archived')
                """,
                org_id,
            )
            return {"key": key, "value": int(row["n"] or 0) if row else 0}
        return {"key": key, "value": None}
