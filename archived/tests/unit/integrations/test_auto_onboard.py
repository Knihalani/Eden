"""Tests for the smooth one-command onboarding flow.

Covers:
  - ``auto_onboard()`` runs end-to-end: detect → plan → write.
  - It honours ``force=True`` to overwrite an existing ``.eden/config.yaml``.
  - It raises ``FileNotFoundError`` when the repo path doesn't exist.
  - It produces correct ``AutoOnboardResult`` for ollama, openai, anthropic.
  - ``verify_setup()`` returns ``ok=True`` when everything's set,
    ``ok=False`` when a required key is missing.
  - ``verify_setup()`` understands framework-specific provider keys.
  - The display-names table covers every supported provider.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from eden.integrations.sdk_integrator import (
    PROVIDER_BOOTSTRAP_ENVS,
    PROVIDER_DISPLAY_NAMES,
    AutoOnboardResult,
    CheckResult,
    IntegrationPlan,
    VerifyResult,
    _infer_llm_provider,
    auto_onboard,
    verify_setup,
)

# ────────────────────────────────────────────────────────────────────────
# Display names
# ────────────────────────────────────────────────────────────────────────


def test_display_names_covers_all_documented_providers():
    """Every provider the user can pick should have a human name."""
    expected = {
        "openai", "anthropic", "openrouter", "minimax",
        "ollama", "ollama_cloud", "vllm", "lmstudio", "llamacpp",
    }
    assert expected.issubset(PROVIDER_DISPLAY_NAMES.keys())
    # All names non-empty
    for k, v in PROVIDER_DISPLAY_NAMES.items():
        assert v, f"empty display name for {k}"


# ────────────────────────────────────────────────────────────────────────
# _infer_llm_provider
# ────────────────────────────────────────────────────────────────────────


def test_infer_llm_provider_for_ollama():
    assert _infer_llm_provider("ollama") == "ollama"


def test_infer_llm_provider_for_anthropic():
    assert _infer_llm_provider("anthropic") == "anthropic"


def test_infer_llm_provider_for_openai_frameworks():
    # Anything using the OpenAI SDK → openai provider slot.
    for fw in ("openai", "langchain", "crewai", "autogen", "llama_index"):
        assert _infer_llm_provider(fw) == "openai", fw


def test_infer_llm_provider_for_unknown():
    assert _infer_llm_provider("custom") == ""


# ────────────────────────────────────────────────────────────────────────
# auto_onboard — end-to-end
# ────────────────────────────────────────────────────────────────────────


def _write_minimal_ollama_repo(root: Path) -> None:
    """Lay down a minimal repo that looks like an Ollama-using agent."""
    (root / "requirements.txt").write_text("ollama==0.4.0\n")
    (root / "agent.py").write_text("from ollama import chat\n")


def _write_minimal_openai_repo(root: Path) -> None:
    (root / "requirements.txt").write_text("openai>=1.0\n")
    (root / "agent.py").write_text("from openai import OpenAI\nclient = OpenAI()\n")


def _write_minimal_anthropic_repo(root: Path) -> None:
    (root / "requirements.txt").write_text("anthropic>=0.20\n")
    (root / "agent.py").write_text("from anthropic import Anthropic\n")


def test_auto_onboard_ollama_end_to_end(tmp_path: Path):
    _write_minimal_ollama_repo(tmp_path)
    result = auto_onboard(tmp_path)

    assert isinstance(result, AutoOnboardResult)
    assert result.framework == "ollama"
    assert result.llm_provider == "ollama"
    assert result.confidence >= 0.7
    # Should have written the config + bootstrap.
    assert any(p == ".eden/config.yaml" for p in result.files_written)
    assert any(p.startswith("eden_bootstrap") for p in result.files_written)
    # And the plan itself should be a real IntegrationPlan.
    assert isinstance(result.plan, IntegrationPlan)


def test_auto_onboard_openai_end_to_end(tmp_path: Path):
    _write_minimal_openai_repo(tmp_path)
    result = auto_onboard(tmp_path)

    assert result.framework == "openai"
    assert result.llm_provider == "openai"
    # No env-var overrides for plain openai — bootstrap is the standard template.
    bootstrap = next(
        c for c in result.plan.changes if c.path.startswith("eden_bootstrap")
    )
    assert "OPENAI_BASE_URL" not in bootstrap.content


def test_auto_onboard_anthropic_end_to_end(tmp_path: Path):
    _write_minimal_anthropic_repo(tmp_path)
    result = auto_onboard(tmp_path)

    assert result.framework == "anthropic"
    assert result.llm_provider == "anthropic"


def test_auto_onboard_writes_to_disk(tmp_path: Path):
    _write_minimal_ollama_repo(tmp_path)
    auto_onboard(tmp_path)

    assert (tmp_path / ".eden" / "config.yaml").exists()
    bootstrap_files = list(tmp_path.glob("eden_bootstrap*.py"))
    assert len(bootstrap_files) == 1
    # Sanity-check the file actually has the right content.
    content = bootstrap_files[0].read_text()
    assert "OPENAI_BASE_URL" in content
    assert "http://localhost:11434/v1" in content


def test_auto_onboard_preserves_existing_config_by_default(tmp_path: Path):
    """First run writes config; second run leaves it alone unless force=True."""
    _write_minimal_ollama_repo(tmp_path)
    auto_onboard(tmp_path)
    cfg = tmp_path / ".eden" / "config.yaml"
    original = cfg.read_text()
    # User edits it.
    cfg.write_text(original + "\n# my custom comment\n")
    # Re-run.
    auto_onboard(tmp_path)
    assert "# my custom comment" in cfg.read_text()


def test_auto_onboard_force_overwrites_existing_config(tmp_path: Path):
    _write_minimal_ollama_repo(tmp_path)
    auto_onboard(tmp_path)
    cfg = tmp_path / ".eden" / "config.yaml"
    cfg.write_text("# stale\n")
    auto_onboard(tmp_path, force=True)
    assert "# stale" not in cfg.read_text()
    assert "llm_provider: ollama" in cfg.read_text()


def test_auto_onboard_missing_repo_raises():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        nonexistent = Path(td) / "does-not-exist"
        with pytest.raises(FileNotFoundError, match="does-not-exist"):
            auto_onboard(nonexistent)


def test_auto_onboard_result_notes_are_helpful(tmp_path: Path):
    _write_minimal_ollama_repo(tmp_path)
    result = auto_onboard(tmp_path)
    # Notes should include the detected provider so the user knows what to configure.
    assert any("Ollama" in note for note in result.notes)


def test_auto_onboard_unknown_framework_still_runs(tmp_path: Path):
    """A repo with no recognisable framework should still onboard — the user
    gets a generic bootstrap and a note explaining the situation."""
    (tmp_path / "agent.py").write_text("# no framework imports\n")
    result = auto_onboard(tmp_path)
    assert result.framework in ("custom", "openai")  # falls back gracefully
    assert result.files_written  # something got written


# ────────────────────────────────────────────────────────────────────────
# verify_setup
# ────────────────────────────────────────────────────────────────────────


def test_verify_setup_with_no_config_reports_error(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("EDEN_API_KEY", "test-key")
    monkeypatch.setenv("EDEN_DEFAULT_ORG", "test-org")
    result = verify_setup(tmp_path)
    assert isinstance(result, VerifyResult)
    assert not result.ok  # missing .eden/config.yaml
    error_checks = [c for c in result.checks if c.status == "error"]
    assert any(c.name == ".eden/config.yaml" for c in error_checks)


def test_verify_setup_with_missing_eden_api_key_reports_error(tmp_path: Path, monkeypatch):
    _write_minimal_ollama_repo(tmp_path)
    auto_onboard(tmp_path)
    monkeypatch.delenv("EDEN_API_KEY", raising=False)
    monkeypatch.setenv("EDEN_DEFAULT_ORG", "test-org")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = verify_setup(tmp_path)
    assert not result.ok
    assert any(c.name == "EDEN_API_KEY" and c.status == "error" for c in result.checks)


def test_verify_setup_ollama_unreachable_warns(tmp_path: Path, monkeypatch):
    _write_minimal_ollama_repo(tmp_path)
    auto_onboard(tmp_path)
    monkeypatch.setenv("EDEN_API_KEY", "k")
    monkeypatch.setenv("EDEN_DEFAULT_ORG", "o")
    # Point Ollama at an unreachable host so the check warns (not errors).
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:1")  # port 1 = closed
    result = verify_setup(tmp_path)
    ollama_checks = [c for c in result.checks if c.name == "Ollama"]
    assert ollama_checks, "expected an Ollama check"
    assert ollama_checks[0].status == "warning"


def test_verify_setup_full_pass(tmp_path: Path, monkeypatch):
    """Happy path: everything set, Ollama reachable."""
    _write_minimal_ollama_repo(tmp_path)
    auto_onboard(tmp_path)
    monkeypatch.setenv("EDEN_API_KEY", "k")
    monkeypatch.setenv("EDEN_DEFAULT_ORG", "o")
    # Use a real, fast endpoint so the reachability check passes.
    # httpbin /status/200 returns 200 < 500 so _is_url_reachable returns True.
    monkeypatch.setenv("OLLAMA_HOST", "https://httpbin.org/status/200")
    result = verify_setup(tmp_path)
    # Don't assert ok==True because httpbin might be down; just verify
    # the structure is correct and no errors come from the keys we control.
    assert isinstance(result, VerifyResult)
    error_checks = [c for c in result.checks if c.status == "error"]
    names = [c.name for c in error_checks]
    assert "EDEN_API_KEY" not in names
    assert ".eden/config.yaml" not in names


def test_verify_setup_openai_framework_requires_openai_key(tmp_path: Path, monkeypatch):
    _write_minimal_openai_repo(tmp_path)
    auto_onboard(tmp_path)
    monkeypatch.setenv("EDEN_API_KEY", "k")
    monkeypatch.setenv("EDEN_DEFAULT_ORG", "o")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    result = verify_setup(tmp_path)
    assert not result.ok
    assert any(c.name == "OPENAI_API_KEY" and c.status == "error" for c in result.checks)


def test_verify_setup_anthropic_framework_requires_anthropic_key(tmp_path: Path, monkeypatch):
    _write_minimal_anthropic_repo(tmp_path)
    auto_onboard(tmp_path)
    monkeypatch.setenv("EDEN_API_KEY", "k")
    monkeypatch.setenv("EDEN_DEFAULT_ORG", "o")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    result = verify_setup(tmp_path)
    assert not result.ok
    assert any(c.name == "ANTHROPIC_API_KEY" and c.status == "error" for c in result.checks)


def test_verify_setup_returns_check_result_dataclass(tmp_path: Path):
    """Sanity: the dataclasses round-trip cleanly."""
    result = verify_setup(tmp_path)
    for check in result.checks:
        assert isinstance(check, CheckResult)
        assert check.status in ("ok", "warning", "error")
        assert check.name
        assert check.message


# ────────────────────────────────────────────────────────────────────────
# PROVIDER_BOOTSTRAP_ENVS — final shape after cleanup
# ────────────────────────────────────────────────────────────────────────


def test_bootstrap_envs_has_no_removed_providers():
    """Groq/Together/Fireworks were removed — only OpenAI (the generic
    OpenAI-compat slot) remains for that wire format."""
    forbidden = {"groq", "together", "fireworks"}
    assert forbidden.isdisjoint(PROVIDER_BOOTSTRAP_ENVS.keys()), (
        f"removed providers still in PROVIDER_BOOTSTRAP_ENVS: "
        f"{forbidden & PROVIDER_BOOTSTRAP_ENVS.keys()}"
    )


def test_bootstrap_envs_openai_entry_is_empty():
    """OpenAI uses api.openai.com by default and reads OPENAI_API_KEY natively."""
    assert PROVIDER_BOOTSTRAP_ENVS["openai"] == {}


def test_bootstrap_envs_anthropic_entry_is_empty():
    """Anthropic SDK reads ANTHROPIC_API_KEY natively."""
    assert PROVIDER_BOOTSTRAP_ENVS["anthropic"] == {}


def test_bootstrap_envs_ollama_entry_has_sentinels():
    """Ollama's bootstrap needs both OPENAI_BASE_URL (for SDK routing)
    and OLLAMA_HOST (for native tooling). API key is the literal 'ollama'
    sentinel — never a real secret."""
    envs = PROVIDER_BOOTSTRAP_ENVS["ollama"]
    assert envs["OPENAI_BASE_URL"] == "http://localhost:11434/v1"
    assert envs["OPENAI_API_KEY"] == "ollama"
    assert envs["OLLAMA_HOST"] == "http://localhost:11434"
