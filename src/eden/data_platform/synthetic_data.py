"""Synthetic Data Generation Engine — augment Gold datasets with synthetic variants.

Transforms curated Gold data points into:
- Paraphrased inputs (language variation, rephrasing)
- Composed scenarios (multi-step, multi-agent, hybrid environments)
- Adversarial mutations (reward hacking injections, edge cases, stress tests)
- Curriculum variants (difficulty ramping, scaffolding removal)

Usage:
    from eden.data_platform.synthetic_data import SyntheticDataEngine
    engine = SyntheticDataEngine()
    variants = await engine.paraphrase_inputs(datapoints, count=5)
    adversarial = await engine.generate_adversarial_mutations(datapoints, severity="medium")
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class SyntheticVariant:
    """A synthetic data variant generated from a source data point."""

    variant_id: str
    source_datapoint_id: str
    variant_type: str  # paraphrase | composition | adversarial | curriculum
    input: str
    expected_output: str
    mutation_description: str
    difficulty_delta: int  # -3 to +3 relative to source
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())


class SyntheticDataEngine:
    """Engine for generating synthetic data variants from curated Gold datasets.

    Provides four augmentation strategies:
    1. Paraphrasing — rephrase prompts while preserving intent
    2. Composition — combine multiple scenarios into hybrid tasks
    3. Adversarial mutation — inject edge cases, ambiguities, exploits
    4. Curriculum generation — progressively remove scaffolding, increase difficulty
    """

    # ── Templates for paraphrasing ───────────────────────────────────────

    PARAPHRASE_TEMPLATES: list[str] = [
        "Create a {framework} environment for: {input}",
        "Build a {environment_class} system using {framework} that handles: {input}",
        "Implement a {framework} solution for the following scenario: {input}",
        "Design a {environment_class} environment in {framework}: {input}",
        "Develop a {framework}-based system that: {input}",
        "Construct a {environment_class} benchmark using {framework} for: {input}",
        "Set up a {framework} test environment for: {input}",
    ]

    # ── Adversarial injection patterns ───────────────────────────────────

    ADVERSARIAL_INJECTIONS: list[dict[str, Any]] = [
        {
            "name": "ambiguous_spec",
            "template": "{input}\n\nNote: the specification contains intentional ambiguities. "
                        "You must infer missing constraints from context.",
            "severity": "low",
            "difficulty_delta": 1,
        },
        {
            "name": "adversarial_reward",
            "template": "{input}\n\nWARNING: design the reward function so that a naive agent "
                        "could exploit it via shortcut behaviour. Then fix the exploit.",
            "severity": "medium",
            "difficulty_delta": 2,
        },
        {
            "name": "resource_limit",
            "template": "{input}\n\nConstraint: the environment must function correctly "
                        "with at most 64KB state memory and 100ms per step.",
            "severity": "medium",
            "difficulty_delta": 2,
        },
        {
            "name": "partial_observability",
            "template": "{input}\n\nThe agent only receives partial observations. "
                        "Critical state variables are hidden and must be inferred.",
            "severity": "high",
            "difficulty_delta": 3,
        },
        {
            "name": "multi_agent_interference",
            "template": "{input}\n\nMultiple agents operate simultaneously. "
                        "Their actions may interfere — design coordination mechanisms.",
            "severity": "high",
            "difficulty_delta": 3,
        },
        {
            "name": "distribution_shift",
            "template": "{input}\n\nTrain on the standard distribution, but evaluate on "
                        "a shifted distribution with 30% of state transitions altered.",
            "severity": "high",
            "difficulty_delta": 2,
        },
        {
            "name": "sparse_feedback",
            "template": "{input}\n\nFeedback is provided only every 100 steps. "
                        "The agent must learn from delayed, sparse rewards.",
            "severity": "medium",
            "difficulty_delta": 2,
        },
        {
            "name": "adversarial_teacher",
            "template": "{input}\n\nAn adversarial teacher provides misleading hints 20% of the time. "
                        "The agent must detect and ignore corrupted guidance.",
            "severity": "high",
            "difficulty_delta": 3,
        },
    ]

    # ── Curriculum scaffolding removal ─────────────────────────────────

    CURRICULUM_STAGES: list[dict[str, Any]] = [
        {
            "stage": 0,
            "description": "Full scaffolding — explicit step-by-step hints provided",
            "scaffolding_level": 1.0,
            "difficulty_delta": -2,
        },
        {
            "stage": 1,
            "description": "Reduced scaffolding — hints only for difficult sub-tasks",
            "scaffolding_level": 0.6,
            "difficulty_delta": -1,
        },
        {
            "stage": 2,
            "description": "Minimal scaffolding — high-level guidance only",
            "scaffolding_level": 0.3,
            "difficulty_delta": 0,
        },
        {
            "stage": 3,
            "description": "No scaffolding — raw task description only",
            "scaffolding_level": 0.0,
            "difficulty_delta": 1,
        },
        {
            "stage": 4,
            "description": "Negative scaffolding — distractor information included",
            "scaffolding_level": -0.2,
            "difficulty_delta": 2,
        },
    ]

    def __init__(self) -> None:
        self._llm_client: Any | None = None

    async def _get_llm(self) -> Any:
        if self._llm_client is None:
            from eden.llm.client import get_llm_client
            self._llm_client = get_llm_client()
        return self._llm_client

    # ── Paraphrasing ────────────────────────────────────────────────────

    async def paraphrase_inputs(
        self,
        datapoints: list[dict[str, Any]],
        count: int = 3,
        use_llm: bool = False,
    ) -> list[SyntheticVariant]:
        """Generate paraphrased variants of input descriptions.

        If use_llm=True, uses the LLM for high-quality paraphrasing.
        Otherwise uses rule-based template substitution (faster, deterministic).
        """
        variants: list[SyntheticVariant] = []

        for dp in datapoints:
            source_id = dp.get("datapoint_id") or dp.get("job_id") or "unknown"
            base_input = dp.get("input") or dp.get("description") or ""
            framework = dp.get("framework") or "python"
            env_class = dp.get("environment_class") or "custom"

            if not base_input:
                continue

            if use_llm:
                llm_variants = await self._llm_paraphrase(
                    base_input, framework, env_class, count
                )
                for i, para in enumerate(llm_variants):
                    variant_id = self._hash_variant(source_id, "paraphrase", i, para)
                    variants.append(SyntheticVariant(
                        variant_id=variant_id,
                        source_datapoint_id=source_id,
                        variant_type="paraphrase",
                        input=para,
                        expected_output=dp.get("output") or "",
                        mutation_description=f"LLM paraphrase variant {i+1}",
                        difficulty_delta=0,
                        tags=["paraphrase", "llm-generated"],
                    ))
            else:
                # Rule-based: use templates + simple substitutions
                templates = random.sample(self.PARAPHRASE_TEMPLATES, min(count, len(self.PARAPHRASE_TEMPLATES)))
                for i, template in enumerate(templates):
                    para = template.format(input=base_input, framework=framework, environment_class=env_class)
                    variant_id = self._hash_variant(source_id, "paraphrase", i, para)
                    variants.append(SyntheticVariant(
                        variant_id=variant_id,
                        source_datapoint_id=source_id,
                        variant_type="paraphrase",
                        input=para,
                        expected_output=dp.get("output") or "",
                        mutation_description=f"Template paraphrase using pattern {i+1}",
                        difficulty_delta=0,
                        tags=["paraphrase", "template-based"],
                    ))

        logger.info(f"Generated {len(variants)} paraphrased variants")
        return variants

    async def _llm_paraphrase(
        self,
        text: str,
        framework: str,
        env_class: str,
        count: int,
    ) -> list[str]:
        """Use LLM to generate paraphrases."""
        try:
            llm = await self._get_llm()
            prompt = (
                f"Generate {count} different ways to phrase this request for a "
                f"{framework} {env_class} environment. Preserve all technical requirements "
                f"but vary the wording, style, and structure:\n\n{text}\n\n"
                f"Return exactly {count} paraphrases, one per line, prefixed with '- '."
            )
        try:
            from eden.llm.internal_router import route_async

            response = await route_async(
                "synthetic_paraphrase",
                prompt,
                slot="fast",
                max_tokens=2000,
                output_type="text",
                requires_quality_check=False,
                description="Paraphrase synthetic training datapoints",
            )
            raw = getattr(response, "content", "") or ""
            # Extract lines prefixed with '- '
            lines = [line[2:].strip() for line in raw.split("\n") if line.strip().startswith("- ")]
            return lines[:count] if lines else [text]
        except Exception as e:
            logger.warning(f"LLM paraphrasing failed: {e}, falling back to template")
            return [text]

    # ── Composition ───────────────────────────────────────────────────────

    async def compose_scenarios(
        self,
        datapoints: list[dict[str, Any]],
        group_size: int = 2,
        count: int = 5,
    ) -> list[SyntheticVariant]:
        """Compose hybrid scenarios by combining multiple datapoints.

        Randomly groups datapoints and fuses their descriptions into
        multi-part tasks that test composition of skills.
        """
        if len(datapoints) < group_size:
            return []

        variants: list[SyntheticVariant] = []
        shuffled = datapoints.copy()
        random.shuffle(shuffled)

        for i in range(min(count, len(shuffled) // group_size)):
            group = shuffled[i * group_size : (i + 1) * group_size]
            source_ids = [dp.get("datapoint_id") or dp.get("job_id") or "unknown" for dp in group]
            combined_id = "_".join(source_ids)

            # Fuse inputs
            parts = []
            frameworks: set[str] = set()
            env_classes: set[str] = set()
            for dp in group:
                desc = dp.get("input") or dp.get("description") or ""
                if desc:
                    parts.append(desc)
                fw = dp.get("framework") or ""
                if fw:
                    frameworks.add(fw)
                ec = dp.get("environment_class") or ""
                if ec:
                    env_classes.add(ec)

            if len(parts) < 2:
                continue

            composed_input = self._fuse_descriptions(parts)
            composed_output = "\n\n".join(
                dp.get("output") or "" for dp in group
            )

            variant_id = self._hash_variant(combined_id, "composition", i, composed_input)
            variants.append(SyntheticVariant(
                variant_id=variant_id,
                source_datapoint_id=combined_id,
                variant_type="composition",
                input=composed_input,
                expected_output=composed_output,
                mutation_description=f"Composed {group_size} scenarios: {', '.join(frameworks)}",
                difficulty_delta=1,
                tags=["composition", "hybrid"] + list(frameworks) + list(env_classes),
            ))

        logger.info(f"Generated {len(variants)} composed scenarios")
        return variants

    def _fuse_descriptions(self, parts: list[str]) -> str:
        """Fuse multiple descriptions into a coherent composed task."""
        if len(parts) == 2:
            return (
                f"PART A: {parts[0]}\n\n"
                f"PART B: {parts[1]}\n\n"
                f"Design a unified environment that satisfies BOTH parts simultaneously. "
                f"The solution must handle the requirements of Part A and Part B without conflict."
            )
        return (
            "\n\n".join(f"PART {chr(65 + i)}: {p}" for i, p in enumerate(parts))
            + "\n\nDesign a unified environment that satisfies ALL parts simultaneously."
        )

    # ── Adversarial Mutations ────────────────────────────────────────────

    async def generate_adversarial_mutations(
        self,
        datapoints: list[dict[str, Any]],
        severity: str = "medium",
        count_per_point: int = 2,
    ) -> list[SyntheticVariant]:
        """Generate adversarially mutated variants.

        Injects edge cases, ambiguities, resource constraints, and
        exploit surfaces into clean data points.
        """
        severity_map = {"low": ["low", "medium"], "medium": ["low", "medium", "high"], "high": ["medium", "high", "high"]}
        allowed = severity_map.get(severity, ["medium"])

        candidates = [inj for inj in self.ADVERSARIAL_INJECTIONS if inj["severity"] in allowed]
        if not candidates:
            candidates = self.ADVERSARIAL_INJECTIONS

        variants: list[SyntheticVariant] = []

        for dp in datapoints:
            source_id = dp.get("datapoint_id") or dp.get("job_id") or "unknown"
            base_input = dp.get("input") or dp.get("description") or ""
            if not base_input:
                continue

            selected = random.sample(candidates, min(count_per_point, len(candidates)))
            for i, injection in enumerate(selected):
                mutated = injection["template"].format(input=base_input)
                variant_id = self._hash_variant(source_id, "adversarial", i, mutated)
                variants.append(SyntheticVariant(
                    variant_id=variant_id,
                    source_datapoint_id=source_id,
                    variant_type="adversarial",
                    input=mutated,
                    expected_output=dp.get("output") or "",
                    mutation_description=f"Adversarial injection: {injection['name']} ({injection['severity']})",
                    difficulty_delta=injection["difficulty_delta"],
                    tags=["adversarial", injection["name"], injection["severity"]],
                    metadata={"injection_name": injection["name"], "severity": injection["severity"]},
                ))

        logger.info(f"Generated {len(variants)} adversarial mutations")
        return variants

    # ── Curriculum Generation ────────────────────────────────────────────

    async def generate_curriculum_variants(
        self,
        datapoints: list[dict[str, Any]],
        stages: list[int] | None = None,
    ) -> list[SyntheticVariant]:
        """Generate curriculum-scaffolded variants.

        Creates multiple versions of each data point with varying levels
        of scaffolding, supporting curriculum learning approaches.
        """
        target_stages = stages or [0, 1, 2, 3, 4]
        variants: list[SyntheticVariant] = []

        for dp in datapoints:
            source_id = dp.get("datapoint_id") or dp.get("job_id") or "unknown"
            base_input = dp.get("input") or dp.get("description") or ""
            base_output = dp.get("output") or ""
            if not base_input:
                continue

            for stage_idx in target_stages:
                stage = self.CURRICULUM_STAGES[stage_idx]
                scaffolded = self._apply_scaffolding(base_input, base_output, stage)
                variant_id = self._hash_variant(source_id, "curriculum", stage_idx, scaffolded["input"])
                variants.append(SyntheticVariant(
                    variant_id=variant_id,
                    source_datapoint_id=source_id,
                    variant_type="curriculum",
                    input=scaffolded["input"],
                    expected_output=scaffolded["output"],
                    mutation_description=stage["description"],
                    difficulty_delta=stage["difficulty_delta"],
                    tags=["curriculum", f"stage-{stage_idx}"],
                    metadata={"scaffolding_level": stage["scaffolding_level"], "stage": stage_idx},
                ))

        logger.info(f"Generated {len(variants)} curriculum variants")
        return variants

    def _apply_scaffolding(
        self,
        input_text: str,
        output_text: str,
        stage: dict[str, Any],
    ) -> dict[str, str]:
        """Apply scaffolding level to a data point."""
        level = stage["scaffolding_level"]

        if level >= 0.8:
            # Full scaffolding: add step-by-step breakdown
            scaffolded = (
                f"{input_text}\n\n"
                f"[SCAFFOLDING] Follow these steps:\n"
                f"1. Parse the requirements and identify key entities\n"
                f"2. Design the state space and action space\n"
                f"3. Implement the reward function with care\n"
                f"4. Add observation and reset logic\n"
                f"5. Write comprehensive tests\n"
            )
            return {"input": scaffolded, "output": output_text}

        if level >= 0.5:
            # Partial scaffolding: high-level hints
            scaffolded = (
                f"{input_text}\n\n"
                f"[HINT] Focus on: state design, reward shaping, and edge case handling."
            )
            return {"input": scaffolded, "output": output_text}

        if level >= 0.2:
            # Minimal scaffolding
            scaffolded = (
                f"{input_text}\n\n"
                f"[HINT] Consider edge cases in your implementation."
            )
            return {"input": scaffolded, "output": output_text}

        if level == 0.0:
            # No scaffolding — raw
            return {"input": input_text, "output": output_text}

        # Negative scaffolding — distractors
        scaffolded = (
            f"{input_text}\n\n"
            f"[NOTE] The following constraints are relevant but some may be red herrings. "
            f"Use your judgment: performance > readability > conciseness."
        )
        return {"input": scaffolded, "output": output_text}

    # ── Batch Pipeline ──────────────────────────────────────────────────

    async def augment_dataset(
        self,
        datapoints: list[dict[str, Any]],
        strategies: list[str] = None,
        counts: dict[str, int] = None,
    ) -> dict[str, list[SyntheticVariant]]:
        """Run full augmentation pipeline on a dataset.

        Args:
            datapoints: Source data points from Gold layer.
            strategies: List of strategies to apply (paraphrase, composition, adversarial, curriculum).
            counts: Mapping of strategy -> count/variant count.

        Returns:
            Dict mapping strategy name to list of SyntheticVariants.
        """
        strategies = strategies or ["paraphrase", "adversarial", "curriculum"]
        counts = counts or {}
        results: dict[str, list[SyntheticVariant]] = {}

        if "paraphrase" in strategies:
            para_count = counts.get("paraphrase", 3)
            results["paraphrase"] = await self.paraphrase_inputs(datapoints, count=para_count)

        if "composition" in strategies:
            comp_count = counts.get("composition", 5)
            group_size = counts.get("composition_group_size", 2)
            results["composition"] = await self.compose_scenarios(datapoints, group_size=group_size, count=comp_count)

        if "adversarial" in strategies:
            adv_count = counts.get("adversarial", 2)
            severity = counts.get("adversarial_severity", "medium")
            results["adversarial"] = await self.generate_adversarial_mutations(datapoints, severity=severity, count_per_point=adv_count)

        if "curriculum" in strategies:
            stages = counts.get("curriculum_stages", [0, 1, 2, 3, 4])
            results["curriculum"] = await self.generate_curriculum_variants(datapoints, stages=stages)

        total = sum(len(v) for v in results.values())
        logger.info(f"Augmentation complete: {total} synthetic variants generated")
        return results

    # ── Utilities ────────────────────────────────────────────────────────

    @staticmethod
    def _hash_variant(source_id: str, variant_type: str, index: int, content: str) -> str:
        """Create a deterministic hash for a variant."""
        payload = f"{source_id}:{variant_type}:{index}:{content}"
        return f"syn_{hashlib.sha256(payload.encode()).hexdigest()[:16]}"

    def to_jsonl(self, variants: list[SyntheticVariant]) -> str:
        """Export variants as JSONL string."""
        lines = []
        for v in variants:
            lines.append(json.dumps({
                "variant_id": v.variant_id,
                "source_datapoint_id": v.source_datapoint_id,
                "variant_type": v.variant_type,
                "input": v.input,
                "expected_output": v.expected_output,
                "mutation_description": v.mutation_description,
                "difficulty_delta": v.difficulty_delta,
                "tags": v.tags,
                "metadata": v.metadata,
                "created_at": v.created_at,
            }))
        return "\n".join(lines)
