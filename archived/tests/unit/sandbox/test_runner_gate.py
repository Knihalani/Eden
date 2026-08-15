"""M8 (spec §4.2/§7.3) — sandbox runner support for the test gate.

Language-appropriate allowlisted command selection, wall-clock timeout,
and the mandatory-isolation refusal path for synthesized tests.
"""

from __future__ import annotations

import sys

import pytest

from eden.sandbox.runner import (
    SandboxResult,
    _is_allowed_command,
    build_test_command,
    run_in_sandbox,
)

# ── Command selection per language ──────────────────────────────


def test_build_test_command_python() -> None:
    cmd = build_test_command(["tests/test_a.py", "tests/test_b.py"])
    assert cmd == [sys.executable, "-m", "pytest", "-q", "tests/test_a.py", "tests/test_b.py"]
    assert _is_allowed_command(cmd)


def test_build_test_command_node() -> None:
    cmd = build_test_command(["ui/button.test.ts", "ui/menu.test.tsx"])
    assert cmd == ["npm", "test", "--", "ui/button.test.ts", "ui/menu.test.tsx"]
    assert _is_allowed_command(cmd)


def test_build_test_command_go() -> None:
    cmd = build_test_command(["pkg/server_test.go"])
    assert cmd == ["go", "test", "pkg/server_test.go"]
    assert _is_allowed_command(cmd)


def test_build_test_command_mixed_or_unknown_returns_none() -> None:
    assert build_test_command(["tests/test_a.py", "pkg/server_test.go"]) is None
    assert build_test_command(["README.md"]) is None
    assert build_test_command([]) is None
    assert build_test_command(["", "  "]) is None


# ── Timeout ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gate_command_timeout(tmp_path) -> None:
    (tmp_path / "test_slow.py").write_text(
        "import time\ndef test_slow():\n    time.sleep(30)\n",
        encoding="utf-8",
    )
    result = await run_in_sandbox(
        build_test_command(["test_slow.py"]),
        workdir=tmp_path,
        timeout_sec=1,
        cleanup=False,
    )
    assert result.timed_out is True
    assert result.exit_code == 124
    assert result.error == "timed_out"


# ── Mandatory isolation (§7.3) ──────────────────────────────────


@pytest.mark.asyncio
async def test_require_isolation_refuses_without_unshare(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    from eden.sandbox import runner

    monkeypatch.setattr(runner, "_UNSHARE_NET_OK", False)
    (tmp_path / "test_ok.py").write_text("def test_ok():\n    pass\n")
    result = await run_in_sandbox(
        build_test_command(["test_ok.py"]),
        workdir=tmp_path,
        timeout_sec=30,
        require_isolation=True,
        cleanup=False,
    )
    assert isinstance(result, SandboxResult)
    assert result.error == "isolation_unavailable"
    assert result.exit_code == 125
    assert result.stdout == "", "nothing may execute unisolated"


@pytest.mark.asyncio
async def test_no_isolation_requirement_still_runs(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    from eden.sandbox import runner

    monkeypatch.setattr(runner, "_UNSHARE_NET_OK", False)
    (tmp_path / "test_ok.py").write_text("def test_ok():\n    assert True\n")
    result = await run_in_sandbox(
        build_test_command(["test_ok.py"]),
        workdir=tmp_path,
        timeout_sec=60,
        require_isolation=False,
        cleanup=False,
    )
    assert result.exit_code == 0
    assert result.passed is True
    assert result.isolation == "subprocess"
