"""Unit tests for the Gate 3 sandbox substitute."""

from __future__ import annotations

import asyncio
import os
import shutil
import sys

import pytest

from eden.sandbox.runner import (
    SANDBOX_CPU_SEC,
    SANDBOX_FSIZE_BYTES,
    SANDBOX_NPROC,
    _alloc_workdir,
    _apply_ulimits,
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


def test_ulimit_constants_present() -> None:
    """M12 (§7.3): hard caps are defined and positive."""
    assert SANDBOX_CPU_SEC > 0
    assert SANDBOX_FSIZE_BYTES > 0
    assert SANDBOX_NPROC > 0
    # preexec_fn only — never invoke _apply_ulimits in the parent
    # (it would permanently lower this process's RLIMIT_*).
    assert callable(_apply_ulimits)


def test_alloc_workdir_prefix_and_tmpfs_preference() -> None:
    """M12 (§7.3): workdir is eden-sandbox-*; under /dev/shm when usable."""
    wd = _alloc_workdir()
    try:
        assert wd.is_dir()
        assert wd.name.startswith("eden-sandbox-")
        shm = "/dev/shm"
        if os.path.isdir(shm) and os.access(shm, os.W_OK):
            assert str(wd).startswith(shm)
    finally:
        shutil.rmtree(wd, ignore_errors=True)


@pytest.mark.asyncio
async def test_run_passes_preexec_ulimits(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M12 (§7.3): POSIX spawns must install ``_apply_ulimits`` as preexec_fn."""
    if os.name != "posix":
        pytest.skip("preexec_fn is POSIX-only")

    (tmp_path / "test_ok.py").write_text(
        "def test_ok():\n    assert True\n",
        encoding="utf-8",
    )

    captured: dict = {}
    real = asyncio.create_subprocess_exec

    async def spy(*args, **kwargs):
        captured["preexec_fn"] = kwargs.get("preexec_fn")
        return await real(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spy)
    result = await run_in_sandbox(
        [sys.executable, "-m", "pytest", "-q", "test_ok.py"],
        workdir=tmp_path,
        timeout_sec=60,
        cleanup=False,
    )
    assert captured.get("preexec_fn") is _apply_ulimits
    assert result.exit_code == 0


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
