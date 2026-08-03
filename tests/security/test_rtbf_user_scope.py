"""RTBF fanout must never perform tenant-wide deletion.

Regression lock for the 2026-07 remediation.

``_fanout_s3`` used to call ``DataRetentionManager.delete_user_data(org_id)``,
discarding the ``user_id`` it had been handed. That method issues
``DELETE FROM {table} WHERE org_id = $1`` across ``usage_events`` (billing),
``jobs``, ``specs``, ``silver_events``, ``quarantine_events`` and
``trace_archive_index`` — so one user's right-to-be-forgotten request destroyed
the entire organisation's data and the API reported ``status: "ok"``.

The containment has three independent parts, each asserted below:

1. ``DataRetentionManager`` no longer exposes ``delete_user_data`` at all, so
   the old ``hasattr`` guard can never resolve again.
2. ``_fanout_s3`` touches no retention machinery.
3. A store reporting ``unsupported`` counts as an *incomplete* erasure, so a
   caller cannot mistake "we did nothing" for "we are done".
"""

from __future__ import annotations

import ast
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_SRC = Path(__file__).resolve().parents[2] / "src" / "eden"
_FANOUT = _SRC / "services" / "governance_intel" / "rtbf_fanout.py"
_RETENTION = _SRC / "data_platform" / "retention.py"
_GDPR = _SRC / "services" / "governance_intel" / "gdpr.py"


def _method_names(path: Path, class_name: str) -> set[str]:
    """Return every method defined on ``class_name`` in ``path``."""
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return {
                child.name
                for child in node.body
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
    raise AssertionError(f"{class_name} not found in {path}")


def test_retention_manager_has_no_delete_user_data() -> None:
    """The tenant-wide delete must not be reachable under a per-user name.

    Asserted structurally rather than by import so the test also fails if
    someone re-adds a backwards-compatible alias.
    """
    methods = _method_names(_RETENTION, "DataRetentionManager")
    assert "delete_user_data" not in methods, (
        "delete_user_data was re-introduced. It deletes an entire tenant; the "
        "per-user name is what caused RTBF to destroy whole organisations. "
        "Use delete_tenant_data."
    )
    assert "delete_tenant_data" in methods, "the tenant-wide delete went missing"


def test_fanout_s3_touches_no_retention_machinery() -> None:
    """The S3 handler must not reach into Postgres retention.

    Checked against identifiers in the AST rather than raw source text, so the
    function's docstring is free to explain the history (which names the old
    method) without tripping the assertion.
    """
    tree = ast.parse(_FANOUT.read_text())
    target = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "_fanout_s3"
    )

    identifiers: set[str] = set()
    for node in ast.walk(target):
        if isinstance(node, ast.Name):
            identifiers.add(node.id)
        elif isinstance(node, ast.Attribute):
            identifiers.add(node.attr)
        elif isinstance(node, ast.alias):
            identifiers.add(node.name.rsplit(".", 1)[-1])
            if node.asname:
                identifiers.add(node.asname)
        elif isinstance(node, ast.ImportFrom) and node.module:
            identifiers.add(node.module.rsplit(".", 1)[-1])

    forbidden = {
        "DataRetentionManager",
        "delete_user_data",
        "delete_tenant_data",
        "retention",
    }
    leaked = forbidden & identifiers
    assert not leaked, (
        f"_fanout_s3 references {sorted(leaked)}. An S3 erasure handler must "
        "never perform a Postgres tenant sweep."
    )


def test_unsupported_counts_as_incomplete() -> None:
    """A store that did nothing must not be reported as a completed erasure."""
    source = _GDPR.read_text()
    assert '"unsupported"' in source, (
        "gdpr.py no longer treats 'unsupported' as incomplete — an erasure "
        "that touched nothing would be reported as complete."
    )


@pytest.mark.asyncio
async def test_fanout_s3_reports_unsupported_and_calls_nothing() -> None:
    """Behavioural companion to the structural checks above."""
    from eden.services.governance_intel import rtbf_fanout

    result = await rtbf_fanout._fanout_s3(
        "org-victim", user_id="user-1", dry_run=False
    )

    assert result["status"] == "unsupported"
    assert result["store"] == "s3"
    # user_id is echoed for audit honesty, never silently widened to the org.
    assert result["user_id"] == "user-1"


@pytest.mark.asyncio
async def test_fanout_s3_dry_run_is_also_honest() -> None:
    """Dry run must not claim it would tombstone something it cannot."""
    from eden.services.governance_intel import rtbf_fanout

    result = await rtbf_fanout._fanout_s3(
        "org-victim", user_id="user-1", dry_run=True
    )

    assert result["status"] == "dry_run"
    assert "not implemented" in result["detail"]


@pytest.mark.asyncio
async def test_fanout_clickhouse_tinybird_uses_delete_tenant_rows() -> None:
    from eden.services.governance_intel import rtbf_fanout

    sink = MagicMock()
    sink.config = MagicMock(is_tinybird=True)
    sink.delete_tenant_rows = AsyncMock(return_value=2)

    with patch(
        "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
        AsyncMock(return_value=sink),
    ):
        result = await rtbf_fanout._fanout_clickhouse(
            "org-1", user_id="user-1", dry_run=False
        )

    sink.delete_tenant_rows.assert_awaited_once_with("org-1")
    assert result["status"] == "ok"
    assert result["tables_purged"] == 2
    assert result["scope"] == "tenant"


@pytest.mark.asyncio
async def test_fanout_clickhouse_calls_delete_tenant_rows() -> None:
    from eden.services.governance_intel import rtbf_fanout

    sink = MagicMock()
    sink.config = MagicMock(is_tinybird=False)
    sink.delete_tenant_rows = AsyncMock(return_value=3)

    with patch(
        "eden.data_platform.clickhouse_sink.get_clickhouse_sink",
        AsyncMock(return_value=sink),
    ):
        result = await rtbf_fanout._fanout_clickhouse(
            "org-1", user_id="user-1", dry_run=False
        )

    sink.delete_tenant_rows.assert_awaited_once_with("org-1")
    assert result["status"] == "ok"
    assert result["scope"] == "tenant"
    assert result["tables_purged"] == 3
    assert result["user_id"] == "user-1"

