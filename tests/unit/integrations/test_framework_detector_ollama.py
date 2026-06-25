"""Tests for ollama detection in the framework detector.

Ollama is the local-model provider.  The detector needs to recognise it
by three signals, with the strongest first:

  1. Direct dep / import (``ollama`` in requirements.txt,
     ``from ollama import …`` in source).
  2. Env-var signal (``OLLAMA_HOST`` set, or ``OPENAI_BASE_URL``
     pointed at the Ollama default endpoint).
  3. Combined with OpenAI-instrumentor compatibility (Ollama exposes
     an OpenAI-compat endpoint, so even OpenAI-only users should be
     routed through the right bootstrap).

These tests use ``tmp_path`` for the on-disk variant and ``monkeypatch``
for env vars.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from eden.integrations.framework_detector import (
    FRAMEWORK_MARKERS,
    _detect_ollama_env,
    detect_framework,
    detect_framework_from_files,
)


# ────────────────────────────────────────────────────────────────────────
# FRAMEWORK_MARKERS table
# ────────────────────────────────────────────────────────────────────────


def test_ollama_in_framework_markers():
    assert "ollama" in FRAMEWORK_MARKERS, "ollama must be a first-class framework"
    meta = FRAMEWORK_MARKERS["ollama"]
    assert "ollama" in meta["pip"]
    assert "ollama" in meta["npm"]
    # Instrumentor is OpenAI-compat — Ollama reuses the openai patch.
    assert meta["instrumentation"] == "OpenAIInstrumentor"


# ────────────────────────────────────────────────────────────────────────
# Env-var helper
# ────────────────────────────────────────────────────────────────────────


def test_detect_ollama_env_via_ollama_host(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OLLAMA_HOST", "http://my-gpu-box:11434")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    assert _detect_ollama_env() == "OLLAMA_HOST"


def test_detect_ollama_env_via_openai_base_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:11434/v1")
    assert _detect_ollama_env() == "OPENAI_BASE_URL"


def test_detect_ollama_env_returns_none_when_unset(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    assert _detect_ollama_env() is None


def test_detect_ollama_env_ignores_non_ollama_base_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    monkeypatch.setenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    assert _detect_ollama_env() is None


# ────────────────────────────────────────────────────────────────────────
# detect_framework — on-disk variant
# ────────────────────────────────────────────────────────────────────────


def _write_repo(root: Path, *, requirements: str | None = None, source: str | None = None) -> Path:
    if requirements is not None:
        (root / "requirements.txt").write_text(requirements)
    if source is not None:
        (root / "agent.py").write_text(source)
    return root


def test_detect_ollama_via_pip_dep(tmp_path: Path):
    _write_repo(tmp_path, requirements="ollama==0.4.0\nrequests\n")
    det = detect_framework(tmp_path)
    assert det.framework == "ollama"
    assert det.confidence >= 0.7
    assert any("ollama" in m for m in det.matched_markers)


def test_detect_ollama_via_import(tmp_path: Path):
    _write_repo(
        tmp_path,
        source="from ollama import chat\nresponse = chat(model='llama3.1:8b')\n",
    )
    det = detect_framework(tmp_path)
    assert det.framework == "ollama"
    assert det.confidence >= 0.6


def test_detect_ollama_via_env_var(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _write_repo(tmp_path, source="import openai\nclient = openai.OpenAI()\n")
    monkeypatch.setenv("OLLAMA_HOST", "http://localhost:11434")
    det = detect_framework(tmp_path)
    # Env signal (0.7) outweighs the openai import (0.6).
    assert det.framework == "ollama"
    assert det.confidence >= 0.7
    assert det.matched_markers == ["env:OLLAMA_HOST"]


def test_detect_openai_when_no_ollama_signals(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    _write_repo(tmp_path, source="import openai\n")
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    det = detect_framework(tmp_path)
    assert det.framework == "openai"


# ────────────────────────────────────────────────────────────────────────
# detect_framework_from_files — in-memory variant
# ────────────────────────────────────────────────────────────────────────


def test_detect_ollama_from_files_via_requirements():
    files = {
        "requirements.txt": "ollama==0.4.0\n",
        "agent.py": "from ollama import chat\n",
    }
    det = detect_framework_from_files(files)
    assert det.framework == "ollama"