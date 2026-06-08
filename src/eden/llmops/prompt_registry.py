"""Eden LLMOps — Prompt Registry with versioning & A/B testing.

Immutable prompt templates with Jinja2 rendering, automatic A/B test
promotion, and emergency rollback capability.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class PromptTemplate:
    prompt_id: str
    prompt_name: str
    agent_scope: str
    version: int
    template_text: str
    template_hash: str
    variables: dict[str, Any] = field(default_factory=dict)
    is_default: bool = False
    created_by: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "prompt_id": self.prompt_id,
            "prompt_name": self.prompt_name,
            "agent_scope": self.agent_scope,
            "version": self.version,
            "template_hash": self.template_hash,
            "variables": self.variables,
            "is_default": self.is_default,
            "created_by": self.created_by,
            "created_at": self.created_at.isoformat(),
            "metadata": self.metadata,
        }


@dataclass
class PromptABTest:
    test_id: str
    prompt_name: str
    variant_a_id: str
    variant_b_id: str
    traffic_split: float = 0.50
    success_metric: str = "env_pass_rate"
    start_date: datetime | None = None
    end_date: datetime | None = None
    winner_id: str | None = None
    confidence_level: float | None = None
    status: str = "running"  # running | completed | stopped

    def to_dict(self) -> dict[str, Any]:
        return {
            "test_id": self.test_id,
            "prompt_name": self.prompt_name,
            "variant_a_id": self.variant_a_id,
            "variant_b_id": self.variant_b_id,
            "traffic_split": self.traffic_split,
            "success_metric": self.success_metric,
            "start_date": self.start_date.isoformat() if self.start_date else None,
            "end_date": self.end_date.isoformat() if self.end_date else None,
            "winner_id": self.winner_id,
            "confidence_level": self.confidence_level,
            "status": self.status,
        }


class PromptRegistry:
    """In-memory prompt registry with versioning and A/B testing.

    Production would persist to PostgreSQL.
    """

    def __init__(self):
        self._templates: dict[str, PromptTemplate] = {}
        self._name_index: dict[str, list[str]] = {}  # name -> [prompt_id, ...]
        self._default_versions: dict[str, str] = {}  # name -> prompt_id
        self._ab_tests: dict[str, PromptABTest] = {}
        self._name_ab: dict[str, str] = {}  # name -> test_id

    def _compute_hash(self, text: str) -> str:
        return hashlib.sha256(text.encode()).hexdigest()[:32]

    def register(self, template: PromptTemplate) -> PromptTemplate:
        template.template_hash = self._compute_hash(template.template_text)
        self._templates[template.prompt_id] = template
        self._name_index.setdefault(template.prompt_name, []).append(template.prompt_id)
        if template.is_default:
            self._default_versions[template.prompt_name] = template.prompt_id
        return template

    def get(self, prompt_id: str) -> PromptTemplate | None:
        return self._templates.get(prompt_id)

    def get_by_name_version(self, prompt_name: str, version: int) -> PromptTemplate | None:
        for pid in self._name_index.get(prompt_name, []):
            t = self._templates.get(pid)
            if t and t.version == version:
                return t
        return None

    def get_default(self, prompt_name: str) -> PromptTemplate | None:
        default_id = self._default_versions.get(prompt_name)
        if default_id:
            return self._templates.get(default_id)
        # Fallback to highest version
        versions = self.list_by_name(prompt_name)
        if versions:
            return max(versions, key=lambda t: t.version)
        return None

    def list_by_name(self, prompt_name: str) -> list[PromptTemplate]:
        ids = self._name_index.get(prompt_name, [])
        return [self._templates[i] for i in ids if i in self._templates]

    def list_all(self, agent_scope: str | None = None) -> list[PromptTemplate]:
        templates = list(self._templates.values())
        if agent_scope:
            templates = [t for t in templates if t.agent_scope == agent_scope]
        return sorted(templates, key=lambda t: (t.prompt_name, t.version))

    def set_default(self, prompt_name: str, version: int) -> PromptTemplate | None:
        template = self.get_by_name_version(prompt_name, version)
        if template:
            # Unset previous default
            for pid in self._name_index.get(prompt_name, []):
                t = self._templates.get(pid)
                if t:
                    t.is_default = False
            template.is_default = True
            self._default_versions[prompt_name] = template.prompt_id
        return template

    def create_ab_test(self, test: PromptABTest) -> PromptABTest:
        self._ab_tests[test.test_id] = test
        self._name_ab[test.prompt_name] = test.test_id
        return test

    def get_ab_test(self, test_id: str) -> PromptABTest | None:
        return self._ab_tests.get(test_id)

    def get_active_ab_test(self, prompt_name: str) -> PromptABTest | None:
        test_id = self._name_ab.get(prompt_name)
        if test_id:
            test = self._ab_tests.get(test_id)
            if test and test.status == "running":
                return test
        return None

    def resolve_prompt(
        self,
        prompt_name: str,
        override_version: int | None = None,
        ab_assignment: str | None = None,
    ) -> PromptTemplate | None:
        """Resolve which prompt variant to use, considering A/B tests."""
        if override_version is not None:
            return self.get_by_name_version(prompt_name, override_version)

        ab_test = self.get_active_ab_test(prompt_name)
        if ab_test and ab_assignment:
            variant_id = (
                ab_test.variant_a_id
                if ab_assignment == "a"
                else ab_test.variant_b_id
            )
            return self._templates.get(variant_id)

        return self.get_default(prompt_name)

    def render(
        self,
        prompt_name: str,
        variables: dict[str, Any],
        override_version: int | None = None,
        ab_assignment: str | None = None,
    ) -> str:
        """Resolve and render a prompt template with variable substitution."""
        template = self.resolve_prompt(prompt_name, override_version, ab_assignment)
        if not template:
            raise ValueError(f"Prompt not found: {prompt_name}")

        try:
            from jinja2 import Template, StrictUndefined
            jinja_tpl = Template(
                template.template_text,
                undefined=StrictUndefined,
            )
            return jinja_tpl.render(**variables)
        except Exception as e:
            raise ValueError(f"Template rendering failed for {prompt_name}: {e}")

    def promote_ab_winner(self, test_id: str) -> PromptTemplate | None:
        """Promote the winning A/B test variant to default."""
        test = self._ab_tests.get(test_id)
        if not test or not test.winner_id:
            return None
        winner = self._templates.get(test.winner_id)
        if winner:
            self.set_default(winner.prompt_name, winner.version)
            test.status = "completed"
            test.end_date = datetime.now(timezone.utc)
        return winner

    def rollback(self, prompt_name: str, version: int) -> PromptTemplate | None:
        """Emergency rollback to a specific version."""
        return self.set_default(prompt_name, version)
