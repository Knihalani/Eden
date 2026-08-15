"""CI lint: Eden-owned chat call sites must use the internal model SSOT.

Soft Autonomy 2026-08-01: all Eden product chat routes through
``eden.llm.models.INTERNAL_CHAT_MODEL`` (deepseek-v4-flash). This test
fails if non-test source hardcodes a legacy Eden tier model id as a
call target, so the cutover can't silently regress.

Allowed (not Eden call targets):
- pricing/catalog seeds (cost estimation for customer + legacy models)
- AI gateway provider catalog (customer-facing model advisor)
- telemetry parsing of customer-reported model ids
- tests, docs, SDKs, examples
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

LEGACY_EDEN_MODELS = (
    "x-ai/grok-4.5",
    "tencent/hy3",
    "xiaomi/mimo-v2.5",
    "minimax/minimax-m3",
)

# Files/dirs where legacy ids are legitimate (catalogs, docs, fixtures).
ALLOWED_PATH_PARTS = (
    "pricing.py",
    "ai_gateway.py",
    "cost_resolver.py",
    "bronze_sink.py",
    "model_advisor",
    "/tests/",
    "/docs/",
    "/sdk/",
    "/examples/",
    "/supplementaries/",
    "CHANGELOG",
)

SCAN_ROOTS = (
    REPO_ROOT / "src" / "eden",
    REPO_ROOT / "clients" / "portal" / "src",
)

SCAN_EXTS = {".py", ".ts", ".tsx"}


def _iter_source_files():
    for root in SCAN_ROOTS:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if path.suffix not in SCAN_EXTS or not path.is_file():
                continue
            yield path


def _is_allowed(path: Path) -> bool:
    posix = path.as_posix()
    return any(part in posix for part in ALLOWED_PATH_PARTS)


def test_no_legacy_eden_chat_model_ids_in_source() -> None:
    offenders: list[str] = []
    for path in _iter_source_files():
        if _is_allowed(path):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for model in LEGACY_EDEN_MODELS:
            for match in re.finditer(re.escape(model), text):
                line_no = text.count("\n", 0, match.start()) + 1
                offenders.append(f"{path.relative_to(REPO_ROOT)}:{line_no} ({model})")
    assert not offenders, (
        "Legacy Eden chat model ids hardcoded outside allowed catalogs. "
        "Use eden.llm.models.INTERNAL_CHAT_MODEL instead:\n"
        + "\n".join(offenders)
    )


def test_internal_chat_model_is_deepseek() -> None:
    """The SSOT itself must resolve to the DeepSeek flash model."""
    from eden.llm.models import INTERNAL_CHAT_MODEL, internal_chat_chain

    assert INTERNAL_CHAT_MODEL == "deepseek/deepseek-v4-flash-0731"
    assert internal_chat_chain()[0] == INTERNAL_CHAT_MODEL


def test_all_chat_tiers_resolve_to_ssot() -> None:
    """T1/T2/T3 must all route to the internal chat SSOT."""
    from eden.llm.models import INTERNAL_CHAT_MODEL
    from eden.optimization.model_router import TIER_MODELS, ModelTier

    for tier in (ModelTier.T1, ModelTier.T2, ModelTier.T3):
        assert TIER_MODELS[tier][0] == INTERNAL_CHAT_MODEL, (
            f"{tier} primary is {TIER_MODELS[tier][0]}, expected {INTERNAL_CHAT_MODEL}"
        )


def test_ssot_model_is_priced() -> None:
    """Cost ledger must resolve the SSOT model (no silent $0)."""
    from eden.llm.models import INTERNAL_CHAT_MODEL
    from eden.llmops.pricing import resolve_seed_row

    row = resolve_seed_row(INTERNAL_CHAT_MODEL)
    assert row is not None, f"{INTERNAL_CHAT_MODEL} missing from pricing seeds"
    assert row.cost_per_1k_input > 0 and row.cost_per_1k_output > 0
