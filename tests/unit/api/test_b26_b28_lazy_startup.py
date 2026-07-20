"""W15-b B26–B28 — deferred routers / no import-time Settings in hot modules."""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SRC = REPO_ROOT / "src"

_HOT_MODULES = (
    SRC / "eden/api/utils/clerk_auth.py",
    SRC / "eden/api/routes/auth.py",
    SRC / "eden/api/routes/billing.py",
    SRC / "eden/api/middleware/idempotency.py",
    SRC / "eden/api/utils/logging.py",
    SRC / "eden/services/invitation_service.py",
    SRC / "eden/observability/telemetry_collector.py",
)


def _run(code: str) -> dict:
    env = {**os.environ, "EDEN_TESTING": "1", "PYTEST_CURRENT_TEST": "b26_b28"}
    full = "import json, sys\n" + code + "\nprint(json.dumps(out))"
    result = subprocess.run(
        [sys.executable, "-c", full],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        timeout=90,
        env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"subprocess failed rc={result.returncode}\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
    return json.loads(result.stdout.strip().splitlines()[-1])


def _module_level_get_settings_lines(path: Path) -> list[int]:
    """Return line numbers of get_settings() calls at module scope only."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    hits: list[int] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            func = call.func
            name = None
            if isinstance(func, ast.Name):
                name = func.id
            elif isinstance(func, ast.Attribute):
                name = func.attr
            if name == "get_settings":
                hits.append(call.lineno)
    return hits


def test_b26_app_import_skips_deferred_intelligence_routers():
    """Cold import of eden.api.app must not load deferred intelligence_*."""
    out = _run(
        "import sys\n"
        "from eden.api.app import app, _DEFERRED_INTELLIGENCE_ROUTERS\n"
        "loaded = [m for m in _DEFERRED_INTELLIGENCE_ROUTERS "
        "if f'eden.api.routes.{m}' in sys.modules]\n"
        "out = {"
        "  'deferred_count': len(_DEFERRED_INTELLIGENCE_ROUTERS),"
        "  'loaded': loaded,"
        "  'flag': bool(getattr(app.state, '_b26_deferred_mounted', False)),"
        "}"
    )
    assert out["deferred_count"] >= 20
    assert out["loaded"] == [], f"eager-loaded deferred routers: {out['loaded']}"
    assert out["flag"] is False


def test_b26_mount_deferred_routers_loads_and_is_idempotent():
    out = _run(
        "import sys\n"
        "from eden.api.app import app, mount_deferred_routers, "
        "_DEFERRED_INTELLIGENCE_ROUTERS\n"
        "n1 = mount_deferred_routers(app)\n"
        "n2 = mount_deferred_routers(app)\n"
        "loaded = sum("
        "  1 for m in _DEFERRED_INTELLIGENCE_ROUTERS "
        "  if f'eden.api.routes.{m}' in sys.modules"
        ")\n"
        "out = {'n1': n1, 'n2': n2, 'loaded': loaded, "
        "'routes': len(app.routes)}"
    )
    assert out["n1"] == out["loaded"]
    assert out["n1"] >= 20
    assert out["n2"] == 0
    assert out["routes"] > 600


def test_b27_hot_modules_have_no_module_level_get_settings_call():
    offenders: list[str] = []
    for path in _HOT_MODULES:
        for lineno in _module_level_get_settings_lines(path):
            offenders.append(f"{path.relative_to(REPO_ROOT)}:{lineno}")
    assert offenders == [], f"import-time get_settings() still present: {offenders}"


def test_b28_dead_import_time_settings_removed_from_hot_modules():
    """B28: hot modules must not assign module-level ``settings = get_settings()``."""
    pattern_offenders: list[str] = []
    for path in _HOT_MODULES:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            # settings = get_settings() or _settings = get_settings()
            if not any(
                isinstance(t, ast.Name) and t.id in {"settings", "_settings"}
                for t in node.targets
            ):
                continue
            if isinstance(node.value, ast.Call):
                func = node.value.func
                name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
                if name == "get_settings":
                    pattern_offenders.append(
                        f"{path.relative_to(REPO_ROOT)}:{node.lineno}"
                    )
    assert pattern_offenders == [], (
        f"module-level settings = get_settings() remains: {pattern_offenders}"
    )
