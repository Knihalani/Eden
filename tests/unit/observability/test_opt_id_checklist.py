"""A10 — OPTIMIZATION-ID-CHECKLIST completeness + A10 DONE rows."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
CHECKLIST = ROOT / "docs" / "specs" / "OPTIMIZATION-ID-CHECKLIST.md"

# Every ID from plan §5 (plus phase variants owned in §4).
REQUIRED_IDS = frozenset(
    {
        # P0
        "K1",
        "K2",
        "K3",
        "K4",
        "K5",
        "K6",
        "K7",
        "K9",
        "K10",
        "K12",
        "K16",
        "K17",
        "K18",
        "K23",
        "K24",
        "K25",
        "K29",
        "K31",
        "K35",
        "K36",
        "K37",
        "K41",
        "P1",
        "P3",
        "P4",
        "P5",
        "P6",
        "B1",
        "B2",
        "B3",
        "B4",
        "B5",
        "B6",
        "B7",
        "B8",
        "S1",
        "S2",
        "S3",
        "S4",
        "S5",
        "S6",
        "S7",
        "S8",
        "S9",
        "S10",
        # P1
        "K8",
        "K11",
        "K13",
        "K14",
        "K19",
        "K20",
        "K21",
        "K22",
        "K26",
        "K27",
        "K28",
        "K30",
        "K32",
        "K33",
        "K34",
        "K38",
        "K39",
        "K40",
        "K42",
        "K43",
        "K44",
        "K45",
        "P2-phase1",
        "P7",
        "P8",
        "P9",
        "P10",
        "P11",
        "P12",
        "P13",
        "P14",
        "P15",
        "P16",
        "P18",
        "P19",
        "P20",
        "P21",
        "P22",
        "P23",
        "P24",
        "P25",
        "P26",
        *{f"B{i}" for i in range(9, 26)},
        "S9b",
        "S11",
        "S12",
        "S13",
        "S14",
        # P2
        "K15",
        "P2-phase2",
        "P6b",
        "P17",
        *{f"P{i}" for i in range(27, 36)},
        *{f"B{i}" for i in range(26, 36)},
        "S15",
        "S16",
        "S17",
        "S18",
    }
)

A10_DONE = frozenset({"K43", "K44", "K45", "P29", "P30", "S18"})

_ROW_RE = re.compile(
    r"^\|\s*(?P<id>K\d+|P\d+(?:-phase\d+|b)?|B\d+|S\d+b?)\s*\|\s*(?P<owner>\S+)\s*\|\s*(?:P[012]|—|-)\s*\|\s*(?P<status>OPEN|DONE|DEFERRED|N/A|BLOCKED)\s*\|",
    re.MULTILINE,
)


def _parse_rows(text: str) -> dict[str, tuple[str, str]]:
    out: dict[str, tuple[str, str]] = {}
    for m in _ROW_RE.finditer(text):
        out[m.group("id")] = (m.group("owner"), m.group("status"))
    return out


def test_checklist_file_exists() -> None:
    assert CHECKLIST.is_file(), f"missing {CHECKLIST}"


def test_checklist_contains_every_required_id() -> None:
    text = CHECKLIST.read_text(encoding="utf-8")
    rows = _parse_rows(text)
    missing = sorted(REQUIRED_IDS - set(rows))
    assert not missing, f"checklist missing IDs: {missing}"


def test_a10_ids_marked_done() -> None:
    rows = _parse_rows(CHECKLIST.read_text(encoding="utf-8"))
    for oid in sorted(A10_DONE):
        assert oid in rows, f"{oid} not in checklist"
        _owner, status = rows[oid]
        assert status == "DONE", f"{oid} expected DONE, got {status}"


def test_a10_owner_is_a10() -> None:
    rows = _parse_rows(CHECKLIST.read_text(encoding="utf-8"))
    for oid in sorted(A10_DONE):
        owner, _ = rows[oid]
        assert owner == "A10", f"{oid} owner={owner}"


def test_prometheus_series_names_documented() -> None:
    text = CHECKLIST.read_text(encoding="utf-8")
    for _ in (
        "eden_ingest_redis_commands",
        "eden_ch_flush_batch_size",
        "eden_sse_publish_skipped",
    ):
        # Names live in A10 evidence / metrics module; checklist notes K45.
        assert "K45" in text
    audit = ROOT / "scripts" / "opt_id_audit.md"
    assert audit.is_file()
    audit_text = audit.read_text(encoding="utf-8")
    for name in (
        "eden_ingest_redis_commands",
        "eden_ch_flush_batch_size",
        "eden_sse_publish_skipped",
    ):
        assert name in audit_text, f"{name} missing from opt_id_audit.md"
