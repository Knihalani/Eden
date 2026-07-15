"""Unit tests for the Gate 3 sandbox substitute."""

from __future__ import annotations

import sys

import pytest

from eden.sandbox.runner import (
    apply_patch_files,
    run_in_sandbox,
)


def test_apply_patch_files_writes_relative(tmp_path) -> None:
    written = apply_patch_files(
        tmp_path,
        [{"path": "pkg/mod.py", "content": "x = 1\n"}],
    )
    assert written == ["pkg/mod.py"]
    assert (tmp_path / "pkg" / "mod.py").read_text() == "x = 1\n"


def test_apply_patch_files_rejects_traversal(tmp_path) -> None:
    with pytest.raises(ValueError, match="traversal|absolute|path"):
        apply_patch_files(
            tmp_path,
            [{"path": "../escape.py", "content": "bad"}],
        )


@pytest.mark.asyncio
async def test_run_rejects_non_allowlisted() -> None:
    result = await run_in_sandbox(["curl", "https://example.com"])
    assert result.exit_code == 126
    assert result.error == "command_not_allowlisted"


@pytest.mark.asyncio
async def test_run_pytest_allowlisted(tmp_path) -> None:
    (tmp_path / "test_ok.py").write_text(
        "def test_ok():\n    assert True\n",
        encoding="utf-8",
    )
    result = await run_in_sandbox(
        [sys.executable, "-m", "pytest", "-q", "test_ok.py"],
        workdir=tmp_path,
        timeout_sec=60,
        cleanup=False,
    )
    assert result.timed_out is False
    assert result.exit_code == 0
    assert result.passed is True


@pytest.mark.asyncio
async def test_run_timeout(tmp_path) -> None:
    (tmp_path / "test_slow.py").write_text(
        "import time\n"
        "def test_slow():\n"
        "    time.sleep(30)\n",
        encoding="utf-8",
    )
    result = await run_in_sandbox(
        [sys.executable, "-m", "pytest", "-q", "test_slow.py"],
        workdir=tmp_path,
        timeout_sec=1,
        cleanup=False,
    )
    assert result.timed_out is True
    assert result.exit_code == 124
