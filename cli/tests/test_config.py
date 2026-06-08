"""Tests for ``eden.config`` — config loading + scaffolding."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from eden.config import (
    ContextConfig,
    EdenCLIConfig,
    ImproveConfig,
    ModelsConfig,
    PatternMinerConfig,
    load_config,
    scaffold_config,
)


def test_defaults_match_schema():
    cfg = EdenCLIConfig()
    assert cfg.base_url == "http://localhost:8000"
    assert cfg.autonomy == "approval"
    assert isinstance(cfg.context, ContextConfig)
    assert isinstance(cfg.models, ModelsConfig)
    assert isinstance(cfg.improve, ImproveConfig)
    assert isinstance(cfg.pattern_miner, PatternMinerConfig)


def test_default_token_budgets():
    cfg = EdenCLIConfig()
    assert cfg.context.kb_token_budget == 4000
    assert cfg.context.observability_token_budget == 2000


def test_load_config_returns_defaults_when_no_files(tmp_path: Path, monkeypatch):
    # Make sure no real ~/.eden/config.yaml leaks in
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    cfg = load_config(project_root=tmp_path)
    assert cfg.base_url == "http://localhost:8000"
    assert cfg.autonomy == "approval"
    assert cfg.config_path_global is None
    assert cfg.config_path_project is None


def test_load_config_merges_project_yaml(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    project_cfg = tmp_path / ".eden" / "config.yaml"
    project_cfg.parent.mkdir(parents=True, exist_ok=True)
    project_cfg.write_text(
        "eden:\n"
        "  base_url: http://eden.example:9000\n"
        "  autonomy: autonomous\n"
        "  context:\n"
        "    kb_token_budget: 1234\n"
    )
    cfg = load_config(project_root=tmp_path)
    assert cfg.base_url == "http://eden.example:9000"
    assert cfg.autonomy == "autonomous"
    assert cfg.context.kb_token_budget == 1234
    # Non-overridden default survives
    assert cfg.context.observability_token_budget == 2000


def test_load_config_env_var_overrides(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("EDEN_API_KEY", "env-key")
    monkeypatch.setenv("EDEN_BASE_URL", "http://from-env")
    monkeypatch.setenv("EDEN_ORG_ID", "env-org")
    monkeypatch.setenv("EDEN_AUTONOMY", "semi")
    monkeypatch.setenv("EDEN_MODEL", "anthropic/claude-sonnet-4.6")
    cfg = load_config(project_root=tmp_path)
    assert cfg.api_key == "env-key"
    assert cfg.base_url == "http://from-env"
    assert cfg.org_id == "env-org"
    assert cfg.autonomy == "semi"
    assert cfg.default_model == "anthropic/claude-sonnet-4.6"


def test_load_config_cli_flags_win(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("EDEN_BASE_URL", "http://from-env")
    cfg = load_config(
        project_root=tmp_path,
        base_url="http://from-cli",
        autonomy="autonomous",
    )
    assert cfg.base_url == "http://from-cli"
    assert cfg.autonomy == "autonomous"


def test_scaffold_config_creates_file(tmp_path: Path):
    target = tmp_path / "config.yaml"
    out = scaffold_config(target)
    assert out == target
    assert target.exists()
    body = target.read_text()
    assert "base_url:" in body
    assert "kb_token_budget:" in body


def test_scaffold_config_does_not_overwrite(tmp_path: Path):
    target = tmp_path / "config.yaml"
    target.write_text("# user content\n")
    out = scaffold_config(target)
    assert out == target
    assert target.read_text() == "# user content\n"


def test_scaffold_config_force_overwrites(tmp_path: Path):
    target = tmp_path / "config.yaml"
    target.write_text("# user content\n")
    scaffold_config(target, force=True)
    assert "base_url:" in target.read_text()


def test_is_authenticated_flag():
    cfg = EdenCLIConfig(api_key="k", org_id="o")
    assert cfg.is_authenticated
    cfg2 = EdenCLIConfig()
    assert not cfg2.is_authenticated
