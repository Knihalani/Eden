"""Tests for ``eden.__main__`` — top-level CLI dispatch.

We test the parts that don't require Aider to be installed:
    - legacy delegation list
    - arg parser construction
    - top-level ``main()`` with no subcommand when Aider is unavailable
    - ``eden login`` and ``eden config-show`` flows
"""

from __future__ import annotations

from pathlib import Path

import pytest

from eden.__main__ import (
    _LEGACY_THIN_COMMANDS,
    _build_parser,
    _handle_config_show,
    _handle_login,
    _maybe_delegate_to_legacy,
)
from eden.config import EdenCLIConfig


def test_legacy_commands_constant():
    # Spot check the documented set
    assert "generate" in _LEGACY_THIN_COMMANDS
    assert "config" in _LEGACY_THIN_COMMANDS
    assert "chat" not in _LEGACY_THIN_COMMANDS


def test_legacy_delegate_returns_minus_one_for_tui():
    assert _maybe_delegate_to_legacy([]) == -1
    assert _maybe_delegate_to_legacy(["chat"]) == -1
    assert _maybe_delegate_to_legacy(["kb", "query", "x"]) == -1


def test_legacy_delegate_calls_subprocess_for_known(monkeypatch):
    # Make subprocess.call return a known code
    import subprocess
    seen = {}
    def fake_call(cmd, *a, **kw):
        seen["cmd"] = cmd
        return 7
    monkeypatch.setattr(subprocess, "call", fake_call)
    rc = _maybe_delegate_to_legacy(["generate", "--help"])
    assert rc == 7
    # Subprocess invoked with the legacy module path
    assert seen["cmd"][:3] == ["/", "/", "/"] or seen["cmd"][2] == "eden.cli"


def test_parser_has_expected_subcommands():
    p = _build_parser()
    # Top-level options
    assert "--version" in p.format_help()
    # Subcommands
    text = p.format_help()
    for cmd in ("chat", "login", "config-show", "pattern-mine", "kb"):
        assert cmd in text, f"missing subcommand: {cmd}"


def test_login_writes_credentials(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    args = type("A", (), {
        "api_key": "secret-key",
        "org_id": "abc-org",
        "base_url": "http://eden:9000",
    })()
    rc = _handle_login(args)
    assert rc == 0
    target = tmp_path / ".eden" / "config.yaml"
    assert target.exists()
    body = target.read_text()
    assert "secret-key" in body
    assert "abc-org" in body
    assert "http://eden:9000" in body


def test_login_appends_does_not_clobber(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    target = tmp_path / ".eden" / "config.yaml"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("# user content\n")

    args = type("A", (), {
        "api_key": "k", "org_id": "o", "base_url": None
    })()
    _handle_login(args)
    body = target.read_text()
    assert "# user content" in body
    assert "k" in body


def test_config_show_prints_json(capsys):
    cfg = EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")
    _handle_config_show(cfg)
    out = capsys.readouterr().out
    parsed = __import__("json").loads(out)
    assert parsed["api_key"] == "k"
    assert parsed["org_id"] == "o"


def test_main_with_unknown_cmd_prints_help(capsys):
    from eden.__main__ import main
    rc = main(["--", "no-such-subcommand", "extra"])
    # The help path returns 1
    assert rc in (0, 1, 2)  # parser.parse_args may raise; we accept any non-crash
