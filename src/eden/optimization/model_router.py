"""Intelligent model routing with task classification and quality validation."""

import ast
import logging
from dataclasses import dataclass
from enum import Enum

from eden.config import get_settings
from eden.llm.client import LLMResponse, OpenRouterClient

logger = logging.getLogger(__name__)


class ModelTier(Enum):
    """Model tier definitions with cost/quality tradeoffs."""

    T1 = "t1"  # Fast/cheap: classification, extraction, simple formatting
    T2 = "t2"  # Standard: code generation, test writing, reasoning
    T3 = "t3"  # Expert: complex architecture, novel patterns, adversarial design
    T4 = "t4"  # Custom/enterprise: proprietary, compliance, offline


# Tier-to-model mapping (configurable via settings)
TIER_MODELS: dict[ModelTier, list[str]] = {
    ModelTier.T1: [
        "tencent/hy3",
        "xiaomi/mimo-v2.5",
    ],
    ModelTier.T2: [
        "minimax/minimax-m3",
        "xiaomi/mimo-v2.5-pro",
        "tencent/hy3",
    ],
    # T3 = Expert tier — portal Cmd-J agent, onboarding integration agent,
    # and other high-stakes reasoning tasks.
    ModelTier.T3: [
        "x-ai/grok-4.5",
        "minimax/minimax-m3",
        "xiaomi/mimo-v2.5-pro",
    ],
    ModelTier.T4: [
        "custom/fine-tuned",
    ],
}


@dataclass
class PipelineTask:
    """Description of a pipeline task for classification."""

    agent: str
    description: str
    slot: str = "reasoning"
    output_type: str = "text"  # text | code | json
    requires_novelty: bool = False
    expected_min_length: int = 50
    required_format: str | None = None
    requires_quality_check: bool = True
    system_prompt: str | None = None
    org_id: str | None = None
    job_id: str | None = None
    user_id: str | None = None


@dataclass
class ClassificationResult:
    """Result of task classification."""

    tier: ModelTier
    complexity: float = 0.0  # 0.0-1.0
    novelty: float = 0.0
    reasoning_depth: float = 0.0
    domain_expertise: float = 0.0
    confidence: float = 0.0
    heuristic_used: bool = False


@dataclass
class ValidationResult:
    """Result of quality validation."""

    passed: bool
    reason: str = ""
    quality_score: float | None = None
    tier_used: ModelTier | None = None


class TaskClassifier:
    """Classifies pipeline tasks to determine the optimal model tier.

    Uses a fast heuristic path for common cases, falling back to a lightweight
    LLM call only for ambiguous cases.
    """

    # Agents that are always simple / extraction-oriented
    SIMPLE_AGENTS: set[str] = {"format", "extract", "classify", "summarize"}

    # Agents that are always complex / reasoning-heavy
    COMPLEX_AGENTS: set[str] = {
        "planner",
        "critic",
        "archivist",
        "adversarial_tester",
    }

    # Code agents that may vary in complexity
    CODE_AGENTS: set[str] = {"executor", "refiner", "verifier", "tester", "code_quality"}

    def __init__(self, llm_client: OpenRouterClient | None = None):
        self.llm_client = llm_client
        self._heuristic_hits = 0
        self._llm_classifications = 0

    async def classify(self, task: PipelineTask) -> ClassificationResult:
        """Classify a task and return the optimal model tier."""
        # ── Fast heuristic path (no LLM call) ─────────────────────────────
        heuristic_tier = self._heuristic_classify(task)
        if heuristic_tier is not None:
            self._heuristic_hits += 1
            return ClassificationResult(
                tier=heuristic_tier,
                complexity=0.3 if heuristic_tier == ModelTier.T1 else 0.6,
                novelty=0.2,
                reasoning_depth=0.3 if heuristic_tier == ModelTier.T1 else 0.7,
                domain_expertise=0.2,
                confidence=0.85,
                heuristic_used=True,
            )

        # ── LLM-based classification for ambiguous cases ──────────────────
        return await self._llm_classify(task)

    def _heuristic_classify(self, task: PipelineTask) -> ModelTier | None:
        """Fast heuristic classification without any LLM call."""
        agent = task.agent.lower()
        slot = task.slot.lower()

        # Slot-based shortcuts
        if slot in ("fast", "extraction"):
            return ModelTier.T1
        if slot == "reasoning" and agent in self.SIMPLE_AGENTS:
            return ModelTier.T1

        # Agent-based shortcuts
        if agent in self.SIMPLE_AGENTS:
            return ModelTier.T1
        if agent in self.COMPLEX_AGENTS:
            return ModelTier.T3 if task.requires_novelty else ModelTier.T2
        if agent in self.CODE_AGENTS:
            # Short code generation = T1, long/complex = T2
            if len(task.description) < 200 and not task.requires_novelty:
                return ModelTier.T1
            return ModelTier.T2

        # Output-type shortcuts
        if task.output_type == "code" and len(task.description) < 150:
            return ModelTier.T1
        if task.output_type in ("json", "format"):
            return ModelTier.T1

        # Default: ambiguous — needs LLM
        return None

    async def _llm_classify(self, task: PipelineTask) -> ClassificationResult:
        """Use a lightweight LLM to classify ambiguous tasks."""
        self._llm_classifications += 1

        prompt = (
            "Analyze this AI pipeline task and classify it on 4 dimensions.\n\n"
            f"Agent: {task.agent}\n"
            f"Slot: {task.slot}\n"
            f"Description: {task.description[:500]}\n"
            f"Output type: {task.output_type}\n"
            f"Requires novelty: {task.requires_novelty}\n\n"
            "Respond with ONLY a JSON object:\n"
            '{"complexity": 0.0-1.0, "novelty": 0.0-1.0, '
            '"reasoning_depth": 0.0-1.0, "domain_expertise": 0.0-1.0}'
        )

        try:
            if self.llm_client is None:
                # No LLM available — default to T2
                return ClassificationResult(
                    tier=ModelTier.T2,
                    complexity=0.5,
                    novelty=0.3,
                    reasoning_depth=0.5,
                    domain_expertise=0.3,
                    confidence=0.5,
                    heuristic_used=False,
                )

            response = self.llm_client.call(
                agent="task_classifier",
                prompt=prompt,
                slot="fast",
                max_tokens=256,
            )
            import json

            scores = json.loads(response.content.strip())
            complexity = float(scores.get("complexity", 0.5))
            novelty = float(scores.get("novelty", 0.3))

            if complexity < 0.4 and novelty < 0.3:
                tier = ModelTier.T1
            elif complexity < 0.7:
                tier = ModelTier.T2
            elif complexity < 0.9:
                tier = ModelTier.T3
            else:
                tier = ModelTier.T4

            return ClassificationResult(
                tier=tier,
                complexity=complexity,
                novelty=novelty,
                reasoning_depth=float(scores.get("reasoning_depth", 0.5)),
                domain_expertise=float(scores.get("domain_expertise", 0.3)),
                confidence=0.75,
                heuristic_used=False,
            )
        except Exception as e:
            logger.warning(f"LLM classification failed: {e}; defaulting to T2")
            return ClassificationResult(
                tier=ModelTier.T2,
                complexity=0.5,
                novelty=0.3,
                reasoning_depth=0.5,
                domain_expertise=0.3,
                confidence=0.3,
                heuristic_used=False,
            )

    def get_stats(self) -> dict:
        """Return classification statistics."""
        total = self._heuristic_hits + self._llm_classifications
        return {
            "heuristic_hits": self._heuristic_hits,
            "llm_classifications": self._llm_classifications,
            "heuristic_rate": round(self._heuristic_hits / total, 4) if total else 0.0,
        }


class QualityValidator:
    """Validates LLM responses for quality before acceptance.

    Checks: parseability (code), completeness, format compliance, semantic quality.
    """

    def __init__(self, llm_client: OpenRouterClient | None = None):
        self.llm_client = llm_client

    def validate_sync(
        self,
        response: LLMResponse,
        task: PipelineTask,
        tier: ModelTier | None = None,
    ) -> ValidationResult:
        """Synchronous validation (no LLM judge). Used by sync ``route()``."""
        content = response.content

        if task.output_type == "code":
            try:
                ast.parse(content)
            except SyntaxError as e:
                return ValidationResult(
                    passed=False,
                    reason=f"syntax_error: {e.msg}",
                    tier_used=tier,
                )

        if len(content) < task.expected_min_length:
            return ValidationResult(
                passed=False,
                reason="incomplete",
                tier_used=tier,
            )

        if task.required_format:
            fmt_ok = self._check_format(content, task.required_format)
            if not fmt_ok:
                return ValidationResult(
                    passed=False,
                    reason="format_mismatch",
                    tier_used=tier,
                )

        return ValidationResult(passed=True, tier_used=tier)

    async def validate(
        self,
        response: LLMResponse,
        task: PipelineTask,
        tier: ModelTier | None = None,
    ) -> ValidationResult:
        """Async validation with full quality check (may call LLM judge)."""
        content = response.content

        # Check 1: Parseability (for code)
        if task.output_type == "code":
            try:
                ast.parse(content)
            except SyntaxError as e:
                return ValidationResult(
                    passed=False,
                    reason=f"syntax_error: {e.msg}",
                    tier_used=tier,
                )

        # Check 2: Completeness heuristic
        if len(content) < task.expected_min_length:
            return ValidationResult(
                passed=False,
                reason="incomplete",
                tier_used=tier,
            )

        # Check 3: Style/format compliance
        if task.required_format:
            fmt_ok = self._check_format(content, task.required_format)
            if not fmt_ok:
                return ValidationResult(
                    passed=False,
                    reason="format_mismatch",
                    tier_used=tier,
                )

        # Check 4: Semantic quality (lightweight LLM judge) — skip for very short outputs
        if task.requires_quality_check and len(content) > 100:
            quality_score = await self._judge_quality(content, task)
            if quality_score is not None and quality_score < 0.7:
                return ValidationResult(
                    passed=False,
                    reason=f"quality_score_{quality_score:.2f}",
                    quality_score=quality_score,
                    tier_used=tier,
                )
            return ValidationResult(
                passed=True,
                quality_score=quality_score,
                tier_used=tier,
            )

        return ValidationResult(passed=True, tier_used=tier)

    def _check_format(self, content: str, required_format: str) -> bool:
        """Check if content matches required format."""
        rf = required_format.lower()
        if rf == "json":
            import json

            try:
                json.loads(content)
                return True
            except json.JSONDecodeError:
                return False
        if rf == "python":
            try:
                ast.parse(content)
                return True
            except SyntaxError:
                return False
        if rf == "markdown":
            # Very lenient — just check for markdown-like structure
            return "#" in content or "```" in content
        return True

    async def _judge_quality(self, content: str, task: PipelineTask) -> float | None:
        """Use a lightweight LLM to score output quality."""
        if self.llm_client is None:
            return None

        judge_prompt = (
            "Rate the quality of this AI-generated output on a scale of 0.0 to 1.0.\n\n"
            f"Task: {task.description[:300]}\n\n"
            f"Output:\n{content[:800]}\n\n"
            "Respond with ONLY a number between 0.0 and 1.0."
        )
        try:
            resp = self.llm_client.call(
                agent="quality_judge",
                prompt=judge_prompt,
                slot="fast",
                max_tokens=10,
            )
            score = float(resp.content.strip().split()[0])
            return max(0.0, min(1.0, score))
        except Exception:
            return None


class ModelRouter:
    """Routes LLM requests through T1→T2→T3 tiers with caching and validation.

    Wraps OpenRouterClient to provide intelligent model selection,
    quality validation, fallback chains, and cost tracking.
    """

    def __init__(
        self,
        llm_client: OpenRouterClient | None = None,
        classifier: TaskClassifier | None = None,
        validator: QualityValidator | None = None,
    ):
        self.settings = get_settings()
        self.llm_client = llm_client or OpenRouterClient()
        self.classifier = classifier or TaskClassifier(llm_client=self.llm_client)
        self.validator = validator or QualityValidator(llm_client=self.llm_client)

        # Statistics
        self._calls_by_tier: dict[ModelTier, int] = {
            ModelTier.T1: 0,
            ModelTier.T2: 0,
            ModelTier.T3: 0,
            ModelTier.T4: 0,
        }
        self._fallbacks = 0
        self._validation_failures = 0
        self._tokens_saved = 0

    def route(
        self,
        task: PipelineTask,
        prompt: str,
        system_prompt: str | None = None,
        **kwargs,
    ) -> LLMResponse:
        """Route an LLM request through the tiered fallback chain (synchronous).

        1. Classify the task (heuristic only — no LLM call in sync path)
        2. Try the assigned tier
        3. Validate the response
        4. If validation fails, escalate to next tier (up to T3)
        5. Return the best response

        For async usage, call ``aroute()`` instead.
        """
        # Use heuristic classification in sync path to avoid blocking
        classification = self.classifier._heuristic_classify(task)
        if classification is None:
            start_tier = ModelTier.T2  # Default for sync path
        else:
            start_tier = classification

        tiers_to_try = self._get_fallback_chain(start_tier)
        last_error: str | None = None

        for tier in tiers_to_try:
            self._calls_by_tier[tier] += 1
            models = self._get_models_for_tier(tier)

            for model in models:
                try:
                    # Override the model slot to use our chosen model
                    response = self.llm_client.call(
                        agent=task.agent,
                        prompt=prompt,
                        slot="reasoning",
                        system_prompt=system_prompt,
                        model=model,
                        **kwargs,
                    )

                    # Validate (lightweight — no LLM judge in sync path)
                    validation = self.validator.validate_sync(response, task, tier)
                    if validation.passed:
                        # Success! Log savings if we used a cheaper tier than start
                        if _TIER_ORDER[tier] < _TIER_ORDER[start_tier]:
                            self._tokens_saved += response.usage.total_tokens
                        return response

                    # Validation failed — record and try next model/tier
                    self._validation_failures += 1
                    last_error = validation.reason
                    logger.info(
                        f"Validation failed for {task.agent} at {tier.value}: {validation.reason}"
                    )

                except Exception as e:
                    last_error = str(e)
                    logger.warning(f"Model {model} failed for {task.agent}: {e}")
                    continue

            # If we get here, all models in this tier failed validation
            self._fallbacks += 1
            logger.info(f"Falling back from {tier.value} for {task.agent}")

        # All tiers exhausted — raise
        logger.warning(
            f"All tiers exhausted for {task.agent}; returning last response. Error: {last_error}"
        )
        raise MaxRetriesExceededError(
            f"All model tiers failed for {task.agent}: {last_error}"
        )

    async def aroute(
        self,
        task: PipelineTask,
        prompt: str,
        system_prompt: str | None = None,
        org_id: str | None = None,
        user_id: str | None = None,
        **kwargs,
    ) -> LLMResponse:
        """Async route with full classification and validation.

        Uses ``run_in_executor`` for the sync LLM call while keeping
        async classification and validation.
        """
        import asyncio

        classification = await self.classifier.classify(task)
        start_tier = classification.tier
        tiers_to_try = self._get_fallback_chain(start_tier)
        last_error: str | None = None

        for tier in tiers_to_try:
            self._calls_by_tier[tier] += 1
            models = self._get_models_for_tier(tier)

            for model in models:
                try:
                    loop = asyncio.get_event_loop()
                    response = await loop.run_in_executor(
                        None,
                        # S-21: ``m=model`` default-arg binds
                        # ``model`` at lambda-creation time so the
                        # late-binding-for-loop bug never recurs.
                        lambda m=model: self.llm_client.call(
                            agent=task.agent,
                            prompt=prompt,
                            slot="reasoning",
                            system_prompt=system_prompt,
                            model=m,
                            **kwargs,
                        ),
                    )

                    validation = await self.validator.validate(response, task, tier)
                    if validation.passed:
                        if _TIER_ORDER[tier] < _TIER_ORDER[start_tier]:
                            self._tokens_saved += response.usage.total_tokens
                        return response

                    self._validation_failures += 1
                    last_error = validation.reason
                    logger.info(
                        f"Validation failed for {task.agent} at {tier.value}: {validation.reason}"
                    )

                except Exception as e:
                    last_error = str(e)
                    logger.warning(f"Model {model} failed for {task.agent}: {e}")
                    continue

            self._fallbacks += 1
            logger.info(f"Falling back from {tier.value} for {task.agent}")

        logger.warning(
            f"All tiers exhausted for {task.agent}. Error: {last_error}"
        )
        raise MaxRetriesExceededError(
            f"All model tiers failed for {task.agent}: {last_error}"
        )

    def _get_fallback_chain(self, start: ModelTier) -> list[ModelTier]:
        """Return the chain of tiers to try, starting from the classified tier."""
        order = [ModelTier.T1, ModelTier.T2, ModelTier.T3, ModelTier.T4]
        start_idx = order.index(start)
        return order[start_idx:]

    def _get_models_for_tier(self, tier: ModelTier) -> list[str]:
        """Return the fallback chain for a tier.

        Single source of truth: :data:`TIER_MODELS`. The chains
        are tried in order — primary first, then each fallback —
        so a primary-model outage or validation failure still
        returns a usable response.
        """
        return list(TIER_MODELS.get(tier, TIER_MODELS[ModelTier.T2]))

    def get_stats(self) -> dict:
        """Return routing statistics."""
        total_calls = sum(self._calls_by_tier.values())
        return {
            "calls_by_tier": {t.value: c for t, c in self._calls_by_tier.items()},
            "total_calls": total_calls,
            "fallbacks": self._fallbacks,
            "validation_failures": self._validation_failures,
            "tokens_saved": self._tokens_saved,
            "fallback_rate": round(self._fallbacks / total_calls, 4) if total_calls else 0.0,
            "classifier_stats": self.classifier.get_stats(),
        }


_TIER_ORDER: dict[ModelTier, int] = {
    ModelTier.T1: 1,
    ModelTier.T2: 2,
    ModelTier.T3: 3,
    ModelTier.T4: 4,
}


class MaxRetriesExceededError(Exception):
    """Raised when all model tiers fail."""
    pass
