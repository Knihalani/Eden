"""Run Alembic migrations at API boot (Northflank / Docker).

Workers set ``SKIP_MIGRATIONS=1``; the API service upgrades to head
before accepting traffic so deploys never ship code ahead of schema.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


def run_alembic_upgrade_head() -> None:
    """Upgrade the database to Alembic head. No-op when skipped."""
    flag = os.environ.get("SKIP_MIGRATIONS", "").strip().lower()
    if flag in ("1", "true", "yes"):
        logger.info("SKIP_MIGRATIONS set — skipping Alembic upgrade")
        return

    from alembic import command
    from alembic.config import Config

    # src/eden/db_migrations/runner.py → repo root (/app in the container)
    root = Path(__file__).resolve().parents[3]
    ini = root / "alembic.ini"
    if not ini.is_file():
        logger.warning("alembic.ini not found at %s — skipping migration", ini)
        return

    logger.info("Running Alembic upgrade head from %s", ini)
    cfg = Config(str(ini))
    command.upgrade(cfg, "head")
    logger.info("Alembic upgrade head complete")
