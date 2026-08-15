"""K13 merge polish — read split portal ``lib/api/*.ts`` as one string."""

from __future__ import annotations

from pathlib import Path

_PORTAL_API_DIR = (
    Path(__file__).resolve().parents[1]
    / "clients"
    / "portal"
    / "src"
    / "lib"
    / "api"
)


def portal_api_dir() -> Path:
    return _PORTAL_API_DIR


def portal_api_source() -> str:
    """Concatenate all ``*.ts`` under ``clients/portal/src/lib/api/``."""
    d = portal_api_dir()
    parts = sorted(d.glob("*.ts"))
    if not parts:
        raise FileNotFoundError(f"no api modules under {d}")
    return "\n".join(p.read_text(encoding="utf-8") for p in parts)
