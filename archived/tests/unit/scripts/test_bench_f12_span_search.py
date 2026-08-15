"""Smoke tests for ``scripts/bench_f12_span_search.py`` scale-ladder CLI.

Keeps corpus-size parsing, query-mix shape, and ladder manifest planning
from bitrotting. No Typesense or multi-minute bench runs in CI.
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from scripts.bench_f12_span_search import (
    DEFAULT_SCALE_LADDER,
    PRIOR_1M_ARTIFACT,
    _build_query_mix,
    build_ladder_manifest,
    format_corpus_rung,
    parse_corpus_size,
    parse_corpus_sizes,
    plan_ladder_rung,
    prior_gate_met,
    run_scale_ladder,
)


class TestCorpusSizeParsing:
    def test_parse_corpus_size_labels(self) -> None:
        cases = {
            "10k": 10_000,
            "100k": 100_000,
            "1m": 1_000_000,
            "10m": 10_000_000,
            "1100000": 1_100_000,
        }
        for spec, expected in cases.items():
            assert parse_corpus_size(spec) == expected

    def test_format_corpus_rung_round_trip(self) -> None:
        for label in DEFAULT_SCALE_LADDER:
            assert format_corpus_rung(parse_corpus_size(label)) == label

    def test_parse_corpus_sizes_csv(self) -> None:
        rungs = parse_corpus_sizes("10k,100k,1m,10m")
        assert [r[0] for r in rungs] == list(DEFAULT_SCALE_LADDER)
        assert [r[1] for r in rungs] == [10_000, 100_000, 1_000_000, 10_000_000]


class TestQueryMix:
    def test_build_query_mix_shape_and_distribution(self) -> None:
        random.seed(42)
        queries = _build_query_mix(1000)
        assert len(queries) == 1000
        assert all(isinstance(q, dict) for q in queries)
        empty_facet = sum(1 for q in queries if q.get("q") == "" and "agent_id" in q)
        multi = sum(
            1 for q in queries
            if " " in q.get("q", "") and q.get("q") != ""
        )
        single = sum(
            1 for q in queries
            if q.get("q") and " " not in q["q"]
        )
        # 60/30/10 mix — allow slack for randomness at n=1000
        assert 500 < single < 700
        assert 200 < multi < 400
        assert 50 < empty_facet < 150


class TestLadderPlanning:
    def test_10m_blocked_without_typesense(self) -> None:
        plan = plan_ladder_rung(
            "10m", 10_000_000,
            typesense_available=False,
            dry_run=False,
            reuse_prior=True,
        )
        assert plan["status"] == "blocked_staging"

    def test_1m_reuses_prior_when_typesense_down(self) -> None:
        if not PRIOR_1M_ARTIFACT.is_file():
            pytest.skip("prior 1.1M artifact not present in workspace")
        plan = plan_ladder_rung(
            "1m", 1_000_000,
            typesense_available=False,
            dry_run=False,
            reuse_prior=True,
        )
        assert plan["status"] == "prior_artifact"
        assert plan["results_path"] == str(PRIOR_1M_ARTIFACT)
        assert plan.get("gate_met") is True

    def test_prior_gate_met_legacy_shape(self) -> None:
        if not PRIOR_1M_ARTIFACT.is_file():
            pytest.skip("prior 1.1M artifact not present in workspace")
        from scripts.bench_f12_span_search import load_prior_artifact

        prior = load_prior_artifact(PRIOR_1M_ARTIFACT)
        assert prior_gate_met(prior) is True

    def test_dry_run_plans_small_rung(self) -> None:
        plan = plan_ladder_rung(
            "10k", 10_000,
            typesense_available=False,
            dry_run=True,
            reuse_prior=True,
        )
        assert plan["status"] == "dry_run_planned"


class TestLadderManifest:
    def test_manifest_structure(self, tmp_path: Path) -> None:
        manifest = build_ladder_manifest(
            rungs=[
                {"rung": "10k", "status": "measured", "gate_met": None},
                {"rung": "10m", "status": "blocked_staging"},
            ],
            gate_ms=200.0,
            typesense_available=False,
            dry_run=False,
            manifest_path=tmp_path / "ladder.json",
        )
        assert manifest["bench"] == "f12-span-search-scale-ladder"
        assert manifest["summary"]["measured_count"] == 1
        assert manifest["summary"]["blocked_count"] == 1
        assert "gate_met is harness-computed" in manifest["honest_caveats"][0]


class TestScaleLadderCli:
    def test_dry_run_writes_manifest_only(self, tmp_path: Path) -> None:
        manifest = tmp_path / "ladder.json"
        argv = [
            "bench_f12_span_search.py",
            "--scale-ladder",
            "--dry-run",
            "--ladder-manifest",
            str(manifest),
        ]
        with patch.object(sys, "argv", argv):
            with patch.dict("os.environ", {"TYPESENSE_API_KEY": ""}, clear=False):
                assert run_scale_ladder(
                    __import__("argparse").Namespace(
                        corpus_sizes=None,
                        scale_ladder=True,
                        dry_run=True,
                        reuse_prior=True,
                        ladder_manifest=str(manifest),
                        quiet_rungs=True,
                        requests=50,
                        tenant="bench-org",
                        facet_ab=True,
                        gate_ms=200.0,
                        out=None,
                    )
                ) == 0
        data = json.loads(manifest.read_text())
        assert data["dry_run"] is True
        assert len(data["rungs"]) == len(DEFAULT_SCALE_LADDER)
        statuses = {r["rung"]: r["status"] for r in data["rungs"]}
        assert statuses["10m"] == "blocked_staging"
