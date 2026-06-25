"""Tests for the ollama-specific SDK integration plan output.

When ``framework=="ollama"`` the integrator must:

  1. Write ``llm_provider: ollama`` + ``ollama_base_url`` into
     ``.eden/config.yaml``.
  2. Emit the ollama-specific bootstrap that sets
     ``OPENAI_BASE_URL=http://localhost:11434/v1`` and
     ``OPENAI_API_KEY=ollama`` *before* ``eden.init()`` — otherwise
     the OpenAI-compatible instrumentor points at api.openai.com and
     misses every local call.
"""

from __future__ import annotations

from pathlib import Path

from eden.integrations.framework_detector import FrameworkDetection
from eden.integrations.sdk_integrator import (
    PROVIDER_BOOTSTRAP_ENVS,
    PYTHON_IMPORT_SNIPPETS,
    PYTHON_INSTRUMENT_PROVIDER_TEMPLATE,
    TS_IMPORT_SNIPPETS,
    _render_python_env_setup,
    build_integration_plan,
    build_integration_plan_from_files,
)


def _detection(framework: str = "ollama", language: str = "python") -> FrameworkDetection:
    return FrameworkDetection(
        framework=framework,
        language=language,
        confidence=0.95,
        entry_points=[],
        matched_markers=[],
        existing_instrumentation=[],
        project_files=[],
    )


# ────────────────────────────────────────────────────────────────────────
# Import snippets
# ────────────────────────────────────────────────────────────────────────


def test_python_import_snippets_contains_ollama():
    assert "ollama" in PYTHON_IMPORT_SNIPPETS
    # Hint to the user reading the diff that this targets Ollama's
    # OpenAI-compat endpoint.
    assert "openai" in PYTHON_IMPORT_SNIPPETS["ollama"].lower()


def test_ts_import_snippets_contains_ollama():
    assert "ollama" in TS_IMPORT_SNIPPETS
    assert "OpenAI" in TS_IMPORT_SNIPPETS["ollama"]


# ────────────────────────────────────────────────────────────────────────
# On-disk plan generation
# ────────────────────────────────────────────────────────────────────────


def test_ollama_plan_sets_llm_provider_in_config(tmp_path: Path):
    plan = build_integration_plan(tmp_path, _detection("ollama", "python"))
    cfg_change = next(c for c in plan.changes if c.path == ".eden/config.yaml")
    assert "llm_provider: ollama" in cfg_change.content
    assert "ollama_base_url: http://localhost:11434" in cfg_change.content


def test_ollama_plan_uses_ollama_bootstrap_template(tmp_path: Path):
    plan = build_integration_plan(tmp_path, _detection("ollama", "python"))
    bootstrap = next(c for c in plan.changes if c.path.startswith("eden_bootstrap"))
    assert "OPENAI_BASE_URL" in bootstrap.content
    assert "http://localhost:11434/v1" in bootstrap.content
    assert "OPENAI_API_KEY" in bootstrap.content
    # Must set env vars BEFORE eden.init so the openai patch picks them up.
    init_idx = bootstrap.content.find("eden.init(")
    env_idx = bootstrap.content.find("OPENAI_BASE_URL")
    assert env_idx < init_idx, "env vars must be set before eden.init()"


def test_openai_plan_does_not_set_ollama_env(tmp_path: Path):
    plan = build_integration_plan(tmp_path, _detection("openai", "python"))
    cfg_change = next(c for c in plan.changes if c.path == ".eden/config.yaml")
    # llm_provider renders blank → YAML parses it as null. Check the
    # actual VALUE, not the comment block (the comment mentions
    # ``ollama`` as one example of a local-model provider).
    import re
    assert re.search(r"^llm_provider:\s*$", cfg_change.content, re.MULTILINE), (
        "llm_provider must be blank/null for non-ollama agents"
    )
    assert not re.search(r"^ollama_base_url:\s*\S", cfg_change.content, re.MULTILINE), (
        "ollama_base_url must be unset for non-ollama agents"
    )
    bootstrap = next(c for c in plan.changes if c.path.startswith("eden_bootstrap"))
    assert "OPENAI_BASE_URL" not in bootstrap.content


def test_ollama_plan_ts_uses_ollama_template(tmp_path: Path, monkeypatch):
    # Add a fake package.json so the TS path actually emits something.
    (tmp_path / "package.json").write_text('{"name": "agent", "version": "1.0.0"}')
    plan = build_integration_plan(tmp_path, _detection("ollama", "typescript"))
    bootstrap = next(c for c in plan.changes if c.path.startswith("eden_bootstrap"))
    assert "OPENAI_BASE_URL" in bootstrap.content
    assert "http://localhost:11434/v1" in bootstrap.content
    assert "OLLAMA_HOST" in bootstrap.content
    # The new generic template uses env-driven init; the framework slot
    # is the only provider-specific knob in the init() call.
    assert '"ollama"' in bootstrap.content


# ────────────────────────────────────────────────────────────────────────
# In-memory plan generation (used by the PR-opener flow)
# ────────────────────────────────────────────────────────────────────────


def test_ollama_plan_from_files_sets_provider():
    files = {
        "requirements.txt": "ollama==0.4.0\n",
        "agent.py": "from ollama import chat\n",
    }
    plan = build_integration_plan_from_files(files, _detection("ollama", "python"))
    cfg_change = next(c for c in plan.changes if c.path == ".eden/config.yaml")
    assert "llm_provider: ollama" in cfg_change.content


# ────────────────────────────────────────────────────────────────────────
# Template sanity
# ────────────────────────────────────────────────────────────────────────


def test_python_ollama_template_format_renders_cleanly():
    env_setup = _render_python_env_setup("ollama")
    rendered = PYTHON_INSTRUMENT_PROVIDER_TEMPLATE.format(
        env_setup=env_setup, framework_repr="'ollama'"
    )
    # The format should not raise, and the framework slot + env-setup should land.
    assert "'ollama'" in rendered
    assert "OPENAI_BASE_URL" in rendered
    assert "OPENAI_API_KEY" in rendered
    assert "OLLAMA_HOST" in rendered


def test_provider_bootstrap_envs_includes_all_documented_providers():
    # The matrix of providers the onboarding flow supports. Adding a
    # new provider = one entry here + one marker in framework_detector.
    expected = {
        "openai", "anthropic", "ollama", "ollama_cloud",
        "vllm", "lmstudio", "llamacpp",
    }
    assert expected.issubset(PROVIDER_BOOTSTRAP_ENVS.keys()), (
        f"missing providers: {expected - PROVIDER_BOOTSTRAP_ENVS.keys()}"
    )


def test_render_python_env_setup_ollama_cloud_uses_env_var_for_key():
    rendered = _render_python_env_setup("ollama_cloud")
    assert "OPENAI_BASE_URL" in rendered
    assert "https://ollama.com/v1" in rendered
    # Key should be read from env var, not baked in.
    assert "OLLAMA_CLOUD_API_KEY" in rendered
    assert "sk-" not in rendered  # no literal secret


def test_render_python_env_setup_openai_is_empty():
    """The canonical OpenAI entry has no overrides — uses api.openai.com by default
    and reads OPENAI_API_KEY from the SDK natively."""
    rendered = _render_python_env_setup("openai")
    assert rendered == ""


def test_render_python_env_setup_anthropic_is_empty():
    """Anthropic SDK reads ANTHROPIC_API_KEY natively — no overrides needed."""
    rendered = _render_python_env_setup("anthropic")
    assert rendered == ""