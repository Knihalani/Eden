"""Test config: ensure the ``eden`` package from cli/ is importable.

The CLI lives at ``cli/eden/`` and the project root is the parent
(``cli/``). We add the parent to ``sys.path`` so the test runner
sees our package as a top-level import. This is also what the
installed package layout looks like once ``pip install -e .`` runs.
"""

from __future__ import annotations

import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PKG_ROOT = _HERE.parent  # the cli/ directory containing the eden/ package
if str(_PKG_ROOT) not in sys.path:
    sys.path.insert(0, str(_PKG_ROOT))
