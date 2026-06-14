"""Tests for eden.evaluation.golden_dataset."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from eden.evaluation.golden_dataset import (
    DatasetRegistry,
    DifficultyLevel,
    EnvironmentCategory,
    GoldenCase,
    GoldenDataset,
    load_canonical_datasets,
)


class TestGoldenCase:
    def test_basic_creation(self):
        case = GoldenCase(
            case_id="test_001",
            category=EnvironmentCategory.AGENT_SANDBOX,
            difficulty=DifficultyLevel.INTERMEDIATE,
            description="Test case",
            input_spec={"key": "value"},
            expected_behavior={"result": True},
        )
        assert case.case_id == "test_001"
        assert case.category == EnvironmentCategory.AGENT_SANDBOX
        assert case.difficulty == DifficultyLevel.INTERMEDIATE

    def test_to_dict_roundtrip(self):
        case = GoldenCase(
            case_id="test_002",
            category=EnvironmentCategory.TOOL_USE,
            difficulty=DifficultyLevel.ADVANCED,
            description="Tool test",
            input_spec={"tools": ["calc"]},
            expected_behavior={"pass": True},
            pass_criteria={"min_success_rate": 0.85},
            tags=["tool"],
            rationale="Testing tool use",
        )
        d = case.to_dict()
        restored = GoldenCase.from_dict(d)
        assert restored.case_id == case.case_id
        assert restored.category == case.category
        assert restored.difficulty == case.difficulty
        assert restored.pass_criteria == case.pass_criteria
        assert restored.tags == case.tags


class TestGoldenDataset:
    def test_creation_and_validation(self):
        cases = [
            GoldenCase(
                case_id=f"c{i}",
                category=EnvironmentCategory.AGENT_SANDBOX,
                difficulty=DifficultyLevel.BEGINNER,
                description=f"Case {i}",
                input_spec={},
                expected_behavior={},
            )
            for i in range(3)
        ]
        dataset = GoldenDataset(
            dataset_id="gd_test",
            version="1.0.0",
            frozen_at="2024-01-01T00:00:00Z",
            description="Test dataset",
            cases=cases,
        )
        assert len(dataset.cases) == 3
        errors = dataset.validate()
        assert not errors

    def test_validation_detects_duplicate_ids(self):
        cases = [
            GoldenCase(
                case_id="dup",
                category=EnvironmentCategory.AGENT_SANDBOX,
                difficulty=DifficultyLevel.BEGINNER,
                description="Dup 1",
                input_spec={},
                expected_behavior={},
            ),
            GoldenCase(
                case_id="dup",
                category=EnvironmentCategory.TOOL_USE,
                difficulty=DifficultyLevel.BEGINNER,
                description="Dup 2",
                input_spec={},
                expected_behavior={},
            ),
        ]
        dataset = GoldenDataset(
            dataset_id="gd_dup",
            version="1.0.0",
            frozen_at="2024-01-01T00:00:00Z",
            description="Dup test",
            cases=cases,
        )
        errors = dataset.validate()
        assert len(errors) == 1
        assert "Duplicate case_id" in errors[0]

    def test_json_roundtrip(self):
        cases = [
            GoldenCase(
                case_id="json_test",
                category=EnvironmentCategory.LLM_AGENT_EVAL,
                difficulty=DifficultyLevel.EXPERT,
                description="JSON test",
                input_spec={"q": "What is 2+2?"},
                expected_behavior={"a": "4"},
            )
        ]
        dataset = GoldenDataset(
            dataset_id="gd_json",
            version="1.0.0",
            frozen_at="2024-01-01T00:00:00Z",
            description="JSON test",
            cases=cases,
        )
        json_str = dataset.to_json()
        restored = GoldenDataset.from_json(json_str)
        assert restored.dataset_id == dataset.dataset_id
        assert len(restored.cases) == 1
        assert restored.cases[0].case_id == "json_test"

    def test_filter_by_category(self):
        cases = [
            GoldenCase("c1", EnvironmentCategory.AGENT_SANDBOX, DifficultyLevel.BEGINNER, "", {}, {}),
            GoldenCase("c2", EnvironmentCategory.TOOL_USE, DifficultyLevel.BEGINNER, "", {}, {}),
            GoldenCase("c3", EnvironmentCategory.AGENT_SANDBOX, DifficultyLevel.BEGINNER, "", {}, {}),
        ]
        dataset = GoldenDataset("gd", "1.0", "2024-01-01", "", cases)
        agent_cases = dataset.get_cases_by_category(EnvironmentCategory.AGENT_SANDBOX)
        assert len(agent_cases) == 2
        tool_cases = dataset.get_cases_by_category(EnvironmentCategory.TOOL_USE)
        assert len(tool_cases) == 1

    def test_filter_by_tag(self):
        cases = [
            GoldenCase("c1", EnvironmentCategory.AGENT_SANDBOX, DifficultyLevel.BEGINNER, "", {}, {}, tags=["tag_a"]),
            GoldenCase("c2", EnvironmentCategory.AGENT_SANDBOX, DifficultyLevel.BEGINNER, "", {}, {}, tags=["tag_b"]),
        ]
        dataset = GoldenDataset("gd", "1.0", "2024-01-01", "", cases)
        assert len(dataset.get_cases_by_tag("tag_a")) == 1
        assert len(dataset.get_cases_by_tag("missing")) == 0


class TestDatasetRegistry:
    def test_register_and_get(self):
        registry = DatasetRegistry()
        dataset = GoldenDataset("gd1", "1.0.0", "2024-01-01", "Test", [])
        registry.register(dataset, is_draft=False)

        retrieved = registry.get("gd1")
        assert retrieved is not None
        assert retrieved.version == "1.0.0"

    def test_get_latest_version(self):
        registry = DatasetRegistry()
        registry.register(GoldenDataset("gd1", "1.0.0", "2024-01-01", "", []), is_draft=False)
        registry.register(GoldenDataset("gd1", "1.1.0", "2024-01-02", "", []), is_draft=False)
        registry.register(GoldenDataset("gd1", "2.0.0", "2024-01-03", "", []), is_draft=False)

        latest = registry.get("gd1")
        assert latest is not None
        assert latest.version == "2.0.0"

    def test_freeze_draft(self):
        registry = DatasetRegistry()
        draft = GoldenDataset("gd1", "1.0.0", "", "Draft", [])
        registry.register(draft, is_draft=True)

        frozen = registry.freeze("gd1", "1.0.0")
        assert frozen.frozen_at != ""

        # Draft should be removed
        assert registry.get("gd1", "1.0.0") == frozen

    def test_save_and_load_from_disk(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            registry = DatasetRegistry(storage_path=Path(tmpdir))
            case = GoldenCase("c1", EnvironmentCategory.AGENT_SANDBOX, DifficultyLevel.BEGINNER, "Test", {}, {})
            dataset = GoldenDataset("gd_disk", "1.0.0", "2024-01-01", "Disk test", [case])
            registry.register(dataset, is_draft=False)

            path = registry.save_to_disk(dataset)
            assert path.exists()

            new_registry = DatasetRegistry(storage_path=Path(tmpdir))
            loaded = new_registry.load_from_disk(path)
            assert loaded.dataset_id == "gd_disk"
            assert len(loaded.cases) == 1


class TestLoadCanonicalDatasets:
    def test_loads_50_cases(self):
        registry = load_canonical_datasets()
        dataset = registry.get("gd_eden_canonical_v1")
        assert dataset is not None
        assert len(dataset.cases) == 50

    def test_has_all_categories(self):
        registry = load_canonical_datasets()
        dataset = registry.get("gd_eden_canonical_v1")
        categories = {c.category for c in dataset.cases}
        expected = {
            EnvironmentCategory.AGENT_SANDBOX,
            EnvironmentCategory.LLM_AGENT_EVAL,
            EnvironmentCategory.TOOL_USE,
            EnvironmentCategory.MULTI_AGENT,
            EnvironmentCategory.ADVERSARIAL,
            EnvironmentCategory.SIMULATION,
        }
        assert categories == expected

    def test_has_all_difficulty_levels(self):
        registry = load_canonical_datasets()
        dataset = registry.get("gd_eden_canonical_v1")
        levels = {c.difficulty for c in dataset.cases}
        assert DifficultyLevel.BEGINNER in levels
        assert DifficultyLevel.INTERMEDIATE in levels
        assert DifficultyLevel.ADVANCED in levels
        assert DifficultyLevel.EXPERT in levels

    def test_pass_criteria_present(self):
        registry = load_canonical_datasets()
        dataset = registry.get("gd_eden_canonical_v1")
        assert dataset.overall_pass_criteria
        assert "min_overall_success_rate" in dataset.overall_pass_criteria
