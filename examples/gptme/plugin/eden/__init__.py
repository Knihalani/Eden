"""Eden's gptme plugin: context injection, ask_context, and the party check.

Installed under ``~/.config/gptme/plugins/eden/`` by ``examples/gptme/install.py``, which also vendors the
``eden_client`` package into ``vendor/`` and drops the ``bin/eden-local`` sidecar beside it.
"""

import sys
from pathlib import Path

_VENDOR = Path(__file__).resolve().parent / "vendor"
if _VENDOR.is_dir() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))
