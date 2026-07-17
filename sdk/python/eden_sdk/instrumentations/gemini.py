"""Auto-instrumentation for Google Gemini / Vertex generative models.

Patches ``google.generativeai.GenerativeModel.generate_content`` when
the legacy ``google-generativeai`` package is importable. Also attempts
``google.genai`` client ``models.generate_content`` when present.
"""

from __future__ import annotations

import functools
import logging
import time
import uuid
from typing import Any

from eden_sdk._instrumentation_ids import _trace_id_or_random
from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config

logger = logging.getLogger("eden_sdk.instrumentation.gemini")

_installed = False
_originals: dict[str, Any] = {}


def install() -> None:
    global _installed
    if _installed:
        return
    patched = False
    try:
        import google.generativeai as genai  # type: ignore[import-untyped]

        model_cls = getattr(genai, "GenerativeModel", None)
        if model_cls is not None and hasattr(model_cls, "generate_content"):
            if "genai_generate" not in _originals:
                _originals["genai_generate"] = model_cls.generate_content
                model_cls.generate_content = _wrap_generate(
                    _originals["genai_generate"], provider="gemini"
                )
            patched = True
    except Exception as exc:  # noqa: BLE001
        logger.debug("google.generativeai not patched: %s", exc)

    try:
        from google import genai as genai_new  # type: ignore[import-untyped]

        client_cls = getattr(genai_new, "Client", None)
        if client_cls is not None:
            # Soft wrap: users should prefer wrapGemini on Client instances.
            patched = True
    except Exception as exc:  # noqa: BLE001
        logger.debug("google.genai not available: %s", exc)

    if not patched:
        raise RuntimeError(
            "gemini not importable — install google-generativeai or google-genai"
        )
    _installed = True
    logger.debug("eden: gemini instrumentation installed")


def uninstall() -> None:
    global _installed
    if not _installed:
        return
    try:
        import google.generativeai as genai  # type: ignore[import-untyped]

        model_cls = getattr(genai, "GenerativeModel", None)
        if model_cls is not None and "genai_generate" in _originals:
            model_cls.generate_content = _originals["genai_generate"]
    except Exception:  # noqa: BLE001
        pass
    _originals.clear()
    _installed = False


def _wrap_generate(original, *, provider: str):  # type: ignore[no-untyped-def]
    @functools.wraps(original)
    def wrapper(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        cfg = get_config()
        if not cfg.enabled:
            return original(self, *args, **kwargs)
        t0 = time.perf_counter()
        model = getattr(self, "model_name", None) or getattr(self, "_model_name", None)
        try:
            resp = original(self, *args, **kwargs)
            _enqueue(
                provider=provider,
                model=str(model) if model else None,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=None,
                text=_extract_text(resp),
            )
            return resp
        except Exception as exc:  # noqa: BLE001
            _enqueue(
                provider=provider,
                model=str(model) if model else None,
                duration_ms=(time.perf_counter() - t0) * 1000.0,
                error=repr(exc),
                text=None,
            )
            raise

    return wrapper


def _extract_text(resp: Any) -> str | None:
    try:
        text = getattr(resp, "text", None)
        if isinstance(text, str):
            return text[:2000]
    except Exception:  # noqa: BLE001
        return None
    return None


def _enqueue(
    *,
    provider: str,
    model: str | None,
    duration_ms: float,
    error: str | None,
    text: str | None,
) -> None:
    payload: dict[str, Any] = {
        "event_id": f"eden_gemini_{uuid.uuid4().hex[:16]}",
        "trace_id": _trace_id_or_random(),
        "event_type": "llm_completion",
        "name": f"{provider}.generate_content",
        "model": model,
        "duration_ms": duration_ms,
        "response_payload": {"text": text} if text else None,
        "source_format": "gemini",
        "attributes": {"provider": provider},
    }
    if error:
        payload["error"] = error
        payload["outcome"] = "error"
    else:
        payload["outcome"] = "success"
    get_default_client().enqueue(TraceEvent(payload=payload, source_format="gemini"))
