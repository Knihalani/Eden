"""Eden CLI configuration.

Loads configuration from three sources (highest priority wins):

    1. CLI flags (passed to ``load_config`` as kwargs)
    2. ``./.eden/config.yaml`` (project)
    3. ``~/.eden/config.yaml`` (global)
    4. Environment variables (``EDEN_API_KEY``, ``EDEN_BASE_URL`` etc.)
    5. Built-in defaults

Pydantic models are used so the rest of the CLI gets a typed config
object with no string-keyed dict spelunking.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import BaseModel, Field


# ── Defaults ────────────────────────────────────────────────────────────

DEFAULTS: dict[str, Any] = {
    "base_url": "http://localhost:8000",
    "org_id": None,
    "autonomy": "approval",  # approval | semi | autonomous
    "default_model": None,    # if None, use model_router default slot
    "context": {
        "kb_token_budget": 4000,
        "observability_token_budget": 2000,
        "cache_ttl_seconds": 300,
    },
    "models": {
        "reasoning": "anthropic/claude-sonnet-4.6",
        "code": "qwen/qwen3-coder:free",
        "fast": "deepseek/deepseek-v4-flash:free",
        "fallback": "meta-llama/llama-3.3-70b-instruct",
    },
    "improve": {
        "max_files_in_repo_map": 200,
        "default_depth": "deep",  # quick | deep
        "llm_temperature_analysis": 0.2,
        "llm_temperature_refinement": 0.1,
    },
    "pattern_miner": {
        "enabled": False,
        "interval_minutes": 60,
    },
}


# ── Models ──────────────────────────────────────────────────────────────


class ContextConfig(BaseModel):
    kb_token_budget: int = 4000
    observability_token_budget: int = 2000
    cache_ttl_seconds: int = 300


class ModelsConfig(BaseModel):
    reasoning: str = "anthropic/claude-sonnet-4.6"
    code: str = "qwen/qwen3-coder:free"
    fast: str = "deepseek/deepseek-v4-flash:free"
    fallback: str = "meta-llama/llama-3.3-70b-instruct"


class ImproveConfig(BaseModel):
    max_files_in_repo_map: int = 200
    default_depth: str = "deep"  # quick | deep
    llm_temperature_analysis: float = 0.2
    llm_temperature_refinement: float = 0.1


class PatternMinerConfig(BaseModel):
    enabled: bool = False
    interval_minutes: int = 60


class EdenCLIConfig(BaseModel):
    """Resolved Eden CLI configuration."""

    api_key: Optional[str] = None
    base_url: str = "http://localhost:8000"
    org_id: Optional[str] = None
    autonomy: str = "approval"
    default_model: Optional[str] = None

    context: ContextConfig = Field(default_factory=ContextConfig)
    models: ModelsConfig = Field(default_factory=ModelsConfig)
    improve: ImproveConfig = Field(default_factory=ImproveConfig)
    pattern_miner: PatternMinerConfig = Field(default_factory=PatternMinerConfig)

    # Diagnostic
    config_path_global: Optional[Path] = None
    config_path_project: Optional[Path] = None

    @property
    def is_authenticated(self) -> bool:
        return bool(self.api_key and self.org_id)


# ── Loaders ─────────────────────────────────────────────────────────────


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if not isinstance(data, dict):
            return {}
        # Allow `eden:` top-level key for namespacing
        return data.get("eden", data)
    except (OSError, yaml.YAMLError):
        return {}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """Recursively merge override onto base; override wins."""
    out = dict(base)
    for k, v in override.items():
        if k in out and isinstance(out[k], dict) and isinstance(v, dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _env_overrides() -> dict[str, Any]:
    """Read EDEN_* environment variables into the config shape."""
    out: dict[str, Any] = {}
    if (v := os.environ.get("EDEN_API_KEY")) is not None:
        out["api_key"] = v
    if (v := os.environ.get("EDEN_BASE_URL")) is not None:
        out["base_url"] = v
    if (v := os.environ.get("EDEN_ORG_ID")) is not None:
        out["org_id"] = v
    if (v := os.environ.get("EDEN_AUTONOMY")) is not None:
        out["autonomy"] = v
    if (v := os.environ.get("EDEN_MODEL")) is not None:
        out["default_model"] = v
    return out


def load_config(
    *,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    org_id: Optional[str] = None,
    autonomy: Optional[str] = None,
    default_model: Optional[str] = None,
    project_root: Optional[Path] = None,
) -> EdenCLIConfig:
    """Resolve config from all sources, in priority order.

    Args:
        api_key, base_url, org_id, autonomy, default_model: CLI overrides (highest priority).
        project_root: directory to search for ``./.eden/config.yaml``. Defaults to CWD.
    """
    root = project_root or Path.cwd()

    global_path = Path.home() / ".eden" / "config.yaml"
    project_path = root / ".eden" / "config.yaml"

    # 5. defaults
    merged: dict[str, Any] = dict(DEFAULTS)
    # 3. global yaml
    merged = _deep_merge(merged, _read_yaml(global_path))
    # 2. project yaml
    merged = _deep_merge(merged, _read_yaml(project_path))
    # 4. env
    merged = _deep_merge(merged, _env_overrides())
    # 1. CLI flags
    cli_overrides: dict[str, Any] = {}
    if api_key is not None:
        cli_overrides["api_key"] = api_key
    if base_url is not None:
        cli_overrides["base_url"] = base_url
    if org_id is not None:
        cli_overrides["org_id"] = org_id
    if autonomy is not None:
        cli_overrides["autonomy"] = autonomy
    if default_model is not None:
        cli_overrides["default_model"] = default_model
    merged = _deep_merge(merged, cli_overrides)

    cfg = EdenCLIConfig.model_validate(merged)
    cfg.config_path_global = global_path if global_path.exists() else None
    cfg.config_path_project = project_path if project_path.exists() else None
    return cfg


def scaffold_config(path: Path, *, force: bool = False) -> Path:
    """Write a starter config file. Returns the path written.

    If the file already exists and ``force`` is False, returns the existing path.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not force:
        return path

    body = (
        "# Eden Agent CLI configuration\n"
        "# See https://docs.eden.example/cli/config for the full schema\n"
        "eden:\n"
        "  base_url: http://localhost:8000\n"
        "  # org_id: <set me>\n"
        "  # api_key: <set me or use EDEN_API_KEY env var>\n"
        "  autonomy: approval\n"
        "  context:\n"
        "    kb_token_budget: 4000\n"
        "    observability_token_budget: 2000\n"
        "  models:\n"
        "    reasoning: anthropic/claude-sonnet-4.6\n"
        "    code: qwen/qwen3-coder:free\n"
        "    fast: deepseek/deepseek-v4-flash:free\n"
        "    fallback: meta-llama/llama-3.3-70b-instruct\n"
        "  improve:\n"
        "    default_depth: deep\n"
        "  pattern_miner:\n"
        "    enabled: false\n"
        "    interval_minutes: 60\n"
    )
    path.write_text(body, encoding="utf-8")
    return path
