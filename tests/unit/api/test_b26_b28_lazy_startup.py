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
    # Subprocess does not inherit pytest's pythonpath=["src"]; put src
    # first so ``import eden.api`` resolves like the main test process.
    existing = os.environ.get("PYTHONPATH", "")
    pythonpath = os.pathsep.join(
        p for p in (str(SRC), str(REPO_ROOT), existing) if p
    )
    env = {
        **os.environ,
        "EDEN_TESTING": "1",
        "PYTEST_CURRENT_TEST": "b26_b28",
        "PYTHONPATH": pythonpath,
    }
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


def test_w15c_app_import_skips_tier2_deferred_routers():
    """Cold import of eden.api.app must not load the tier-2 deferred routers.

    This is the cold-import diet itself: ~100 routers moved behind
    ``mount_tier2_routers`` and FastAPI's per-route signature analysis
    for them must not run at import time.
    """
    out = _run(
        "import sys\n"
        "from eden.api.app import app, _DEFERRED_ROUTERS\n"
        "# eden.api.routes.observability is legitimately eager: its\n"
        "# ingest_router is in the eager tier; only its main router is\n"
        "# tier-2 deferred.\n"
        "eager_ok = {'eden.api.routes.observability'}\n"
        "loaded = sorted("
        "{m for m, _ in _DEFERRED_ROUTERS if m in sys.modules} - eager_ok)\n"
        "out = {"
        "  'deferred_count': len(_DEFERRED_ROUTERS),"
        "  'loaded': loaded,"
        "  'flag': bool(getattr(app.state, '_tier2_deferred_mounted', False)),"
        "}"
    )
    assert out["deferred_count"] >= 90
    assert out["loaded"] == [], f"eager-loaded tier-2 routers: {out['loaded']}"
    assert out["flag"] is False


def test_b26_mount_deferred_routers_loads_and_is_idempotent():
    """mount_deferred_routers mounts BOTH tiers (tier-2 first) once."""
    out = _run(
        "import sys\n"
        "from eden.api.app import app, mount_deferred_routers, "
        "_DEFERRED_INTELLIGENCE_ROUTERS, _DEFERRED_ROUTERS\n"
        "n1 = mount_deferred_routers(app)\n"
        "n2 = mount_deferred_routers(app)\n"
        "loaded_intel = sum("
        "  1 for m in _DEFERRED_INTELLIGENCE_ROUTERS "
        "  if f'eden.api.routes.{m}' in sys.modules"
        ")\n"
        "loaded_tier2 = sum(1 for m in {m for m, _ in _DEFERRED_ROUTERS} "
        "if m in sys.modules)\n"
        "out = {'n1': n1, 'n2': n2, 'loaded_intel': loaded_intel, "
        "'loaded_tier2': loaded_tier2, 'routes': len(app.routes)}"
    )
    assert out["loaded_intel"] >= 20
    assert out["loaded_tier2"] >= 90
    # Every deferred entry (both tiers) mounted exactly once; sso may be
    # skipped when sso_enabled is off, hence >=.
    assert out["n1"] >= out["loaded_intel"] + out["loaded_tier2"]
    assert out["n2"] == 0
    assert out["routes"] > 600


def test_w15c_mount_tier2_is_idempotent_and_preserves_prompts_precedence():
    """Tier-2 alone mounts once, and prompts_v2 still precedes prompts.

    The D.9 prompts_v2 router owns GET/POST "" and GET /{name}; the
    Phase I prompts router keeps the rest. FastAPI is first-match-wins,
    so the deferred table must preserve their relative order.
    """
    out = _run(
        "from eden.api.app import app, mount_tier2_routers\n"
        "n1 = mount_tier2_routers(app)\n"
        "n2 = mount_tier2_routers(app)\n"
        "order = []\n"
        "for i, r in enumerate(app.routes):\n"
        "    mod = getattr(getattr(r, 'endpoint', None), '__module__', '')\n"
        "    if mod in ('eden.api.routes.prompts', 'eden.api.routes.prompts_v2'):\n"
        "        order.append(mod)\n"
        "first_v2 = order.index('eden.api.routes.prompts_v2') if "
        "'eden.api.routes.prompts_v2' in order else -1\n"
        "first_v1 = order.index('eden.api.routes.prompts') if "
        "'eden.api.routes.prompts' in order else -1\n"
        "out = {'n1': n1, 'n2': n2, 'first_v2': first_v2, 'first_v1': first_v1}"
    )
    assert out["n1"] >= 90
    assert out["n2"] == 0
    assert 0 <= out["first_v2"] < out["first_v1"]


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
