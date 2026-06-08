"""Tests for ``eden.pattern_miner`` — codebase + git history scanning."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from eden.pattern_miner import (
    MinerOptions,
    _build_entry,
    scan_codebase,
    scan_recent_changes,
)


def test_scan_codebase_empty(tmp_path: Path):
    out = scan_codebase(tmp_path)
    assert out.python_files == 0
    assert out.ts_files == 0
    assert out.public_functions == 0
    assert out.public_classes == 0
    assert out.top_level_imports == []


def test_scan_codebase_counts_python(tmp_path: Path):
    (tmp_path / "a.py").write_text(
        '"""Module docstring."""\n'
        "import os\n"
        "from pathlib import Path\n"
        "\n"
        "def public_one():\n    pass\n"
        "\n"
        "def _private():\n    pass\n"
        "\n"
        "class Public:\n    pass\n"
    )
    (tmp_path / "b.py").write_text("def another():\n    pass\n")
    # A non-source file we should ignore
    (tmp_path / "README.md").write_text("# readme\n")

    out = scan_codebase(tmp_path)
    assert out.python_files == 2
    assert out.public_functions >= 2
    assert out.public_classes >= 1
    assert out.module_docstring_present is True
    assert "os" in out.top_level_imports
    assert "pathlib" in out.top_level_imports


def test_scan_codebase_counts_typescript(tmp_path: Path):
    (tmp_path / "a.ts").write_text("export const x = 1;\n")
    (tmp_path / "b.tsx").write_text("const C = () => <div/>;\n")
    out = scan_codebase(tmp_path)
    assert out.ts_files == 2


def test_scan_codebase_skips_noise_dirs(tmp_path: Path):
    noise = tmp_path / "node_modules" / "lib"
    noise.mkdir(parents=True)
    (noise / "a.py").write_text("def f():\n    pass\n")
    venv = tmp_path / ".venv" / "lib"
    venv.mkdir(parents=True)
    (venv / "b.py").write_text("def f():\n    pass\n")
    (tmp_path / "real.py").write_text("def f():\n    pass\n")

    out = scan_codebase(tmp_path)
    assert out.python_files == 1  # only real.py


def test_scan_recent_changes_no_git(tmp_path: Path):
    out = scan_recent_changes(tmp_path, n=5)
    assert out == []


def test_scan_recent_changes_with_repo(tmp_path: Path):
    # Initialize a real git repo with a few commits
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@x"],
        cwd=tmp_path, check=True
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path, check=True
    )
    (tmp_path / "a.txt").write_text("hi\n")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "commit", "-m", "first", "-q"],
        cwd=tmp_path, check=True
    )
    out = scan_recent_changes(tmp_path, n=3)
    assert len(out) >= 1
    assert out[0]["subject"] == "first"


def test_build_entry_shape():
    e = _build_entry(
        title="t", body="b", tags=["x"], source="src"
    )
    assert e["title"] == "t"
    assert e["body"] == "b"
    assert e["tags"] == ["x"]
    assert e["source"] == "src"
    assert e["kind"] == "pattern_miner"
    assert "created_at" in e
