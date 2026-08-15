"""Per-leg unit tests for RTBF cross-store fanout (OOM plan 9.13 / W1-18).

Covers every leg in ``rtbf_fanout.fanout_rtbf``:
  - typesense     — active erasure (delete_by_user / delete_by_filter)
  - redis         — unsupported (no user_id in key patterns)
  - pgvector      — unsupported (no user_id column)
  - s3            — unsupported (no per-user object index)
  - clickhouse    — tenant-scoped erasure via delete_tenant_rows
  - blob_refs     — best-effort org ref-count release

Each test asserts the exact status and payload the code promises so that
any silent behaviour change breaks the test rather than hiding an erasure
regression.

Note: asyncio_mode = "auto" in pyproject.toml; @pytest.mark.asyncio is
      included only for explicitness, matching the existing reverify tests.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.services.governance_intel import rtbf_fanout


# ────────────────────────────────────────────────────────────────────────────
#  Typesense leg
# ────────────────────────────────────────────────────────────────────────────

class TestFanoutTypesense:
    @pytest.mark.asyncio
    async def test_delete_by_user_happy_path(self) -> None:
        """delete_by_user is called with (org_id, user_id) and count returned."""
        client = MagicMock()
        # ensure_collection is awaited when present; must be AsyncMock
        client.ensure_collection = AsyncMock()
        client.has_user_id_field = AsyncMock(return_value=True)
        client.delete_by_user = AsyncMock(return_value=7)

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-1", user_id="user-1", dry_run=False
            )

        client.delete_by_user.assert_awaited_once_with("org-1", "user-1")
        assert result == {"store": "typesense", "status": "ok", "deleted": 7}

    @pytest.mark.asyncio
    async def test_delete_by_filter_fallback(self) -> None:
        """When delete_by_user is absent, delete_by_filter is tried.

        Use spec to control which attributes exist — a bare MagicMock()
        re-creates deleted attributes via __getattr__, so spec=[] is used
        and then the required attributes are set explicitly.
        """
        # spec=[] prevents hasattr from finding delete_by_user; set only what
        # the client "really has" for this variant.
        client = MagicMock(spec=["ensure_collection", "has_user_id_field", "delete_by_filter"])
        client.ensure_collection = AsyncMock()
        client.has_user_id_field = AsyncMock(return_value=True)
        client.delete_by_filter = AsyncMock(return_value=3)

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-2", user_id="user-2", dry_run=False
            )

        client.delete_by_filter.assert_awaited_once_with(
            "tenant_id:=org-2 && user_id:=user-2"
        )
        assert result["status"] == "ok"
        assert result["deleted"] == 3

    @pytest.mark.asyncio
    async def test_missing_user_id_field_returns_unsupported(self) -> None:
        """Schema without user_id → status=unsupported (not silently deleted=0)."""
        client = MagicMock()
        # ensure_collection must be AsyncMock so it doesn't blow up before the
        # has_user_id_field check is reached.
        client.ensure_collection = AsyncMock()
        client.has_user_id_field = AsyncMock(return_value=False)

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "unsupported"
        assert "user_id" in result.get("error", "")

    @pytest.mark.asyncio
    async def test_client_none_returns_unavailable(self) -> None:
        """None client (no Typesense configured) → status=unavailable."""
        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=None,
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "unavailable"
        assert result["store"] == "typesense"

    @pytest.mark.asyncio
    async def test_import_error_returns_unavailable(self) -> None:
        """Module import failure → status=unavailable (not a crash)."""
        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            side_effect=ImportError("no module"),
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "unavailable"
        assert "no module" in result["error"]

    @pytest.mark.asyncio
    async def test_client_lacks_delete_methods_returns_failed(self) -> None:
        """Client without any delete method → status=failed (not silent skip)."""
        client = MagicMock(spec=[])  # no attributes at all
        client.has_user_id_field = AsyncMock(return_value=True)

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "failed"
        assert "lacks" in result["error"]

    @pytest.mark.asyncio
    async def test_delete_exception_returns_failed(self) -> None:
        """Runtime exception during delete → status=failed with error text."""
        client = MagicMock()
        client.ensure_collection = AsyncMock()
        client.has_user_id_field = AsyncMock(return_value=True)
        client.delete_by_user = AsyncMock(side_effect=RuntimeError("network timeout"))

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "failed"
        assert "network timeout" in result["error"]

    @pytest.mark.asyncio
    async def test_dry_run_returns_dry_run_status(self) -> None:
        """dry_run=True must return status=dry_run without calling the client."""
        client = MagicMock()
        client.delete_by_user = AsyncMock()

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-1", user_id="user-1", dry_run=True
            )

        assert result["status"] == "dry_run"
        client.delete_by_user.assert_not_awaited()


# ────────────────────────────────────────────────────────────────────────────
#  Redis leg
# ────────────────────────────────────────────────────────────────────────────

class TestFanoutRedis:
    @pytest.mark.asyncio
    async def test_returns_unsupported_no_client_needed(self) -> None:
        """Redis has no user_id in key patterns → always unsupported."""
        result = await rtbf_fanout._fanout_redis(
            "org-1", user_id="user-1", dry_run=False
        )

        assert result["store"] == "redis"
        assert result["status"] == "unsupported"
        # user_id echoed for audit honesty
        assert result["user_id"] == "user-1"

    @pytest.mark.asyncio
    async def test_dry_run_returns_dry_run(self) -> None:
        result = await rtbf_fanout._fanout_redis(
            "org-1", user_id="user-1", dry_run=True
        )

        assert result["store"] == "redis"
        assert result["status"] == "dry_run"
        assert result["user_id"] == "user-1"

    @pytest.mark.asyncio
    async def test_unsupported_is_honest_not_deleted_zero(self) -> None:
        """``unsupported`` must NOT be re-labelled as deleted=0 success."""
        result = await rtbf_fanout._fanout_redis(
            "org-x", user_id="u-x", dry_run=False
        )

        assert result["status"] != "ok"
        assert "deleted" not in result


# ────────────────────────────────────────────────────────────────────────────
#  pgvector leg
# ────────────────────────────────────────────────────────────────────────────

class TestFanoutPgvector:
    @pytest.mark.asyncio
    async def test_returns_unsupported_no_client_needed(self) -> None:
        """vector_documents has no user_id column → always unsupported."""
        result = await rtbf_fanout._fanout_pgvector(
            "org-1", user_id="user-1", dry_run=False
        )

        assert result["store"] == "pgvector"
        assert result["status"] == "unsupported"
        assert "user_id" in result.get("error", "")

    @pytest.mark.asyncio
    async def test_dry_run_returns_dry_run(self) -> None:
        result = await rtbf_fanout._fanout_pgvector(
            "org-1", user_id="user-1", dry_run=True
        )

        assert result["store"] == "pgvector"
        assert result["status"] == "dry_run"

    @pytest.mark.asyncio
    async def test_unsupported_is_not_ok(self) -> None:
        result = await rtbf_fanout._fanout_pgvector(
            "org-x", user_id="u-x", dry_run=False
        )

        assert result["status"] != "ok"


# ────────────────────────────────────────────────────────────────────────────
#  S3/archive leg
# ────────────────────────────────────────────────────────────────────────────

class TestFanoutS3:
    @pytest.mark.asyncio
    async def test_returns_unsupported_no_retention_touched(self) -> None:
        """No per-user object index → always unsupported; user_id echoed."""
        result = await rtbf_fanout._fanout_s3(
            "org-1", user_id="user-1", dry_run=False
        )

        assert result["store"] == "s3"
        assert result["status"] == "unsupported"
        assert result["user_id"] == "user-1"

    @pytest.mark.asyncio
    async def test_dry_run_is_honest_about_not_implemented(self) -> None:
        result = await rtbf_fanout._fanout_s3(
            "org-1", user_id="user-1", dry_run=True
        )

        assert result["status"] == "dry_run"
        assert "not implemented" in result.get("detail", "")

    @pytest.mark.asyncio
    async def test_never_touches_retention_machinery(self) -> None:
        """Structural guard: _fanout_s3 must not import or call retention code."""
        import ast
        from pathlib import Path

        src = Path(rtbf_fanout.__file__).read_text()
        tree = ast.parse(src)
        target = next(
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.AsyncFunctionDef)
            and node.name == "_fanout_s3"
        )
        identifiers: set[str] = set()
        for node in ast.walk(target):
            if isinstance(node, ast.Name):
                identifiers.add(node.id)
            elif isinstance(node, ast.Attribute):
                identifiers.add(node.attr)

        forbidden = {"DataRetentionManager", "delete_user_data", "delete_tenant_data"}
        assert not (forbidden & identifiers), (
            f"_fanout_s3 references retention symbols: {forbidden & identifiers}"
        )


# ────────────────────────────────────────────────────────────────────────────
#  ClickHouse / Tinybird leg
# ────────────────────────────────────────────────────────────────────────────

class TestFanoutClickhouse:
    @pytest.mark.asyncio
    async def test_delete_tenant_rows_called_with_org(self) -> None:
        """delete_tenant_rows(org_id) is the correct call; user_id audit-only."""
        sink = MagicMock()
        sink.delete_tenant_rows = AsyncMock(return_value=5)

        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            AsyncMock(return_value=sink),
        ):
            result = await rtbf_fanout._fanout_clickhouse(
                "org-1", user_id="user-1", dry_run=False
            )

        sink.delete_tenant_rows.assert_awaited_once_with("org-1")
        assert result["status"] == "ok"
        assert result["tables_purged"] == 5
        assert result["scope"] == "tenant"
        assert result["user_id"] == "user-1"

    @pytest.mark.asyncio
    async def test_sink_none_returns_unavailable(self) -> None:
        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            AsyncMock(return_value=None),
        ):
            result = await rtbf_fanout._fanout_clickhouse(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "unavailable"
        assert result["store"] == "clickhouse"

    @pytest.mark.asyncio
    async def test_import_error_returns_unavailable(self) -> None:
        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            side_effect=ImportError("missing clickhouse driver"),
        ):
            result = await rtbf_fanout._fanout_clickhouse(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "unavailable"

    @pytest.mark.asyncio
    async def test_sink_without_delete_tenant_rows_returns_failed(self) -> None:
        """Sink client that lacks the method → status=failed, not a crash."""
        sink = MagicMock(spec=[])  # bare mock, no delete_tenant_rows

        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            AsyncMock(return_value=sink),
        ):
            result = await rtbf_fanout._fanout_clickhouse(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "failed"
        assert "lacks delete_tenant_rows" in result["error"]

    @pytest.mark.asyncio
    async def test_delete_exception_returns_failed(self) -> None:
        sink = MagicMock()
        sink.delete_tenant_rows = AsyncMock(
            side_effect=ConnectionError("CH unreachable")
        )

        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            AsyncMock(return_value=sink),
        ):
            result = await rtbf_fanout._fanout_clickhouse(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "failed"
        assert "CH unreachable" in result["error"]

    @pytest.mark.asyncio
    async def test_dry_run_does_not_call_sink(self) -> None:
        sink = MagicMock()
        sink.delete_tenant_rows = AsyncMock()

        with patch(
            "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
            AsyncMock(return_value=sink),
        ):
            result = await rtbf_fanout._fanout_clickhouse(
                "org-1", user_id="user-1", dry_run=True
            )

        assert result["status"] == "dry_run"
        assert result["scope"] == "tenant"
        sink.delete_tenant_rows.assert_not_awaited()


# ────────────────────────────────────────────────────────────────────────────
#  Blob refs leg
# ────────────────────────────────────────────────────────────────────────────

class TestFanoutBlobRefs:
    @pytest.mark.asyncio
    async def test_release_org_called_and_count_returned(self) -> None:
        """release_org(org_id) is called; released count included in result."""
        blob = MagicMock()
        blob.release_org = AsyncMock(return_value=4)

        with patch(
            "eden.observability.compression.blob_store.get_blob_store",
            return_value=blob,
        ):
            result = await rtbf_fanout._fanout_blob_refs(
                "org-1", user_id="user-1", dry_run=False
            )

        blob.release_org.assert_awaited_once_with("org-1")
        assert result["status"] == "ok"
        assert result["released"] == 4
        assert result["user_id"] == "user-1"

    @pytest.mark.asyncio
    async def test_blob_store_none_returns_unavailable(self) -> None:
        with patch(
            "eden.observability.compression.blob_store.get_blob_store",
            return_value=None,
        ):
            result = await rtbf_fanout._fanout_blob_refs(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["store"] == "blob_store"
        assert result["status"] == "unavailable"

    @pytest.mark.asyncio
    async def test_blob_store_without_release_org_returns_ok_zero(self) -> None:
        """Blob store that lacks release_org → ok with released=0 (best-effort)."""
        blob = MagicMock(spec=[])  # no release_org

        with patch(
            "eden.observability.compression.blob_store.get_blob_store",
            return_value=blob,
        ):
            result = await rtbf_fanout._fanout_blob_refs(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "ok"
        assert result["released"] == 0

    @pytest.mark.asyncio
    async def test_import_error_returns_failed(self) -> None:
        with patch(
            "eden.observability.compression.blob_store.get_blob_store",
            side_effect=ImportError("missing blob_store module"),
        ):
            result = await rtbf_fanout._fanout_blob_refs(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "failed"
        assert "missing blob_store module" in result["error"]

    @pytest.mark.asyncio
    async def test_release_exception_returns_failed(self) -> None:
        blob = MagicMock()
        blob.release_org = AsyncMock(side_effect=OSError("storage unreachable"))

        with patch(
            "eden.observability.compression.blob_store.get_blob_store",
            return_value=blob,
        ):
            result = await rtbf_fanout._fanout_blob_refs(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "failed"
        assert "storage unreachable" in result["error"]

    @pytest.mark.asyncio
    async def test_dry_run_does_not_call_release_org(self) -> None:
        blob = MagicMock()
        blob.release_org = AsyncMock()

        with patch(
            "eden.observability.compression.blob_store.get_blob_store",
            return_value=blob,
        ):
            result = await rtbf_fanout._fanout_blob_refs(
                "org-1", user_id="user-1", dry_run=True
            )

        assert result["status"] == "dry_run"
        blob.release_org.assert_not_awaited()


# ────────────────────────────────────────────────────────────────────────────
#  fanout_rtbf integration — verifies the orchestrator calls every leg
# ────────────────────────────────────────────────────────────────────────────

class TestFanoutRtbfIntegration:
    def _make_ts_client(self, deleted: int = 2) -> MagicMock:
        """Build a fully async-safe Typesense client mock."""
        client = MagicMock()
        client.ensure_collection = AsyncMock()
        client.has_user_id_field = AsyncMock(return_value=True)
        client.delete_by_user = AsyncMock(return_value=deleted)
        return client

    @pytest.mark.asyncio
    async def test_returns_result_for_every_leg(self) -> None:
        """fanout_rtbf must return exactly one entry per configured store."""
        ch_sink = MagicMock()
        ch_sink.delete_tenant_rows = AsyncMock(return_value=1)

        blob = MagicMock()
        blob.release_org = AsyncMock(return_value=0)

        with (
            patch(
                "eden.observability.typesense_client.get_typesense_client",
                return_value=self._make_ts_client(),
            ),
            patch(
                "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
                AsyncMock(return_value=ch_sink),
            ),
            patch(
                "eden.observability.compression.blob_store.get_blob_store",
                return_value=blob,
            ),
        ):
            results = await rtbf_fanout.fanout_rtbf(
                "org-1", user_id="user-1", dry_run=False
            )

        stores = {r["store"] for r in results}
        assert stores == {"typesense", "redis", "pgvector", "s3", "clickhouse", "blob_store"}

    @pytest.mark.asyncio
    async def test_dry_run_all_legs_return_dry_run_or_unsupported(self) -> None:
        """In dry_run mode no leg should report ok or failed."""
        ch_sink = MagicMock()
        ch_sink.delete_tenant_rows = AsyncMock(return_value=0)

        blob = MagicMock()
        blob.release_org = AsyncMock(return_value=0)

        with (
            patch(
                "eden.observability.typesense_client.get_typesense_client",
                return_value=self._make_ts_client(deleted=0),
            ),
            patch(
                "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
                AsyncMock(return_value=ch_sink),
            ),
            patch(
                "eden.observability.compression.blob_store.get_blob_store",
                return_value=blob,
            ),
        ):
            results = await rtbf_fanout.fanout_rtbf(
                "org-1", user_id="user-1", dry_run=True
            )

        for r in results:
            assert r["status"] not in ("ok", "failed"), (
                f"Leg {r['store']} returned {r['status']!r} during dry_run"
            )

    @pytest.mark.asyncio
    async def test_no_qdrant_leg_present(self) -> None:
        """Qdrant was replaced by pgvector (N4); no Qdrant leg should exist."""
        ch_sink = MagicMock()
        ch_sink.delete_tenant_rows = AsyncMock(return_value=0)

        blob = MagicMock()
        blob.release_org = AsyncMock(return_value=0)

        with (
            patch(
                "eden.observability.typesense_client.get_typesense_client",
                return_value=self._make_ts_client(deleted=0),
            ),
            patch(
                "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
                AsyncMock(return_value=ch_sink),
            ),
            patch(
                "eden.observability.compression.blob_store.get_blob_store",
                return_value=blob,
            ),
        ):
            results = await rtbf_fanout.fanout_rtbf(
                "org-1", user_id="user-1", dry_run=False
            )

        qdrant_stores = [r for r in results if "qdrant" in r.get("store", "").lower()]
        assert qdrant_stores == [], (
            "Qdrant leg found — it was migrated to pgvector (N4) and must not exist"
        )
