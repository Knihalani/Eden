"""Eden Agent CLI.

A fork of Aider (Apache 2.0) extended with Eden's:
  - Multi-tenant API client
  - Model slot routing (reasoning / code / fast / fallback)
  - Knowledge Base context provider (global + tenant)
  - Observability context provider
  - /eden-improve flagship command
  - Pattern miner (cron entry point)
"""

from __future__ import annotations

__version__ = "0.1.0-eden"

__all__ = ["__version__"]
