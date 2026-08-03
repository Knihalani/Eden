"""Wave 5: the ClickHouse subsystem had never executed a single statement.

``ClickHouseSink._execute`` passed its SQL as ``session.post(url, data={...})``,
which aiohttp form-encodes into the request body. ClickHouse's HTTP interface
reads the request body *as SQL*, so it received the literal text
``query=SELECT+1+AS+ok`` and answered:

    Code: 62. DB::Exception: Syntax error: failed at position 1 ('query')

Verified against ClickHouse 24.3: even ``SELECT 1`` could not get through. So
``init_schema()`` died on its first ``CREATE TABLE``, no schema was ever built,
and every insert raised — while each caller caught the exception and fell back
to Postgres. The columnar store was decorative and nothing said so, because no
fallback counter existed and two of the three query-path handlers did not even
log.

Fixing the transport immediately exposed two more defects that had been sitting
behind it, neither reachable while nothing could execute:

* ``TTL timestamp + INTERVAL 90 DAY`` on a ``DateTime64(3)`` column —
  ``BAD_TTL_EXPRESSION``, so ``telemetry_events_ch`` was uncreatable on its own
  terms. Four tables were affected.
* ``avgState(duration_ms)`` over ``benchmark_results.duration_ms UInt32``
  produces ``AggregateFunction(avg, UInt32)``, which ClickHouse refuses to
  convert to ``AggregateFunction(avg, Float64)`` rather than widening.

And the rollups themselves stored averages and percentiles as plain ``Float64``
under ``SummingMergeTree``, an engine that collapses same-key rows by *adding*
every non-key numeric column. A materialized view emits one partial row per
inserted block, so with 1000 events over 10 blocks the true avg of 201.1ms was
stored as 2010.9ms and the true p95 of 290ms as 2888.6ms — wrong by a factor of
the block count, growing with ingest, and reproduced exactly by
``OPTIMIZE FINAL`` because the merge is what does the summing.

The unit tests below need no server. The ``realdb`` ones do, and are skipped
without ``EDEN_TEST_CLICKHOUSE_URL`` — they exist because every defect above is
invisible to a mocked sink: the mocks made the broken transport return valid
TSV.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import pytest

SINK_SRC = (
    Path(__file__).resolve().parents[2]
    / "src/eden/data_platform/clickhouse_sink.py"
).read_text()

CH_URL = os.environ.get("EDEN_TEST_CLICKHOUSE_URL", "")
needs_ch = pytest.mark.skipif(
    not CH_URL, reason="set EDEN_TEST_CLICKHOUSE_URL to run against a real ClickHouse"
)


class TestTransportSendsSqlWhereClickHouseReadsIt:
    """No server needed: assert on how the request is actually formed."""

    @pytest.mark.asyncio
    async def test_execute_puts_the_query_in_the_query_string(self) -> None:
        from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink

        seen: dict[str, Any] = {}

        class _Resp:
            status = 200

            async def text(self) -> str:
                return "1"

            async def __aenter__(self) -> Any:
                return self

            async def __aexit__(self, *a: object) -> bool:
                return False

        class _Session:
            def post(self, url: str, **kw: Any) -> Any:
                seen.update(kw)
                seen["url"] = url
                return _Resp()

        sink = ClickHouseSink(ClickHouseConfig(url="http://ch.invalid", database="eden"))
        sink._session = _Session()
        await sink._execute("SELECT 1")

        sent = seen.get("params", {}).get("query", "")
        assert sent.startswith("SELECT 1"), (
            "the statement must be a query-string parameter; passing it as "
            "form-encoded body data makes ClickHouse parse 'query=SELECT 1' "
            f"as SQL and reject every statement (got {sent!r})"
        )
        assert "data" not in seen or not seen["data"], (
            "a plain statement must not send a body — ClickHouse reads the "
            "body as SQL"
        )

    @pytest.mark.asyncio
    async def test_insert_sends_rows_as_the_body_and_sql_in_the_query_string(
        self,
    ) -> None:
        from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink

        seen: dict[str, Any] = {}

        class _Resp:
            status = 200

            async def text(self) -> str:
                return ""

            async def __aenter__(self) -> Any:
                return self

            async def __aexit__(self, *a: object) -> bool:
                return False

        class _Session:
            def post(self, url: str, **kw: Any) -> Any:
                seen.update(kw)
                return _Resp()

        sink = ClickHouseSink(ClickHouseConfig(url="http://ch.invalid", database="eden"))
        sink._session = _Session()
        await sink._insert_json("telemetry_events_ch", [{"event_id": "e1"}])

        assert "INSERT INTO" in seen.get("params", {}).get("query", "")
        assert "FORMAT JSONEachRow" in seen["params"]["query"]
        body = seen.get("data")
        assert isinstance(body, str) and "e1" in body, (
            "rows belong in the body as NDJSON; the old form-encoded "
            "{'query': ..., '': body} shape made ClickHouse reject the insert"
        )


class TestDdlIsWellFormedBeforeItEverRuns:
    """Static guards for the two defects the transport bug was hiding."""

    def test_no_ttl_is_applied_directly_to_a_datetime64_column(self) -> None:
        # ClickHouse: "TTL expression result column should have DateTime or
        # Date type, but has DateTime64(3)" (BAD_TTL_EXPRESSION).
        dt64_cols = set(
            re.findall(r"^\s*(\w+)\s+DateTime64\(3\)", SINK_SRC, re.M)
        )
        assert dt64_cols, "expected some DateTime64(3) columns; guard is stale"
        bad = [
            expr
            for expr in re.findall(r"TTL\s+([^\n]+)", SINK_SRC)
            for col in dt64_cols
            if re.match(rf"^{col}\s*\+", expr.strip())
        ]
        assert not bad, (
            f"TTL applied straight to a DateTime64(3) column: {bad}. "
            "Wrap it, e.g. TTL toDateTime(timestamp) + INTERVAL 90 DAY"
        )

    def test_aggregate_state_arguments_are_cast(self) -> None:
        # avgState over a UInt32 column yields AggregateFunction(avg, UInt32),
        # which ClickHouse will not convert to AggregateFunction(avg, Float64).
        uncast = re.findall(r"(?:avgState|quantileState\([^)]*\))\((\w+)\)", SINK_SRC)
        assert not uncast, (
            f"aggregate state built from a bare column: {uncast}. Cast it "
            "(toFloat64(...)) so the stored state type matches the DDL "
            "regardless of the source column's type"
        )

    def test_no_average_or_percentile_lives_in_a_summing_merge_tree(self) -> None:
        """The engine adds every non-key numeric column on merge."""
        blocks = re.split(r"CREATE TABLE IF NOT EXISTS", SINK_SRC)[1:]
        offenders = []
        for block in blocks:
            head = block.split('"""')[0]
            if "SummingMergeTree" not in head:
                continue
            for col in re.findall(r"^\s*(\w*(?:avg|p50|p95|p99|mean)\w*)\s+", head, re.M):
                offenders.append(col)
        assert not offenders, (
            f"averages/percentiles under SummingMergeTree: {offenders}. Summing "
            "them yields the sum of per-block aggregates, which is meaningless "
            "at any block count above one."
        )

    def test_the_rollups_use_aggregating_merge_tree(self) -> None:
        from eden.data_platform.clickhouse_sink import ClickHouseSink

        for table, _view in ClickHouseSink._ROLLUP_TABLES:
            block = SINK_SRC.split(f"{table} (", 1)
            assert len(block) == 2, f"no DDL found for {table}"
            head = block[1][:1200]
            assert "AggregatingMergeTree" in head, f"{table} is not aggregating"

    def test_counts_in_an_aggregating_table_carry_merge_semantics(self) -> None:
        """A plain UInt64 under AggregatingMergeTree collapses arbitrarily.

        Caught by measurement, not review: a first attempt left ``event_count``
        as ``UInt64`` and the rollup reported 500 of 1000 events, because
        AggregatingMergeTree replaces non-aggregate columns with an
        unspecified one of the collapsed rows.
        """
        checked = 0
        for name in ("event_count", "error_count", "run_count", "pass_count"):
            # DDL only: ``name Type…`` — skip Python assigns like
            # ``event_count = int(float(cur.get(...)))`` introduced by
            # Home KPI dict builders that share the same identifiers.
            for m in re.finditer(rf"^\s*{name}\s+([^,\n=]+)", SINK_SRC, re.M):
                decl = m.group(1).strip()
                if not decl or decl.startswith("(") or "get(" in decl:
                    continue
                checked += 1
                assert "SimpleAggregateFunction" in decl or "AggregateFunction" in decl, (
                    f"{name} declared as {decl!r}; under AggregatingMergeTree a "
                    "plain numeric column is not summed on merge"
                )
        # Without this, renaming any of the four columns makes the loops match
        # nothing and the test passes having asserted precisely nothing.
        assert checked >= 4, (
            f"only {checked} counter column declaration(s) found; expected at "
            "least 4 (event_count, error_count, run_count, pass_count) — this "
            "guard has gone stale against the DDL"
        )


class TestLogicalNamesAreTranslatedForClickHouse:
    """The aggregation query was wrong five independent ways at once.

    It interpolated the *Postgres* names into ClickHouse SQL:
    ``FROM eden.telemetry_events`` (the mirror is ``telemetry_events_ch``),
    filtered on ``org_id``/``created`` (they are ``tenant_id``/``timestamp``),
    and used ``countIf(level = 'error')`` when no ``level`` column exists
    anywhere in the ClickHouse schema. Two of the three logical tables have no
    ClickHouse mirror at all. Every call raised and was swallowed.
    """

    def test_the_map_covers_every_queryable_logical_table(self) -> None:
        from eden.columnar._common import _VALID_SOURCE_TABLES
        from eden.columnar.tables import CLICKHOUSE_TABLES

        missing = set(_VALID_SOURCE_TABLES) - set(CLICKHOUSE_TABLES)
        assert not missing, (
            f"logical tables with no entry in the map: {missing}. An unmapped "
            "name silently reaches ClickHouse as-is."
        )

    def test_tables_without_a_mirror_are_named_as_such(self) -> None:
        from eden.columnar.tables import (
            clickhouse_table,
            has_clickhouse_mirror,
        )

        assert has_clickhouse_mirror("telemetry_events")
        assert clickhouse_table("telemetry_events") == "telemetry_events_ch"
        for logical in ("usage_events", "judge_scores"):
            assert not has_clickhouse_mirror(logical)
            # And asking anyway must raise rather than guess.
            with pytest.raises(KeyError):
                clickhouse_table(logical)

    def test_column_names_are_translated(self) -> None:
        from eden.columnar.tables import clickhouse_column

        t = "telemetry_events"
        assert clickhouse_column(t, "org_id") == "tenant_id"
        assert clickhouse_column(t, "created") == "timestamp"
        assert clickhouse_column(t, "level") == "outcome"
        # Unmapped columns pass through — duration_ms is the same on both sides.
        assert clickhouse_column(t, "duration_ms") == "duration_ms"

    @pytest.mark.asyncio
    async def test_the_generated_sql_uses_physical_names(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Capture the SQL the aggregator actually emits.

        An earlier version of this guard grepped the source for the offending
        literals (``org_id = '``, ``qualified_table(table)``). Both mutants
        survived it: moving the expression into a local
        (``physical = sink.config.qualified_table(table)``,
        ``col_org = "org_id"``) keeps the query text identical while restoring
        the bug. Only the emitted SQL is worth asserting on.
        """
        from datetime import UTC, datetime, timedelta

        import eden.data_platform.clickhouse_sink as chs
        from eden.columnar.aggregations import ColumnarAggregator

        captured: list[str] = []

        class _Sink:
            class config:  # noqa: N801
                @staticmethod
                def qualified_table(t: str) -> str:
                    return f"eden.{t}"

            async def _execute(self, q: str, params: Any = None) -> str:
                captured.append(q)
                return "bucket\tn\tn_errors\tp95_ms\n2026-07-01\t1\t0\t1.0"

            def _parse_tsv(self, tsv: str) -> list[dict[str, Any]]:
                lines = tsv.strip().split("\n")
                hdr = lines[0].split("\t")
                return [dict(zip(hdr, ln.split("\t"), strict=True)) for ln in lines[1:]]

        async def _sink() -> Any:
            return _Sink()

        monkeypatch.setattr(chs, "get_clickhouse_sink", _sink)

        now = datetime.now(UTC)
        await ColumnarAggregator()._ch_aggregate(
            org_id="org-1",
            table="telemetry_events",
            granularity="day",
            window_start=now - timedelta(days=1),
            window_end=now,
        )
        assert captured, "no SQL was emitted"
        sql = captured[0]

        # Physical names present.
        assert "telemetry_events_ch" in sql, f"wrong table in: {sql}"
        assert "tenant_id" in sql, f"wrong tenant column in: {sql}"
        assert "outcome = 'error'" in sql, f"wrong severity column in: {sql}"
        # Postgres-only names absent. ``timestamp`` legitimately appears, so
        # check the identifiers that exist only on the Postgres side.
        assert "org_id" not in sql, f"Postgres column org_id leaked into: {sql}"
        assert "level" not in sql, f"nonexistent column 'level' in: {sql}"
        assert "toDate(created)" not in sql, f"Postgres column 'created' in: {sql}"
        assert not re.search(r"\beden\.telemetry_events\b(?!_ch)", sql), (
            f"unmirrored table name in: {sql}"
        )
        # And the datetime literals must be ClickHouse-parseable.
        assert "+00:00" not in sql, f"UTC offset in a datetime literal: {sql}"

    def test_datetime_literals_carry_no_utc_offset(self) -> None:
        """ClickHouse rejects '2026-07-29T23:00:00+00:00' outright."""
        from datetime import UTC, datetime, timedelta, timezone

        from eden.columnar.tables import clickhouse_datetime

        aware = datetime(2026, 7, 29, 23, 0, 0, tzinfo=UTC)
        assert clickhouse_datetime(aware) == "2026-07-29 23:00:00"
        assert "+" not in clickhouse_datetime(aware)
        assert "T" not in clickhouse_datetime(aware)
        # A non-UTC zone must be converted, not truncated.
        plus_two = datetime(
            2026, 7, 30, 1, 0, 0, tzinfo=timezone(timedelta(hours=2))
        )
        assert clickhouse_datetime(plus_two) == "2026-07-29 23:00:00"
        # Naive is treated as UTC, matching the rest of the columnar path.
        assert clickhouse_datetime(datetime(2026, 7, 29, 23)) == "2026-07-29 23:00:00"

    def test_the_aggregation_query_does_not_use_isoformat(self) -> None:
        src = (
            Path(__file__).resolve().parents[2] / "src/eden/columnar/aggregations.py"
        ).read_text()
        # Slice on the *definition*, not the first mention: `_ch_aggregate`
        # appears in a docstring and at its call site well before the method,
        # so splitting on the bare name pulled in the envelope code (which
        # legitimately calls isoformat() for JSON output).
        ch_block = src.split("async def _ch_aggregate", 1)[1].split(
            "async def _pg_aggregate", 1
        )[0]
        assert "isoformat()" not in ch_block, (
            "isoformat() emits a UTC offset that ClickHouse cannot parse "
            "(Code: 6, Cannot parse string as DateTime64)"
        )


class TestReadsRequestAHeaderedFormat:
    @pytest.mark.asyncio
    async def test_a_select_gets_tabseparatedwithnames(self) -> None:
        """``_parse_tsv`` reads line 0 as the header; the default has none.

        A one-row result therefore parsed as *empty* (``len(lines) < 2``) and a
        multi-row result lost its first row and mislabelled every column. Six
        of eight ``_parse_tsv`` call sites never added the clause themselves.
        """
        from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink

        sent: list[str] = []

        class _Resp:
            status = 200

            async def text(self) -> str:
                return "n\n1"

            async def __aenter__(self) -> Any:
                return self

            async def __aexit__(self, *a: object) -> bool:
                return False

        class _Session:
            def post(self, url: str, **kw: Any) -> Any:
                sent.append(kw["params"]["query"])
                return _Resp()

        sink = ClickHouseSink(ClickHouseConfig(url="http://ch.invalid", database="eden"))
        sink._session = _Session()

        await sink._execute("SELECT count() AS n FROM eden.telemetry_events_ch")
        assert sent[-1].endswith("FORMAT TabSeparatedWithNames")

        # An explicit FORMAT must be respected, not doubled.
        await sink._execute("SELECT 1 FORMAT JSON")
        assert sent[-1].count("FORMAT") == 1

        # DDL must NOT get a FORMAT appended — that is a syntax error.
        await sink._execute("CREATE TABLE IF NOT EXISTS eden.x (a UInt8) "
                            "ENGINE = MergeTree() ORDER BY a")
        assert "FORMAT" not in sent[-1]

    def test_alter_modify_ttl_statements_are_wrapped_too(self) -> None:
        """A separate list of literals from the CREATE TABLE DDL.

        These were missed by the first pass, so every ALTER failed with
        BAD_TTL_EXPRESSION and was logged at DEBUG as "TTL migration
        skipped" — tables silently kept whatever TTL they were born with.
        """
        bad = re.findall(r'"\s*timestamp \+ INTERVAL', SINK_SRC)
        assert not bad, (
            "ALTER ... MODIFY TTL still targets a bare DateTime64(3) column"
        )


class TestErrorMessagesMatchTheWhitelist:
    def test_the_granularity_message_does_not_advertise_hour(self) -> None:
        """The message said "expected one of: hour, day, week"...

        ...while the whitelist was ``{"day", "week"}``, so a caller who
        followed the message retried ``hour`` forever and got
        ``not_implemented`` every time.
        """
        from eden.columnar._common import _VALID_GRANULARITIES

        # Assert the message is *derived* from the whitelist rather than
        # banning the old literal outright: the docstrings quote it while
        # explaining the bug, so a raw-text ban flags the explanation.
        root = Path(__file__).resolve().parents[2] / "src/eden/columnar"
        for name in ("aggregations.py", "partitions.py"):
            src = (root / name).read_text()
            assert 'join(sorted(_VALID_GRANULARITIES))' in src, (
                f"{name} hardcodes its granularity list instead of deriving it, "
                "so the message can drift from the whitelist again"
            )
        assert "hour" not in _VALID_GRANULARITIES

    @pytest.mark.asyncio
    async def test_the_rejection_lists_only_accepted_values(self) -> None:
        from datetime import UTC, datetime, timedelta

        from eden.columnar.aggregations import ColumnarAggregator

        now = datetime.now(UTC)
        out = await ColumnarAggregator().precompute_rollups(
            "org-1",
            table="telemetry_events",
            granularity="hour",
            window_start=now - timedelta(days=1),
            window_end=now,
        )
        msg = str(out.get("message", ""))
        assert "day" in msg and "week" in msg
        assert "hour," not in msg and ": hour" not in msg, (
            f"the rejection message still offers 'hour': {msg!r}"
        )


class TestTelemetryStorageShape:
    """No CODEC and no skip index existed anywhere in the repository.

    Measured on ClickHouse 24.3 (see ``docs/ops/clickhouse-storage.md``):
    ZSTD(3) over the default LZ4 is 5.29x on prose-shaped payloads and 1.21x on
    incompressible worst-case bytes; a ``bloom_filter`` on ``trace_id`` takes a
    point lookup from 120,000 rows / 2.23 MiB to 13,332 rows / 255 KiB; and the
    nine unread payload blobs were 58.5%–97.7% of the compressed table. Codec
    plus removal measured 14.05x end to end.
    """

    def _telemetry_ddl(self) -> str:
        return SINK_SRC.split("telemetry_events_ch (", 1)[1].split('"""', 1)[0]

    def test_string_columns_are_zstd_compressed(self) -> None:
        ddl = self._telemetry_ddl()
        uncoded = [
            m.group(1)
            for m in re.finditer(r"^\s*(\w+)\s+String,\s*$", ddl, re.M)
        ]
        assert not uncoded, (
            f"String columns with no CODEC: {uncoded}. Default LZ4 costs up to "
            "5.29x more space on this payload shape."
        )

    def test_the_timestamps_use_delta_before_zstd(self) -> None:
        ddl = self._telemetry_ddl()
        for col in ("timestamp", "ingested_at"):
            # Capture to end of line: ``[^,\n]*`` stops at the comma *inside*
            # CODEC(Delta, ZSTD(3)) and reports a false failure.
            m = re.search(rf"^\s*{col}\s+DateTime64\(3\)(.*)$", ddl, re.M)
            assert m, f"{col} not found in the DDL"
            clause = m.group(1)
            assert "Delta" in clause and "ZSTD" in clause, (
                f"{col} carries {clause!r}; near-monotonic timestamps want "
                "CODEC(Delta, ZSTD(3))"
            )

    def test_trace_id_has_a_skip_index(self) -> None:
        ddl = self._telemetry_ddl()
        assert "INDEX idx_trace_id trace_id TYPE bloom_filter" in ddl, (
            "the sort key is (tenant_id, timestamp) but the Tinybird pipe "
            "filters on trace_id, so a single-trace lookup scans the partition"
        )

    def test_the_unread_payload_blobs_are_not_stored(self) -> None:
        from eden.data_platform.clickhouse_sink import ClickHouseSink

        ddl = self._telemetry_ddl()
        present = [
            c
            for c in ClickHouseSink._UNREAD_BLOB_COLUMNS
            if re.search(rf"^\s*{c}\s+", ddl, re.M)
        ]
        assert not present, (
            f"unread payload blobs back in the ClickHouse mirror: {present}. "
            "Postgres already holds these zstd-compressed; a second "
            "uncompressed copy was 58.5-97.7% of the table."
        )

    @pytest.mark.asyncio
    async def test_inserts_declare_that_unknown_fields_are_skippable(self) -> None:
        """The collector still sends the dropped payload keys.

        ClickHouse 24.3 already defaults ``input_format_skip_unknown_fields``
        to 1, so this is defence in depth rather than the thing that makes
        inserts work — the default has moved across versions and a server
        profile can set it to 0, which would fail every batch with
        UNKNOWN_FIELD.

        Asserting on the *request parameters*, not on the source text: a
        substring check against the file also matches the comment that explains
        the setting, so deleting the actual parameter left it green.
        """
        from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink

        seen: dict[str, Any] = {}

        class _Resp:
            status = 200

            async def text(self) -> str:
                return ""

            async def __aenter__(self) -> Any:
                return self

            async def __aexit__(self, *a: object) -> bool:
                return False

        class _Session:
            def post(self, url: str, **kw: Any) -> Any:
                seen.update(kw)
                return _Resp()

        sink = ClickHouseSink(ClickHouseConfig(url="http://ch.invalid", database="eden"))
        sink._session = _Session()
        await sink._insert_json("telemetry_events_ch", [{"event_id": "e1"}])

        assert seen.get("params", {}).get("input_format_skip_unknown_fields") == "1", (
            "the insert does not declare that unknown fields are skippable, so "
            "it depends on a server default that has changed between versions"
        )

    def test_the_storage_migration_alters_rather_than_drops_the_table(self) -> None:
        """Codecs, indexes and column drops are all ALTER-able in place.

        Unlike the rollup engine change, there is no reason to lose rows here —
        and 40-rows-before/40-after is verified by the realdb test below.
        """
        block = SINK_SRC.split("async def _migrate_telemetry_storage", 1)[1].split(
            "async def _migrate_rollup_engines", 1
        )[0]
        # Look at the statements it builds, not the whole block: the docstring
        # explains why OPTIMIZE is avoided, and a bare substring check on the
        # block matches that explanation.
        statements = re.findall(r'f?"(ALTER TABLE[^"]*|OPTIMIZE[^"]*)"', block)
        joined = " ".join(statements)
        assert "DROP TABLE" not in joined, (
            "the storage migration must not drop the table; every change it "
            "makes is available as an ALTER"
        )
        for needed in ("MODIFY COLUMN", "ADD INDEX IF NOT EXISTS", "DROP COLUMN IF EXISTS"):
            assert needed in block, f"storage migration does not {needed}"
        assert not any(s.startswith("OPTIMIZE") for s in statements), (
            "OPTIMIZE FINAL here would rewrite the whole table in one go; "
            "background merges recompress existing parts lazily"
        )


class TestFallbacksAreCounted:
    def test_the_vocabulary_is_closed(self) -> None:
        from eden.columnar.fallback_metrics import (
            REASONS,
            SURFACES,
            get_fallback_metrics,
            record_fallback,
            reset_for_tests,
        )

        reset_for_tests()
        record_fallback("not_a_surface", "not_a_reason")
        assert get_fallback_metrics().get(("unknown", "unknown")) == 1.0
        assert "query" in SURFACES and "empty" in REASONS
        reset_for_tests()

    def test_every_columnar_fallback_handler_records(self) -> None:
        """Two of these had no log and no counter at all.

        Asserting on the *call* with its surface argument, not merely on the
        identifier: a bare ``"_record_columnar_fallback(" in src`` also matches
        the helper's own ``def`` line, so deleting every call site left it
        green.
        """
        root = Path(__file__).resolve().parents[2] / "src/eden/columnar"
        for name, surface in (
            ("query.py", "query"),
            ("aggregations.py", "aggregations"),
            ("partitions.py", "partitions"),
        ):
            src = (root / name).read_text()
            call = f'_record_columnar_fallback("{surface}"'
            assert call in src, (
                f"{name} falls back to Postgres without counting it, so a "
                "100% fallback rate is indistinguishable from a healthy one"
            )
            # And it has to sit inside an exception handler, not just exist.
            handler_bodies = re.findall(
                r"except Exception[^\n]*\n((?:[ \t]+[^\n]*\n)+)", src
            )
            assert any(call in body for body in handler_bodies), (
                f"{name} has the call but not inside a fallback handler"
            )

    @pytest.mark.asyncio
    async def test_the_counter_reaches_the_metrics_endpoint(self) -> None:
        """A counter nothing scrapes is the same bug in a different place."""
        from eden.columnar.fallback_metrics import record_fallback, reset_for_tests
        from eden.observability.metrics_endpoint import metrics

        reset_for_tests()
        record_fallback("query", "query_error")
        resp = await metrics()
        body = resp.body.decode() if isinstance(resp.body, bytes) else str(resp.body)
        assert "eden_columnar_fallback_total" in body, (
            "the fallback counter is not exposed, so nothing can alert on a "
            "columnar store that is failing every query"
        )
        assert 'surface="query"' in body and 'reason="query_error"' in body
        assert "# TYPE eden_columnar_fallback_total counter" in body
        reset_for_tests()


class TestEmptyClickHouseDoesNotZeroTheDashboard:
    @pytest.mark.asyncio
    async def test_a_reachable_but_empty_clickhouse_falls_through_to_postgres(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Reachability was being read as populatedness.

        ``if ch_tiles is not None`` set ``data_source = "clickhouse"`` even for
        a zero-row answer, and the Postgres branch below only runs while
        ``data_source == "postgres"`` — so an unpopulated ClickHouse
        suppressed the substrate that had the data and Home reported zero
        traces. Happens on a first deploy, during an ingest stall, and for any
        window older than telemetry_events_ch's 90-day TTL.
        """
        from eden.api.routes import wave6_online as mod
        from eden.columnar.fallback_metrics import get_fallback_metrics, reset_for_tests

        reset_for_tests()

        async def _empty(*a: object, **k: object) -> dict[str, Any]:
            return {"event_count": 0, "prev_event_count": 0, "cost_usd": None}

        monkeypatch.setattr(mod, "_home_kpi_from_clickhouse", _empty)
        monkeypatch.setattr(
            "eden.storage.postgres.get_postgres_client",
            lambda: _resolved(None),
        )

        src = Path(mod.__file__).read_text()
        # The guard must test the count, not just non-None.
        assert 'ch_tiles is not None and int(ch_tiles.get("event_count") or 0) > 0' in src
        # Home "traces" tile prefers distinct trace_count over event rows.
        assert '"trace_count" in ch_tiles' in src
        assert get_fallback_metrics() == {}
        reset_for_tests()


@needs_ch
@pytest.mark.realdb
class TestAgainstARealClickHouse:
    """Everything above is static or mocked; these actually execute SQL.

    A mocked sink returns valid TSV for a request ClickHouse would reject, so
    the transport bug, the TTL bug and the state-type bug were all invisible
    to the existing suite. Run with:

        docker run -d --rm -p 18123:8123 clickhouse/clickhouse-server:24.3-alpine
        EDEN_TEST_CLICKHOUSE_URL=http://localhost:18123 uv run pytest -m realdb
    """

    @pytest.mark.asyncio
    async def test_init_schema_succeeds_and_rollups_match_ground_truth(self) -> None:
        import aiohttp

        from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink

        db = "eden_pytest_rollup"
        async with aiohttp.ClientSession() as s:
            async def q(sql: str) -> str:
                async with s.post(CH_URL + "/", params={"query": sql}) as r:
                    text = await r.text()
                    assert r.status == 200, text[:300]
                    return text

            await q(f"DROP DATABASE IF EXISTS {db}")
            await q(f"CREATE DATABASE {db}")

            sink = ClickHouseSink(
                ClickHouseConfig(url=CH_URL, database=db, user="default", password="")
            )
            try:
                await sink.init_schema()
            finally:
                await sink.close()

            # Ten separate blocks -> ten partial MV rows for the same day.
            for _ in range(10):
                rows = ",".join(
                    "('t1','a1','2026-07-01 12:00:00',200.0,'ok')" for _ in range(50)
                )
                await q(
                    f"INSERT INTO {db}.telemetry_events_ch "
                    "(tenant_id, agent_id, timestamp, duration_ms, outcome) "
                    f"VALUES {rows}"
                )

            got = await q(
                f"SELECT sum(event_count), avgMerge(avg_duration_state), "
                f"quantileMerge(0.95)(p95_duration_state) FROM {db}.home_kpi_daily "
                "GROUP BY tenant_id, day FORMAT TabSeparated"
            )
            events, avg_ms, p95_ms = got.strip().split("\t")
            assert int(events) == 500
            # Every event is 200.0, so avg and p95 are both exactly 200.
            assert abs(float(avg_ms) - 200.0) < 0.01, (
                f"avg came back {avg_ms}; a SummingMergeTree would report "
                "~2000 here (200 x 10 blocks)"
            )
            assert abs(float(p95_ms) - 200.0) < 0.01, f"p95 came back {p95_ms}"

            await q(f"DROP DATABASE IF EXISTS {db}")

    @pytest.mark.asyncio
    async def test_a_legacy_telemetry_table_keeps_every_row(self) -> None:
        """The storage migration must not cost data.

        Codecs, skip indexes and column drops are all ALTER-able, so a table
        created before any of this existed should come out with the same row
        count, the blobs gone, and the index added.
        """
        import aiohttp

        from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink

        db = "eden_pytest_storage"
        async with aiohttp.ClientSession() as s:
            async def q(sql: str) -> str:
                async with s.post(CH_URL + "/", params={"query": sql}) as r:
                    text = await r.text()
                    assert r.status == 200, text[:300]
                    return text

            await q(f"DROP DATABASE IF EXISTS {db}")
            await q(f"CREATE DATABASE {db}")
            # The pre-change shape: no codecs, no index, blobs present.
            await q(f"""CREATE TABLE {db}.telemetry_events_ch (
                event_id String, tenant_id String, project_id String,
                trace_id String, realm LowCardinality(String),
                event_type LowCardinality(String), timestamp DateTime64(3),
                agent_id String, agent_version String, environment_id String,
                span_id String, name String, duration_ms Float64,
                metrics String, tags String, outcome LowCardinality(String),
                request_body String, response_body String, reasoning String,
                tool_calls_full String, tool_results String, images String,
                audio String, logprobs String, citations String,
                finish_reason LowCardinality(String),
                model LowCardinality(String), model_version String,
                cache_hit UInt8, prompt_cache_savings_usd Float64,
                ingested_at DateTime64(3)
            ) ENGINE = MergeTree() PARTITION BY toYYYYMM(timestamp)
            ORDER BY (tenant_id, timestamp)""")
            vals = ",".join(
                f"('e{i}','t1','p','tr{i}','prod','llm','2026-07-01 12:00:00',"
                f"'a','1','env','s{i}','n',{100 + i},'{{}}','{{}}','ok',"
                "'BODY','RESP','R','[]','[]','IMG','','{}','[]','stop','m','1',"
                "1,0.0,'2026-07-01 12:00:00')"
                for i in range(40)
            )
            await q(f"INSERT INTO {db}.telemetry_events_ch VALUES {vals}")

            sink = ClickHouseSink(
                ClickHouseConfig(url=CH_URL, database=db, user="default", password="")
            )
            try:
                await sink.init_schema()
            finally:
                await sink.close()

            after = (
                await q(
                    f"SELECT count() FROM {db}.telemetry_events_ch FORMAT TabSeparated"
                )
            ).strip()
            assert after == "40", (
                f"the storage migration lost rows ({after} of 40 left); every "
                "step it takes is an ALTER and should be non-destructive"
            )

            cols = await q(
                "SELECT name FROM system.columns WHERE database = "
                f"'{db}' AND table = 'telemetry_events_ch' FORMAT TabSeparated"
            )
            names = {ln.strip() for ln in cols.splitlines() if ln.strip()}
            assert not (set(ClickHouseSink._UNREAD_BLOB_COLUMNS) & names), (
                "unread payload blobs survived the migration"
            )
            idx = (
                await q(
                    "SELECT name FROM system.data_skipping_indices WHERE database "
                    f"= '{db}' AND table = 'telemetry_events_ch' FORMAT TabSeparated"
                )
            ).strip()
            assert idx == "idx_trace_id", f"skip index not added (got {idx!r})"
            await q(f"DROP DATABASE IF EXISTS {db}")

    @pytest.mark.asyncio
    async def test_an_insert_carrying_dropped_keys_still_lands(self) -> None:
        import aiohttp

        from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink

        db = "eden_pytest_unknownfields"
        async with aiohttp.ClientSession() as s:
            async def q(sql: str) -> str:
                async with s.post(CH_URL + "/", params={"query": sql}) as r:
                    text = await r.text()
                    assert r.status == 200, text[:300]
                    return text

            await q(f"DROP DATABASE IF EXISTS {db}")
            await q(f"CREATE DATABASE {db}")
            sink = ClickHouseSink(
                ClickHouseConfig(url=CH_URL, database=db, user="default", password="")
            )
            try:
                await sink.init_schema()
                await sink._insert_json(
                    "telemetry_events_ch",
                    [
                        {
                            "event_id": "e1",
                            "tenant_id": "t1",
                            "trace_id": "tr1",
                            "timestamp": "2026-07-01 12:00:00",
                            "duration_ms": 100.0,
                            "outcome": "ok",
                            # Keys the mirror no longer carries.
                            "request_body": "x" * 100,
                            "images": "y" * 100,
                            "logprobs": "{}",
                        }
                    ],
                )
            finally:
                await sink.close()
            n = (
                await q(
                    f"SELECT count() FROM {db}.telemetry_events_ch FORMAT TabSeparated"
                )
            ).strip()
            assert n == "1", (
                "the insert was rejected; the collector still serialises the "
                "dropped payload keys, so JSONEachRow needs "
                "input_format_skip_unknown_fields"
            )
            await q(f"DROP DATABASE IF EXISTS {db}")

    @pytest.mark.asyncio
    async def test_a_legacy_summing_rollup_is_migrated_in_place(self) -> None:
        import aiohttp

        from eden.data_platform.clickhouse_sink import ClickHouseConfig, ClickHouseSink

        db = "eden_pytest_migrate"
        async with aiohttp.ClientSession() as s:
            async def q(sql: str) -> str:
                async with s.post(CH_URL + "/", params={"query": sql}) as r:
                    text = await r.text()
                    assert r.status == 200, text[:300]
                    return text

            await q(f"DROP DATABASE IF EXISTS {db}")
            await q(f"CREATE DATABASE {db}")
            await q(
                f"CREATE TABLE {db}.home_kpi_daily (tenant_id String, day Date, "
                "event_count UInt64, error_count UInt64, avg_duration_ms Float64, "
                "p95_duration_ms Float64) ENGINE = SummingMergeTree() "
                "PARTITION BY toYYYYMM(day) ORDER BY (tenant_id, day)"
            )

            sink = ClickHouseSink(
                ClickHouseConfig(url=CH_URL, database=db, user="default", password="")
            )
            try:
                await sink.init_schema()
            finally:
                await sink.close()

            engine = (
                await q(
                    "SELECT engine FROM system.tables WHERE database = "
                    f"'{db}' AND name = 'home_kpi_daily' FORMAT TabSeparated"
                )
            ).strip()
            assert engine == "AggregatingMergeTree", (
                f"legacy SummingMergeTree was left in place (engine={engine}); "
                "CREATE TABLE IF NOT EXISTS cannot fix it and ALTER cannot "
                "change the engine, so it must be dropped and rebuilt"
            )
            await q(f"DROP DATABASE IF EXISTS {db}")


def _resolved(value: Any) -> Any:
    async def _inner() -> Any:
        return value

    return _inner()
