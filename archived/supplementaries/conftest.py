"""Shared pytest setup for the deterministic trace evaluation system.

Why this conftest exists
------------------------
``supplementaries/phase_3_loops/real_embeddings.py`` (and downstream
``combined_loop_detector``, ``real_ensemble``, ``semantic_progress``)
load real HuggingFace sentence-transformers models. Under the current
combination of ``huggingface_hub`` + ``transformers`` on this machine,
``hf_hub_download`` makes a HEAD probe against ``huggingface.co`` even
when the model is fully cached locally — and the ``httpx`` client's
retry loop tears down its own client between attempts, raising
``RuntimeError: Cannot send a request, as the client has been closed.``

This conftest delegates the actual fix to the reusable module
``supplementaries._hf_cache_patch``, which preserves online
behaviour for code paths that genuinely need the network while
making model loading deterministic when the cache has a known
commit.

If the local cache lacks a ``refs/<revision>`` entry, the patch is
a no-op — upstream online behaviour is preserved.
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Install the cache-first patch by importing the module (which calls
# install() at import time).
from supplementaries import _hf_cache_patch  # noqa: F401  pylint: disable=unused-import
