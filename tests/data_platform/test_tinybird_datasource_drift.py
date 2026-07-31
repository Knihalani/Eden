"""The Tinybird datasources must not drift from the ClickHouse DDL.

The committed `.datasource` files were auto-generated from NDJSON samples
(`DESCRIPTION > Generated from /tmp/sample_*.ndjson`), so every type came out
as the widest thing JSON inference could justify. Measured against the DDL in
`data_platform/clickhouse_sink.py`, that was ~40 mismatches over five tables:

* all 17 `LowCardinality(String)` columns had become plain `String` — the
  largest compression regression on the Tinybird side
* all 6 `DateTime64(3)` had become `DateTime`, **truncating to whole seconds**,
  which destroys span ordering *within* a trace
* all 9 `UUID` had become `String` (16 bytes to ~36)
* all 7 `Float64` had become `Float32`, including three currency columns
* every unsigned integer had become signed (`UInt32`→`Int32`, `UInt8`→`Int16`)
* the `date Date DEFAULT toDate(timestamp)` column was missing from all four
  tables that define it

Two schemas for one logical table is not a drift to be re-fixed whenever
someone notices; it is a missing generator. `scripts/gen_tinybird_datasources.py`
derives the datasources from the DDL, and this test is the ratchet: change the
DDL, re-run the script, commit both.

`scripts/migration_drift.py` and `scripts/sql_schema_guard.py` both exist but
neither covers this surface.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
GEN = ROOT / "scripts/gen_tinybird_datasources.py"
DS_DIR = ROOT / "tinybird/datasources"
SINK = ROOT / "src/eden/data_platform/clickhouse_sink.py"


def test_the_generator_reports_no_drift() -> None:
    """The ratchet. Equivalent to the OpenAPI snapshot test."""
    proc = subprocess.run(
        [sys.executable, str(GEN), "--check"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert proc.returncode == 0, (
        "tinybird/datasources/*.datasource no longer match the ClickHouse "
        f"DDL.\n{proc.stdout}\n{proc.stderr}"
    )


def _schema_types(path: Path) -> dict[str, str]:
    """Column → type from a .datasource SCHEMA block."""
    text = path.read_text()
    block = text.split("SCHEMA >", 1)[1].split("\nENGINE", 1)[0]
    block = block.split("INDEXES >", 1)[0]
    out: dict[str, str] = {}
    for line in block.splitlines():
        line = line.strip().rstrip(",")
        if not line:
            continue
        m = re.match(r"^(\w+)\s+(.+?)(?:\s+`json:|\s+DEFAULT\s|$)", line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


@pytest.mark.parametrize(
    "table",
    [
        "agent_performance",
        "pipeline_stages",
        "usage_trends",
        "benchmark_results",
        "telemetry_events_ch",
    ],
)
def test_no_type_was_widened_by_json_inference(table: str) -> None:
    """Guard the specific widenings that JSON inference produced.

    These are asserted by name rather than only via the generator, so the
    failure message says *what* regressed rather than just "files differ".
    """
    types = _schema_types(DS_DIR / f"{table}.datasource")
    assert types, f"could not parse a SCHEMA block from {table}.datasource"

    ddl = SINK.read_text().split(f"{table} (", 1)[1].split('"""', 1)[0]
    for col, ds_type in types.items():
        m = re.search(rf"^\s*{col}\s+(.+?)(?:\s+CODEC|\s+DEFAULT|,\s*$|$)", ddl, re.M)
        # A column in the datasource but NOT in the DDL is exactly the shape a
        # generator bug takes (a stale column left behind after the DDL dropped
        # it). Skipping it silently was the wrong direction to be lenient in.
        assert m, (
            f"{table}.{col} exists in the .datasource but not in the "
            "ClickHouse DDL — the generated file is stale; re-run "
            "scripts/gen_tinybird_datasources.py"
        )
        ddl_type = m.group(1).strip().rstrip(",").strip()
        assert ds_type == ddl_type, (
            f"{table}.{col}: datasource says {ds_type!r}, DDL says "
            f"{ddl_type!r}. JSON-sample inference previously widened every "
            "LowCardinality to String, every DateTime64(3) to DateTime, every "
            "UUID to String and every Float64 to Float32."
        )


def test_sub_second_precision_survives() -> None:
    """`DateTime` instead of `DateTime64(3)` truncates to whole seconds.

    Spans inside one trace are frequently milliseconds apart, so this is not a
    rounding nicety — it destroys their ordering.
    """
    for path in DS_DIR.glob("*.datasource"):
        for col, ctype in _schema_types(path).items():
            if col in ("timestamp", "ingested_at"):
                assert ctype == "DateTime64(3)", (
                    f"{path.name}:{col} is {ctype}; sub-second precision is "
                    "required to order spans within a trace"
                )


def test_low_cardinality_is_preserved() -> None:
    """Dictionary encoding on these columns is most of the storage win."""
    expected = {
        "agent_performance": ("agent_name", "event_type", "model", "pipeline_stage"),
        "telemetry_events_ch": ("realm", "event_type", "outcome", "model", "finish_reason"),
    }
    for table, cols in expected.items():
        types = _schema_types(DS_DIR / f"{table}.datasource")
        for col in cols:
            assert types.get(col) == "LowCardinality(String)", (
                f"{table}.{col} is {types.get(col)!r}; plain String loses "
                "dictionary encoding"
            )


def test_the_default_date_column_is_not_dropped() -> None:
    """It was missing from all four datasources whose DDL defines it."""
    checked = 0
    for table in ("agent_performance", "pipeline_stages", "usage_trends", "benchmark_results"):
        text = (DS_DIR / f"{table}.datasource").read_text()
        ddl = SINK.read_text().split(f"{table} (", 1)[1].split('"""', 1)[0]
        # Read the expression from the DDL rather than assuming
        # ``toDate(timestamp)``: ``usage_trends`` buckets by ``hour``, so its
        # default is ``toDate(hour)``.
        m = re.search(r"^\s*date\s+Date\s+DEFAULT\s+([^\n,]+)", ddl, re.M)
        if not m:
            continue
        expr = m.group(1).strip().rstrip(",").strip()
        checked += 1
        assert f"date Date DEFAULT {expr}" in text, (
            f"{table}.datasource omits the `date DEFAULT {expr}` column its "
            "DDL defines"
        )
    assert checked == 4, (
        f"expected 4 tables with a `date` DEFAULT column, matched {checked} — "
        "this guard has gone stale against the DDL"
    )


def test_codecs_are_not_emitted_into_datasources() -> None:
    """Compression is ClickHouse-side; only the type has to agree.

    Also a regression guard on the generator itself: its first version used
    ``CODEC\\([^)]*\\)`` to strip the clause, which cannot match the nested
    parentheses in ``CODEC(Delta, ZSTD(3))``, so the substitution silently did
    nothing and the codecs were emitted verbatim.
    """
    for path in DS_DIR.glob("*.datasource"):
        assert "CODEC" not in path.read_text(), (
            f"{path.name} carries a CODEC clause; that belongs in the "
            "ClickHouse DDL only"
        )


def test_ttl_units_match_rather_than_approximate() -> None:
    """`toIntervalDay(2555)` for `INTERVAL 7 YEAR` drifts ~2 days on leap years."""
    for path in DS_DIR.glob("*.datasource"):
        text = path.read_text()
        assert "toIntervalDay(2555)" not in text, (
            f"{path.name} approximates 7 years as 2555 days; use "
            "toIntervalYear(7) so the two substrates expire rows together"
        )
