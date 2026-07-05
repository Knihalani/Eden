"""Agent memory architectures — Working, Episodic, Semantic tiers.

Ref: eden-multi-agent-orchestration-architecture.md §6
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

# ──────────────────────────────────────────────────────────────────────────
# Enums and data structures
# ──────────────────────────────────────────────────────────────────────────

class MemoryTier(StrEnum):
    WORKING = "working"
    EPISODIC = "episodic"
    SEMANTIC = "semantic"


@dataclass
class Observation:
    """A single observation from the environment."""

    content: str
    source: str = "environment"  # agent_id or "environment"
    timestamp: float = field(default_factory=time.time)
    salience: float = 0.5  # 0–1 importance score
    step_number: int = 0
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "content": self.content,
            "source": self.source,
            "timestamp": self.timestamp,
            "salience": self.salience,
            "step_number": self.step_number,
            "tags": self.tags,
        }


@dataclass
class Episode:
    """A complete episode for episodic memory."""

    episode_id: str
    environment_id: str
    agent_id: str
    trajectory: list[dict[str, Any]] = field(default_factory=list)
    success: bool = False
    total_reward: float = 0.0
    completed_at: float = field(default_factory=time.time)
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "episode_id": self.episode_id,
            "environment_id": self.environment_id,
            "agent_id": self.agent_id,
            "success": self.success,
            "total_reward": self.total_reward,
            "completed_at": self.completed_at,
            "summary": self.summary,
            "step_count": len(self.trajectory),
        }


@dataclass
class Fact:
    """A semantic memory fact."""

    subject: str
    relation: str
    object: str
    confidence: float = 1.0
    source: str = ""
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "subject": self.subject,
            "relation": self.relation,
            "object": self.object,
            "confidence": self.confidence,
            "source": self.source,
            "timestamp": self.timestamp,
        }


# ──────────────────────────────────────────────────────────────────────────
# Working Memory
# ──────────────────────────────────────────────────────────────────────────

class WorkingMemory:
    """Immediate context — what the agent is currently thinking about."""

    def __init__(self, max_observations: int = 20):
        self.current_goal: str = ""
        self.current_plan: list[dict[str, Any]] = []
        self.recent_observations: deque[Observation] = deque(maxlen=max_observations)
        self.active_tools: list[str] = []
        self._max_tokens = 2000

    def set_goal(self, goal: str) -> None:
        self.current_goal = goal

    def set_plan(self, plan: list[dict[str, Any]]) -> None:
        self.current_plan = plan

    def add_observation(self, observation: Observation) -> None:
        self.recent_observations.append(observation)

    def add_tool(self, tool_name: str) -> None:
        if tool_name not in self.active_tools:
            self.active_tools.append(tool_name)

    def remove_tool(self, tool_name: str) -> None:
        if tool_name in self.active_tools:
            self.active_tools.remove(tool_name)

    def summarize(self, max_tokens: int | None = None) -> str:
        """Compress working memory for LLM context window."""
        max_t = max_tokens or self._max_tokens
        parts: list[str] = []
        if self.current_goal:
            parts.append(f"Goal: {self.current_goal}")
        if self.current_plan:
            steps = [p.get("description", str(p)) for p in self.current_plan]
            parts.append(f"Plan: {' → '.join(steps)}")
        if self.active_tools:
            parts.append(f"Tools: {', '.join(self.active_tools)}")
        if self.recent_observations:
            recent = list(self.recent_observations)[-10:]  # Last 10
            obs_strs = [f"[{o.step_number}] {o.content[:80]}" for o in recent]
            parts.append("Observations:\n" + "\n".join(obs_strs))
        summary = "\n".join(parts)
        # Simple truncation
        if len(summary) > max_t * 4:  # Rough char estimate
            summary = summary[:max_t * 4] + "..."
        return summary

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_goal": self.current_goal,
            "current_plan": self.current_plan,
            "recent_observations": [o.to_dict() for o in self.recent_observations],
            "active_tools": self.active_tools,
        }


# ──────────────────────────────────────────────────────────────────────────
# Episodic Memory
# ──────────────────────────────────────────────────────────────────────────

class EpisodicMemory:
    """Chronological log of past experiences — what happened when."""

    def __init__(self, max_episodes: int = 1000):
        self._episodes: deque[Episode] = deque(maxlen=max_episodes)
        self._total_recorded = 0
        self._vector_store: Any | None = None

    def record_episode(self, episode: Episode) -> None:
        self._episodes.append(episode)
        self._total_recorded += 1

    def record_observation(self, agent_id: str, observation: Observation) -> None:
        """Record a single observation as a mini-episode for quick recall."""
        mini = Episode(
            episode_id=f"obs_{agent_id}_{int(time.time() * 1000)}",
            environment_id="",
            agent_id=agent_id,
            trajectory=[observation.to_dict()],
            summary=observation.content,
        )
        self._episodes.append(mini)
        self._total_recorded += 1

    def recall_similar(self, query: str, k: int = 5) -> list[Episode]:
        """Retrieve past episodes similar to current situation."""
        if not self._episodes:
            return []
        # Stub: return k most recent. In production, vector search.
        return list(self._episodes)[-k:]

    def recall_by_success(self, success: bool, k: int = 5) -> list[Episode]:
        """Retrieve episodes filtered by success/failure."""
        matches = [e for e in self._episodes if e.success == success]
        return matches[-k:]

    def get_episodes_for_agent(self, agent_id: str, k: int = 20) -> list[Episode]:
        matches = [e for e in self._episodes if e.agent_id == agent_id]
        return matches[-k:]

    def stats(self) -> dict[str, Any]:
        return {
            "total_recorded": self._total_recorded,
            "current_count": len(self._episodes),
            "success_count": sum(1 for e in self._episodes if e.success),
            "failure_count": sum(1 for e in self._episodes if not e.success),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "stats": self.stats(),
            "recent_episodes": [e.to_dict() for e in list(self._episodes)[-10:]],
        }


# ──────────────────────────────────────────────────────────────────────────
# Semantic Memory
# ──────────────────────────────────────────────────────────────────────────

class SemanticMemory:
    """Long-term factual knowledge — concepts, relationships, best practices."""

    def __init__(self):
        self._facts: list[Fact] = []
        self._total_facts = 0
        self._knowledge_graph: Any | None = None

    def learn_fact(
        self,
        subject: str,
        relation: str,
        obj: str,
        confidence: float = 1.0,
        source: str = "",
    ) -> Fact:
        fact = Fact(
            subject=subject,
            relation=relation,
            object=obj,
            confidence=confidence,
            source=source,
        )
        self._facts.append(fact)
        self._total_facts += 1
        return fact

    def query_knowledge(self, query: str, k: int = 10) -> list[Fact]:
        """Query the knowledge base for relevant facts."""
        if not self._facts:
            return []
        # Stub: simple keyword matching
        query_lower = query.lower()
        matches = [
            f for f in self._facts
            if query_lower in f.subject.lower()
            or query_lower in f.relation.lower()
            or query_lower in f.object.lower()
        ]
        return sorted(matches, key=lambda f: f.confidence, reverse=True)[:k]

    def get_relations(self, subject: str) -> list[Fact]:
        return [f for f in self._facts if f.subject.lower() == subject.lower()]

    def get_facts_by_relation(self, relation: str) -> list[Fact]:
        return [f for f in self._facts if f.relation.lower() == relation.lower()]

    def stats(self) -> dict[str, Any]:
        return {
            "total_facts": self._total_facts,
            "current_count": len(self._facts),
            "unique_subjects": len({f.subject for f in self._facts}),
            "unique_relations": len({f.relation for f in self._facts}),
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "stats": self.stats(),
            "recent_facts": [f.to_dict() for f in self._facts[-20:]],
        }


# ──────────────────────────────────────────────────────────────────────────
# Memory Service (unified interface)
# ──────────────────────────────────────────────────────────────────────────

class MemoryService:
    """Provides all three memory tiers to agents."""

    def __init__(self, vector_store: Any | None = None, knowledge_graph: Any | None = None):
        self.working_memories: dict[str, WorkingMemory] = {}
        self.episodic_memory = EpisodicMemory()
        self.semantic_memory = SemanticMemory()
        self._vector_store = vector_store
        self._knowledge_graph = knowledge_graph

    def get_working_memory(self, agent_id: str) -> WorkingMemory:
        if agent_id not in self.working_memories:
            self.working_memories[agent_id] = WorkingMemory()
        return self.working_memories[agent_id]

    async def consolidate_memories(self, agent_id: str, salience_threshold: float = 0.8) -> dict[str, Any]:
        """Move important working memory observations → episodic memory."""
        wm = self.working_memories.get(agent_id)
        if not wm:
            return {"consolidated": 0, "reason": "No working memory found"}

        count = 0
        for obs in list(wm.recent_observations):
            if obs.salience >= salience_threshold:
                self.episodic_memory.record_observation(agent_id, obs)
                count += 1

        # Also learn semantic facts from important observations
        for obs in list(wm.recent_observations):
            if obs.salience >= salience_threshold and obs.step_number % 10 == 0:
                # Extract simple semantic fact: observation source → observed → content
                self.semantic_memory.learn_fact(
                    subject=obs.source or agent_id,
                    relation="observed",
                    obj=obs.content[:200],
                    confidence=obs.salience,
                    source=f"step_{obs.step_number}",
                )

        return {"consolidated": count, "agent_id": agent_id}

    def query_all_memories(self, agent_id: str, query: str, k: int = 5) -> dict[str, Any]:
        """Query all memory tiers for a unified result."""
        wm = self.working_memories.get(agent_id)
        working = wm.summarize() if wm else ""
        episodes = self.episodic_memory.recall_similar(query, k=k)
        facts = self.semantic_memory.query_knowledge(query, k=k)
        return {
            "working_memory_summary": working,
            "episodes": [e.to_dict() for e in episodes],
            "facts": [f.to_dict() for f in facts],
            "agent_id": agent_id,
        }

    def stats(self) -> dict[str, Any]:
        return {
            "working_memory_count": len(self.working_memories),
            "episodic": self.episodic_memory.stats(),
            "semantic": self.semantic_memory.stats(),
        }
