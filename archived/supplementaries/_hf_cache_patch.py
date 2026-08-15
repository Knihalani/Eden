"""Cache-first HuggingFace download patch — importable as a module.

Background
----------
On the combination of ``huggingface_hub`` + ``transformers`` /
``sentence-transformers`` shipped in this environment,
``hf_hub_download`` makes a HEAD probe against ``huggingface.co``
even when the model is fully cached locally. The ``httpx`` client's
retry loop tears down its own client between attempts, raising::

    RuntimeError: Cannot send a request, as the client has been closed.

This module installs a monkey-patch that:

  1. Resolves "main" / None to a locally cached commit hash when one
     exists in ``~/.cache/huggingface/hub/models--*/refs/main``.
  2. Calls ``try_to_load_from_cache`` for the requested file first.
  3. Returns the cached path (or the ``_CACHED_NO_EXIST`` sentinel)
     directly — no network at all.
  4. Falls through to the upstream online behaviour only when the
     local cache has no information about the file.

The patch is a no-op for non-string repo IDs, for explicit
``local_files_only=True`` / ``force_download=True`` callers, and
when the local cache lacks a ``refs/<revision>`` entry.

Importing this module *installs* the patch — it is not idempotent
across separate invocations, but the function is internally guarded.

Usage::

    from supplementaries._hf_cache_patch import install
    install()  # safe to call multiple times

The pytest ``supplementaries/conftest.py`` calls ``install()`` so
the supplementaries test suite is deterministic. Production code
that loads HuggingFace models should also call ``install()`` at
startup to dodge the same network probe bug.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

_PATCH_INSTALLED = False


def _resolve_cached_commit(model_id: str) -> str | None:
    """Return the commit hash pointed to by local refs/main, or None."""
    if not isinstance(model_id, str) or "/" not in model_id:
        return None
    hub_root = Path(
        os.environ.get("HF_HUB_CACHE")
        or Path.home() / ".cache" / "huggingface" / "hub"
    )
    model_dir = hub_root / f"models--{model_id.replace('/', '-')}"
    refs_main = model_dir / "refs" / "main"
    try:
        if refs_main.is_file():
            commit = refs_main.read_text().strip()
            if commit and (model_dir / "snapshots" / commit).is_dir():
                return commit
    except OSError:
        return None
    return None


def install() -> bool:
    """Install the cache-first patch. Idempotent — returns True on first
    install, False on subsequent no-op calls.
    """
    global _PATCH_INSTALLED
    if _PATCH_INSTALLED:
        return False

    try:
        import huggingface_hub.file_download as _hf_file_download  # type: ignore
        from huggingface_hub.file_download import _CACHED_NO_EXIST  # type: ignore
        from huggingface_hub import hf_hub_download as _hf_hub_download  # type: ignore
    except Exception:
        # huggingface_hub not installed — nothing to patch.
        return False

    if getattr(_hf_hub_download, "_eden_cache_first_patched", False):
        _PATCH_INSTALLED = True
        return False

    _try_to_load_from_cache = _hf_file_download.try_to_load_from_cache

    def _patched_hf_hub_download(repo_id: Any, *args: Any, **kwargs: Any):
        # Skip for non-string IDs (local paths etc.) — let upstream handle.
        if not isinstance(repo_id, str):
            return _hf_hub_download(repo_id, *args, **kwargs)

        # Skip if caller already chose cache-only or forced download.
        if kwargs.get("local_files_only") or kwargs.get("force_download"):
            return _hf_hub_download(repo_id, *args, **kwargs)

        # Honour explicit revision; resolve "main" / None from cache.
        revision = kwargs.get("revision")
        if revision in (None, "main"):
            cached_commit = _resolve_cached_commit(repo_id)
            if cached_commit is not None:
                kwargs = dict(kwargs)
                kwargs["revision"] = cached_commit

        # Cache-only probe — no network at all.
        try:
            filename = kwargs.get("filename") or (args[0] if args else None)
            if filename is None:
                return _hf_hub_download(repo_id, *args, **kwargs)
            cache_dir = kwargs.get("cache_dir")
            rev = kwargs.get("revision")
            subfolder = kwargs.get("subfolder", "") or ""
            full_filename = (
                f"{subfolder}/{filename}" if subfolder else str(filename)
            )
            cached = _try_to_load_from_cache(
                repo_id,
                full_filename,
                cache_dir=cache_dir,
                revision=rev,
            )
            if cached is _CACHED_NO_EXIST:
                # Authoritative — file does not exist for this commit.
                return str(cached)
            if isinstance(cached, str) and cached:
                return cached
        except Exception:
            # Any cache probe failure → fall through to upstream.
            pass

        return _hf_hub_download(repo_id, *args, **kwargs)

    # Preserve wrapped identity markers.
    _patched_hf_hub_download._eden_cache_first_patched = True
    _patched_hf_hub_download.__wrapped__ = _hf_hub_download  # for introspection

    # Replace in the modules that import it.
    import huggingface_hub as _hf
    _hf.hf_hub_download = _patched_hf_hub_download
    _hf_file_download.hf_hub_download = _patched_hf_hub_download

    # Also patch the symbols that transformers / sentence_transformers
    # imported at module-load time. We rewrite their __dict__ entries.
    try:
        from sentence_transformers.util import file_io as _st_file_io  # type: ignore
        _st_file_io.hf_hub_download = _patched_hf_hub_download
    except Exception:
        pass
    try:
        from sentence_transformers.util import snapshot as _st_snap  # type: ignore  # noqa: F401
        _st_snap.hf_hub_download = _patched_hf_hub_download
    except Exception:
        pass

    _hf_file_download._eden_cache_first_patched = True
    _PATCH_INSTALLED = True
    return True


# Install on import so production callers can simply do
# ``import supplementaries._hf_cache_patch`` and be protected.
install()
