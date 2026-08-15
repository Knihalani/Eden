"""Wave 29 — packaging readiness + portal/F22 sweep contracts."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
PY_TOML = ROOT / "sdk" / "python" / "pyproject.toml"
PY_INIT = ROOT / "sdk" / "python" / "eden_sdk" / "__init__.py"
TS_PKG = ROOT / "sdk" / "ts-ai" / "package.json"
PUBLISH = ROOT / "scripts" / "publish_sdk.sh"
SWEEP = ROOT / "scripts" / "w29_portal_sweep.sh"
MCP_SMOKE = ROOT / "scripts" / "w29_mcp_smoke.sh"
DRILLS = ROOT / "scripts" / "w29_flag_dr_drills.sh"
DECL = ROOT / "docs" / "specs" / "SOTA-DECLARATION.md"
SCORE = ROOT / "docs" / "specs" / "SOTA-PERF-COST-SCORECARD.md"
TRACKER = ROOT / "docs" / "specs" / "SOTA-WAVE-TRACKER.md"


def _py_version() -> str:
    text = PY_TOML.read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
    assert m, "pyproject version missing"
    return m.group(1)


def test_sdk_versions_synced() -> None:
    pv = _py_version()
    init = PY_INIT.read_text(encoding="utf-8")
    assert f'__version__ = "{pv}"' in init
    ts = json.loads(TS_PKG.read_text(encoding="utf-8"))
    assert ts["version"] == pv
    assert ts["name"] == "@eden-ai/sdk"
    # The real invariant is that the two SDKs ship the same version (the
    # three assertions above). The old `"0.3." in pv` pinned a release
    # train and had to be edited on every minor bump — signal-free churn.
    # A well-formed semver with a non-zero component is enough here.
    assert re.fullmatch(r"\d+\.\d+\.\d+(?:[-+].*)?", pv), pv
    assert pv != "0.0.0"


def test_python_package_metadata() -> None:
    text = PY_TOML.read_text(encoding="utf-8")
    assert 'name = "eden-sdk"' in text
    assert "Apache-2.0" in text or "License" in text
    assert "Homepage" in text
    assert "requires-python" in text
    assert "httpx>=" in text


def test_typescript_package_metadata() -> None:
    ts = json.loads(TS_PKG.read_text(encoding="utf-8"))
    assert "dist" in ts["files"]
    assert "repository" in ts
    assert ts["license"] in {"MIT", "Apache-2.0"}
    assert "bin" in ts and "eden-doctor" in ts["bin"]


def test_publish_and_sweep_scripts_executable_present() -> None:
    for path in (PUBLISH, SWEEP, MCP_SMOKE, DRILLS):
        assert path.is_file(), path
        mode = path.stat().st_mode
        assert mode & 0o111, f"{path} not executable"


def test_mcp_console_script_declared() -> None:
    root_toml = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'eden-mcp = "eden.mcp_server.__main__:main"' in root_toml
    main = (ROOT / "src" / "eden" / "mcp_server" / "__main__.py").read_text(
        encoding="utf-8"
    )
    assert "def main()" in main


def test_no_live_fix_page_directory() -> None:
    fix_dir = ROOT / "clients" / "portal" / "src" / "app" / "(portal)" / "issues" / "[id]" / "fix"
    assert not fix_dir.exists()


def test_next_config_redirects_fix_to_handoff() -> None:
    cfg = (ROOT / "clients" / "portal" / "next.config.ts").read_text(encoding="utf-8")
    assert '/issues/:id/fix' in cfg
    # The handoff surface is the issue detail pane's "Fix" tab
    # (issues-client.tsx DETAIL_TABS) — there is no separate `handoff`
    # tab, so the rule carries the id through and selects that tab.
    assert "tab=fix" in cfg
    assert "id=:id" in cfg


def test_sota_docs_present() -> None:
    assert DECL.is_file()
    assert SCORE.is_file()
    decl = DECL.read_text(encoding="utf-8")
    assert "Definition of Done" in decl or "DoD" in decl
    assert "PARTIAL" in decl
    score = SCORE.read_text(encoding="utf-8")
    assert "PERFORMANCE-COST-STANDARDS" in score or "p95" in score


def test_tracker_w29_not_pending() -> None:
    text = TRACKER.read_text(encoding="utf-8")
    # After wave exit, W29 must not remain PENDING
    m = re.search(
        r"\|\s*\*?\*?W29\*?\*?\s*\|[^|\n]+\|\s*\*?\*?(GREEN|PARTIAL|PENDING)\*?\*?",
        text,
    )
    assert m, "W29 row missing"
    assert m.group(1) in {"GREEN", "PARTIAL"}
