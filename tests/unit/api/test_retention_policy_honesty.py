"""The retention API must not accept promises the system does not keep.

``org_retention_policies`` stores six knobs per row. Exactly one is ever read
by anything that moves or deletes data:

    DataRetentionManager.load_org_warm_days (retention.py:545)
        SELECT DISTINCT ON (tenant_id) tenant_id, warm_days
          FROM org_retention_policies
         WHERE table_name IN ('telemetry_events', 'raw_traces')

``hot_days``, ``cold_days``, ``delete_days`` and ``pii_scrub_after_days`` were
written, echoed back by ``GET``, and read by nothing. ``delete_days`` is the
one that matters: a tenant setting "delete after 30 days" got a 200, saw the
value returned, and nothing ever deleted on that schedule. And
``governance_intel/compliance.py`` reads all six columns into an *evidence
context* for compliance reporting, so those numbers were being presented as
proof of a posture the system does not implement.

These tests pin the honest behaviour: reject on write, and label on read.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from eden.api.routes.retention_policy import (
    ENFORCED_FIELDS,
    ENFORCED_TABLES,
    UNENFORCED_FIELDS,
    RetentionPolicyIn,
    _reject_unenforceable,
)
from eden.services.data_platform.archive import DEFAULT_COLD_AGE_DAYS

GLOBAL = DEFAULT_COLD_AGE_DAYS


def _policy(**overrides) -> RetentionPolicyIn:
    base = {
        "table_name": "telemetry_events",
        "hot_days": GLOBAL,
        "warm_days": 30,
        "cold_days": GLOBAL,
        "delete_days": GLOBAL,
        "pii_scrub_after_days": None,
    }
    base.update(overrides)
    return RetentionPolicyIn(**base)


class TestTheEnforcementMapIsTrue:
    """The declaration has to match what the code actually reads.

    If these drift, every test below keeps passing while the API resumes
    accepting unenforceable values -- the exact failure being fixed.
    """

    def test_warm_days_is_the_only_column_any_job_reads(self) -> None:
        import inspect

        from eden.data_platform.retention import DataRetentionManager

        sql = inspect.getsource(DataRetentionManager.load_org_warm_days)
        for field in UNENFORCED_FIELDS:
            assert field not in sql, (
                f"{field} is now read by load_org_warm_days but is still "
                "listed as unenforced; UNENFORCED_FIELDS is stale and the API "
                "is rejecting a value it could honour"
            )
        for field in ENFORCED_FIELDS:
            assert field in sql, (
                f"{field} is declared enforced but load_org_warm_days does "
                "not select it"
            )

    def test_the_enforced_tables_match_the_query(self) -> None:
        import inspect

        from eden.data_platform.retention import DataRetentionManager

        sql = inspect.getsource(DataRetentionManager.load_org_warm_days)
        for table in ENFORCED_TABLES:
            assert table in sql, (
                f"{table} is declared enforced but does not appear in the "
                "query that loads per-org overrides"
            )

    def test_the_two_sets_are_disjoint_and_cover_the_input_model(self) -> None:
        assert not set(ENFORCED_FIELDS) & set(UNENFORCED_FIELDS)
        declared = set(ENFORCED_FIELDS) | set(UNENFORCED_FIELDS)
        model_fields = set(RetentionPolicyIn.model_fields) - {
            "table_name",
            "notes",
        }
        assert declared == model_fields, (
            f"the enforcement map does not cover the request model: "
            f"{model_fields ^ declared} unaccounted for. A new knob added to "
            "the model without a decision about enforcement is exactly how "
            "this drifted."
        )


class TestWriteRejectsWhatItCannotKeep:
    def test_an_enforceable_policy_is_accepted(self) -> None:
        _reject_unenforceable(_policy(warm_days=14))

    def test_unset_optional_fields_are_accepted(self) -> None:
        _reject_unenforceable(_policy(pii_scrub_after_days=None))

    @pytest.mark.parametrize("field", UNENFORCED_FIELDS)
    def test_setting_an_unenforced_field_is_rejected(self, field: str) -> None:
        with pytest.raises(HTTPException) as ei:
            _reject_unenforceable(_policy(**{field: 7}))
        assert ei.value.status_code == 422
        assert field in str(ei.value.detail), (
            f"the rejection does not name {field}, so the caller cannot tell "
            f"which value was refused: {ei.value.detail}"
        )

    @pytest.mark.parametrize("table", ["audit_log", "usage_events", "spans"])
    def test_a_table_with_no_enforcement_is_rejected(self, table: str) -> None:
        with pytest.raises(HTTPException) as ei:
            _reject_unenforceable(_policy(table_name=table))
        assert ei.value.status_code == 422
        assert table in str(ei.value.detail)

    @pytest.mark.parametrize("table", ENFORCED_TABLES)
    def test_the_enforced_tables_are_accepted(self, table: str) -> None:
        _reject_unenforceable(_policy(table_name=table))

    def test_the_error_says_what_the_global_window_is(self) -> None:
        """A refusal that does not say what *does* apply is not honest, just
        unhelpful."""
        with pytest.raises(HTTPException) as ei:
            _reject_unenforceable(_policy(delete_days=30))
        assert str(GLOBAL) in str(ei.value.detail)

    def test_warm_days_may_differ_from_the_global_default(self) -> None:
        """The whole point of the endpoint. A rejection rule that caught this
        would make the API useless rather than dishonest."""
        _reject_unenforceable(_policy(warm_days=GLOBAL + 45))
        _reject_unenforceable(_policy(warm_days=1))


class TestReadLabelsWhatIsEnforced:
    def test_the_response_model_declares_enforcement(self) -> None:
        from eden.api.routes.retention_policy import RetentionPolicyOut

        out = RetentionPolicyOut(
            policy_id="p1",
            tenant_id="t1",
            table_name="telemetry_events",
            hot_days=GLOBAL,
            warm_days=30,
            cold_days=GLOBAL,
            delete_days=GLOBAL,
            pii_scrub_after_days=None,
            effective_from="2026-01-01T00:00:00+00:00",
        )
        assert out.enforced_fields == list(ENFORCED_FIELDS)
        assert out.unenforced_fields == list(UNENFORCED_FIELDS)
        assert "delete_days" in out.unenforced_fields, (
            "delete_days must be labelled unenforced -- rows written before "
            "the write path started rejecting them are still in the table, "
            "and a reader cannot otherwise tell"
        )


class TestComplianceEvidenceIsLabelled:
    """The evidence context is where an unenforced number does real harm."""

    @pytest.mark.asyncio
    async def test_evidence_rows_carry_enforcement_labels(self) -> None:
        from eden.services.governance_intel.compliance import (
            ComplianceEvidenceGenerator,
        )

        rows = [
            {
                "table_name": "telemetry_events",
                "hot_days": 7,
                "warm_days": 30,
                "cold_days": 90,
                "delete_days": 30,
                "pii_scrub_after_days": 14,
            },
            {
                "table_name": "audit_log",
                "hot_days": 7,
                "warm_days": 30,
                "cold_days": 90,
                "delete_days": 30,
                "pii_scrub_after_days": 14,
            },
        ]

        class _Client:
            async def fetch(self, *a, **k):
                return rows

            async def fetchrow(self, *a, **k):
                return None

            async def fetchval(self, *a, **k):
                return None

        gen = ComplianceEvidenceGenerator.__new__(ComplianceEvidenceGenerator)
        ctx = await ComplianceEvidenceGenerator._evidence_context(
            gen,
            _Client(),
            "org-1",
            None,
            None,
            {},
        )

        entries = [
            e for e in (ctx.get("retention_settings") or []) if "table_name" in e
        ]
        assert entries, (
            f"no retention rows reached the evidence context: {ctx!r}"
        )

        by_table = {e["table_name"]: e for e in entries}
        enforced = by_table.get("telemetry_events")
        assert enforced is not None
        assert "delete_days" in enforced["unenforced_fields"], (
            "delete_days was emitted as compliance evidence without being "
            "marked unenforced -- nothing deletes on that schedule"
        )
        assert enforced["enforced_fields"] == list(ENFORCED_FIELDS)

        ignored = by_table.get("audit_log")
        assert ignored is not None
        assert ignored["enforced_fields"] == [], (
            "a policy row for a table outside ENFORCED_TABLES is ignored "
            "entirely, including its warm_days, so nothing about it is "
            "enforced"
        )
