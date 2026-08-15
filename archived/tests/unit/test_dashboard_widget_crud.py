"""Unit tests for the F57 dashboard widget CRUD (W3-10).

Tests MonitoringDashboardService against a mocked asyncpg client so no
Postgres is needed. Covers the round-trip:
  create_dashboard → upsert_widget → list_widgets → delete_widget
and the new get_dashboard / delete_widget methods added in W3-10.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
import uuid

import pytest


class TestDashboardCrud:
    """MonitoringDashboardService CRUD round-trip with mocked Postgres."""

    @pytest.fixture
    def mock_client(self):
        """Return a thin asyncpg mock with execute / fetchrow / fetch stubs."""
        c = AsyncMock()
        return c

    @pytest.fixture
    def service(self):
        from eden.monitoring.dashboards import MonitoringDashboardService

        return MonitoringDashboardService()

    @pytest.mark.asyncio
    async def test_create_dashboard(self, service, mock_client):
        mock_client.execute = AsyncMock(return_value=None)
        with patch.object(service, "_client", return_value=mock_client):
            result = await service.create_dashboard(
                "org1", name="My Dashboard", is_home=False
            )

        assert result is not None
        assert result["name"] == "My Dashboard"
        assert result["is_home"] is False
        assert "id" in result

    @pytest.mark.asyncio
    async def test_upsert_widget_returns_record(self, service, mock_client):
        wid = str(uuid.uuid4())
        mock_client.execute = AsyncMock(return_value=None)
        with patch.object(service, "_client", return_value=mock_client):
            result = await service.upsert_widget(
                "org1",
                "dashboard-uuid",
                widget_type="metric",
                title="Trace volume (24h)",
                query="summary:traces",
                config={"chart_type": "stat"},
                position=0,
                widget_id=wid,
            )

        assert result is not None
        assert result["id"] == wid
        assert result["title"] == "Trace volume (24h)"
        assert result["query"] == "summary:traces"

    @pytest.mark.asyncio
    async def test_list_widgets(self, service, mock_client):
        row = MagicMock()
        row.__iter__ = MagicMock(
            return_value=iter(
                [
                    ("id", "w1"),
                    ("dashboard_id", "d1"),
                    ("org_id", "org1"),
                    ("widget_type", "metric"),
                    ("title", "Open issues"),
                    ("query", "summary:issues"),
                    ("config", {}),
                    ("position", 0),
                ]
            )
        )
        # dict(row) pattern: asyncpg Record supports iteration/keys
        row.keys = MagicMock(return_value=["id", "dashboard_id", "org_id",
                                           "widget_type", "title", "query",
                                           "config", "position"])
        row.values = MagicMock(return_value=["w1", "d1", "org1", "metric",
                                             "Open issues", "summary:issues",
                                             {}, 0])
        row.items = MagicMock(return_value=[("id", "w1"), ("title", "Open issues"),
                                            ("query", "summary:issues")])
        mock_client.fetch = AsyncMock(return_value=[row])

        with patch.object(service, "_client", return_value=mock_client):
            widgets = await service.list_widgets("org1", "d1")

        assert len(widgets) == 1
        mock_client.fetch.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_dashboard_not_found(self, service, mock_client):
        mock_client.fetchrow = AsyncMock(return_value=None)
        with patch.object(service, "_client", return_value=mock_client):
            result = await service.get_dashboard("org1", "nonexistent-uuid")
        assert result is None

    @pytest.mark.asyncio
    async def test_get_dashboard_found(self, service, mock_client):
        did = str(uuid.uuid4())
        fake_row = {
            "id": did,
            "org_id": "org1",
            "name": "Home",
            "is_home": True,
            "layout": [],
        }
        # asyncpg row mock: fetchrow returns a dict-like object
        row = MagicMock()
        row.__getitem__ = MagicMock(side_effect=lambda k: fake_row[k])
        row.get = MagicMock(side_effect=lambda k, d=None: fake_row.get(k, d))
        row.keys = MagicMock(return_value=list(fake_row.keys()))
        row.__iter__ = MagicMock(return_value=iter(fake_row.items()))
        # Support dict(row) via items()
        row.items = MagicMock(return_value=list(fake_row.items()))

        mock_client.fetchrow = AsyncMock(return_value=row)
        mock_client.fetch = AsyncMock(return_value=[])  # no widgets

        with patch.object(service, "_client", return_value=mock_client):
            with patch.object(service, "list_widgets", return_value=[]) as lw:
                result = await service.get_dashboard("org1", did)

        assert result is not None
        lw.assert_called_once_with("org1", did)

    @pytest.mark.asyncio
    async def test_delete_widget_success(self, service, mock_client):
        mock_client.execute = AsyncMock(return_value="DELETE 1")
        with patch.object(service, "_client", return_value=mock_client):
            ok = await service.delete_widget("org1", "dashboard-id", "widget-id")
        assert ok is True
        mock_client.execute.assert_called_once()

    @pytest.mark.asyncio
    async def test_delete_widget_not_found(self, service, mock_client):
        mock_client.execute = AsyncMock(return_value="DELETE 0")
        with patch.object(service, "_client", return_value=mock_client):
            ok = await service.delete_widget("org1", "dashboard-id", "widget-id")
        assert ok is False

    @pytest.mark.asyncio
    async def test_delete_widget_no_client(self, service):
        with patch.object(service, "_client", return_value=None):
            ok = await service.delete_widget("org1", "d1", "w1")
        assert ok is False

    @pytest.mark.asyncio
    async def test_upsert_widget_no_client(self, service):
        with patch.object(service, "_client", return_value=None):
            result = await service.upsert_widget(
                "org1",
                "d1",
                widget_type="metric",
                title="x",
                query="summary:traces",
            )
        assert result is None

    @pytest.mark.asyncio
    async def test_execute_widget_query_summary_no_client(self, service):
        with patch.object(service, "_client", return_value=None):
            result = await service.execute_widget_query("org1", "summary:traces")
        assert result == {"key": "traces", "value": None}

    @pytest.mark.asyncio
    async def test_execute_widget_query_unknown(self, service, mock_client):
        with patch.object(service, "_client", return_value=mock_client):
            result = await service.execute_widget_query("org1", "not_a_query")
        assert result["type"] == "unknown"

    @pytest.mark.asyncio
    async def test_list_dashboards_empty_on_exception(self, service, mock_client):
        mock_client.fetch = AsyncMock(side_effect=Exception("table missing"))
        with patch.object(service, "_client", return_value=mock_client):
            result = await service.list_dashboards("org1")
        assert result == []
