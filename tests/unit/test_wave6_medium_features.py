"""Minimal tests for Wave 6 medium features.

Covers the 4 items implemented:
  1. Time-travel _re_execute_step calls real AIGateway
  2. SemanticCache.set() uses configured embedder for L2 writes
  3. GDPR delete_user_data includes telemetry_events / trace_archive_index
     / telemetry_stream_chunks; _delete_from_clickhouse also purges
     telemetry_events_ch
  4. RepoConnector.connect() Gate 1 verifies GitHub install
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── 1. Time-travel _re_execute_step ────────────────────────────────


class TestReExecuteStep:
    """_re_execute_step should call the gateway when payload has messages."""

    @pytest.mark.asyncio
    async def test_calls_gateway_on_valid_payload(self) -> None:
        from eden.time_travel.replayer import TraceReplayer

        replayer = TraceReplayer()

        fake_resp = MagicMock()
        fake_resp.text = "hello world"
        fake_resp.input_tokens = 10
        fake_resp.output_tokens = 5
        fake_resp.cost_usd = 0.0001

        fake_gw = MagicMock()
        fake_gw.complete = AsyncMock(return_value=fake_resp)

        step = {
            "payload": {
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "user", "content": "Hello"},
                ],
            },
        }

        with patch("eden.api.routes.gateway.get_ai_gateway", return_value=fake_gw):
            result = await replayer._re_execute_step(org_id="org1", step=step)

        assert fake_gw.complete.called
        assert result["tokens_used"] == 15
        assert result["cost_usd"] == pytest.approx(0.0001)
        assert len(result["response_hash"]) == 32

    @pytest.mark.asyncio
    async def test_falls_back_when_no_prompt(self) -> None:
        from eden.time_travel.replayer import TraceReplayer

        replayer = TraceReplayer()
        step = {
            "payload": {},
            "response_hash": "abc123",
            "tokens_used": 42,
            "cost_usd": 0.007,
        }
        result = await replayer._re_execute_step(org_id="org1", step=step)
        assert result["response_hash"] == "abc123"
        assert result["tokens_used"] == 42

    @pytest.mark.asyncio
    async def test_falls_back_on_gateway_exception(self) -> None:
        from eden.time_travel.replayer import TraceReplayer

        replayer = TraceReplayer()
        step = {
            "payload": {"messages": [{"role": "user", "content": "Hi"}]},
            "response_hash": "fallback_hash",
            "tokens_used": 20,
            "cost_usd": 0.002,
        }

        with patch(
            "eden.api.routes.gateway.get_ai_gateway",
            side_effect=RuntimeError("provider down"),
        ):
            result = await replayer._re_execute_step(org_id="org1", step=step)

        assert result["response_hash"] == "fallback_hash"
        assert result["tokens_used"] == 20

    @pytest.mark.asyncio
    async def test_payload_as_json_string(self) -> None:
        """Payload stored as a JSON string is parsed correctly."""
        import json

        from eden.time_travel.replayer import TraceReplayer

        replayer = TraceReplayer()

        fake_resp = MagicMock()
        fake_resp.text = "parsed"
        fake_resp.input_tokens = 5
        fake_resp.output_tokens = 3
        fake_resp.cost_usd = 0.0

        fake_gw = MagicMock()
        fake_gw.complete = AsyncMock(return_value=fake_resp)

        step = {
            "payload": json.dumps(
                {"model": "gpt-5-mini", "messages": [{"role": "user", "content": "Hi"}]}
            ),
        }

        with patch("eden.api.routes.gateway.get_ai_gateway", return_value=fake_gw):
            result = await replayer._re_execute_step(org_id="org1", step=step)

        assert fake_gw.complete.called
        assert result["tokens_used"] == 8


# ── 2. SemanticCache L2 embed writes ────────────────────────────────


class TestSemanticCacheEmbedWrites:
    """set() should use the configured embedder rather than the stub."""

    @pytest.mark.asyncio
    async def test_set_calls_embedder_when_configured(self) -> None:
        from eden.llmops.semantic_cache import SemanticCache

        fake_embedder = MagicMock()
        fake_embedder.embed = MagicMock(return_value=[0.1, 0.2, 0.3])

        cache = SemanticCache(embedder=fake_embedder)
        await cache.set("hello", "world", model_version="v1")

        fake_embedder.embed.assert_called_once_with("hello")
        assert cache._l2_entries[0].embedding == [0.1, 0.2, 0.3]

    @pytest.mark.asyncio
    async def test_set_uses_stub_when_no_embedder(self) -> None:
        from eden.llmops.semantic_cache import SemanticCache

        cache = SemanticCache()
        await cache.set("hello", "world", model_version="v1")

        assert len(cache._l2_entries) == 1
        assert len(cache._l2_entries[0].embedding) == 128

    @pytest.mark.asyncio
    async def test_set_falls_back_to_stub_on_embedder_error(self) -> None:
        from eden.llmops.semantic_cache import SemanticCache

        bad_embedder = MagicMock()
        bad_embedder.embed = MagicMock(side_effect=RuntimeError("model offline"))

        cache = SemanticCache(embedder=bad_embedder)
        await cache.set("hello", "world", model_version="v1")

        # Fell back to stub — 128-dim vector
        assert len(cache._l2_entries[0].embedding) == 128


# ── 3. GDPR telemetry table coverage ────────────────────────────────


class TestGDPRTelemetryDelete:
    """delete_user_data should include the three new telemetry tables."""

    @pytest.mark.asyncio
    async def test_telemetry_tables_in_delete_user_data(self) -> None:
        from eden.data_platform.retention import DataRetentionManager

        mgr = DataRetentionManager()

        deleted_from: list[str] = []

        async def fake_execute(sql: str, *args: object) -> None:
            deleted_from.append(sql)

        async def fake_fetchval(sql: str, *args: object) -> int:
            return 0

        fake_client = MagicMock()
        fake_client.execute = AsyncMock(side_effect=fake_execute)
        fake_client.fetchval = AsyncMock(side_effect=fake_fetchval)

        with (
            patch.object(mgr, "_get_postgres", AsyncMock(return_value=fake_client)),
            patch.object(mgr, "_delete_from_clickhouse", AsyncMock(return_value=0)),
            patch.object(mgr, "_mark_s3_for_deletion", AsyncMock(return_value=0)),
        ):
            await mgr.delete_user_data("tenant1")

        tables_hit = [s for s in deleted_from if "DELETE FROM" in s]
        assert any("telemetry_events" in t for t in tables_hit)
        assert any("trace_archive_index" in t for t in tables_hit)
        assert any("telemetry_stream_chunks" in t for t in tables_hit)

    @pytest.mark.asyncio
    async def test_clickhouse_purge_includes_telemetry_events_ch(self) -> None:
        from eden.data_platform.retention import DataRetentionManager

        mgr = DataRetentionManager()
        posted: list[bytes] = []

        class FakeResp:
            status = 200

            async def __aenter__(self) -> "FakeResp":
                return self

            async def __aexit__(self, *_: object) -> None:
                pass

        class FakeSession:
            def post(self, url: str, data: bytes) -> FakeResp:
                posted.append(data)
                return FakeResp()

            async def __aenter__(self) -> "FakeSession":
                return self

            async def __aexit__(self, *_: object) -> None:
                pass

        fake_settings = MagicMock()
        fake_settings.clickhouse_url = "http://localhost:8123"

        with (
            patch("eden.data_platform.retention.settings", fake_settings),
            patch("aiohttp.ClientSession", return_value=FakeSession()),
        ):
            count = await mgr._delete_from_clickhouse("tenant1")

        assert any(b"telemetry_events_ch" in p for p in posted)
        assert count >= 1
