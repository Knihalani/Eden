"""Unit tests for org settings deep-merge in update_org_settings."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def test_deep_merge_shallow_keys() -> None:
    from eden.api.routes.orgs import _deep_merge_settings

    base = {"a": 1, "b": 2}
    patch_ = {"b": 9, "c": 3}
    assert _deep_merge_settings(base, patch_) == {"a": 1, "b": 9, "c": 3}


def test_deep_merge_nested_preserves_siblings() -> None:
    from eden.api.routes.orgs import _deep_merge_settings

    base = {
        "ui": {"theme": "light", "density": "comfortable"},
        "notify": {"email": True},
    }
    patch_ = {"ui": {"theme": "dark"}}
    merged = _deep_merge_settings(base, patch_)
    assert merged == {
        "ui": {"theme": "dark", "density": "comfortable"},
        "notify": {"email": True},
    }
    # Base must not be mutated.
    assert base["ui"]["theme"] == "light"


def test_deep_merge_list_replace() -> None:
    from eden.api.routes.orgs import _deep_merge_settings

    base = {"tags": ["a", "b"], "meta": {"x": 1}}
    patch_ = {"tags": ["c"]}
    merged = _deep_merge_settings(base, patch_)
    assert merged["tags"] == ["c"]
    assert merged["meta"] == {"x": 1}


def test_deep_merge_empty_old_settings() -> None:
    from eden.api.routes.orgs import _deep_merge_settings, _parse_settings_dict

    assert _parse_settings_dict(None) == {}
    assert _parse_settings_dict("") == {}
    assert _parse_settings_dict("{}") == {}
    assert _parse_settings_dict('{"k": 1}') == {"k": 1}
    assert _parse_settings_dict({"already": True}) == {"already": True}

    merged = _deep_merge_settings({}, {"retention_days": 30})
    assert merged == {"retention_days": 30}


@pytest.mark.asyncio
async def test_update_org_settings_writes_merged_and_audits() -> None:
    from eden.api.routes import orgs as mod

    client = MagicMock()
    client.fetchval = AsyncMock(
        return_value=json.dumps({"ui": {"theme": "light", "density": "comfy"}})
    )
    client.execute = AsyncMock(return_value="UPDATE 1")
    audit = AsyncMock()

    with (
        patch.object(mod, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(mod, "log_audit_event", audit),
    ):
        result = await mod.update_org_settings(
            "path-org",
            {"ui": {"theme": "dark"}, "feature_x": True},
            user={"user_id": "u1"},
            org={"org_id": "eden-uuid", "role": "admin"},
        )

    expected = {
        "ui": {"theme": "dark", "density": "comfy"},
        "feature_x": True,
    }
    assert result == {"message": "Settings updated", "settings": expected}
    # UPDATE wrote merged dict
    assert client.execute.await_args.args[1] == expected
    meta = audit.await_args.kwargs["metadata"]
    assert meta["old_settings"] == {"ui": {"theme": "light", "density": "comfy"}}
    assert meta["new_settings"] == expected
