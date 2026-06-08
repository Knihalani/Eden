"""Multi-agent communication abstractions.

Three patterns selectable per environment:
  • Message Passing (event-driven)
  • Shared State (graph-based)
  • Blackboard (specialist-shared knowledge layer)

Ref: eden-multi-agent-orchestration-architecture.md §2
"""

from __future__ import annotations

import asyncio
import copy
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine, Optional


# ──────────────────────────────────────────────────────────────────────────
# Core data structures
# ──────────────────────────────────────────────────────────────────────────

class MessageType(str, Enum):
    REQUEST = "request"
    RESPONSE = "response"
    BROADCAST = "broadcast"
    HEARTBEAT = "heartbeat"
    DIRECTIVE = "directive"


@dataclass
class Message:
    """A message exchanged between agents."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    from_agent: str = ""
    to_agent: str = ""
    type: MessageType = MessageType.REQUEST
    content: dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)
    ttl: float = 30.0

    def is_expired(self) -> bool:
        return time.time() - self.timestamp > self.ttl

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "from_agent": self.from_agent,
            "to_agent": self.to_agent,
            "type": self.type.value,
            "content": self.content,
            "timestamp": self.timestamp,
            "ttl": self.ttl,
        }


@dataclass
class SharedState:
    """Immutable shared state for graph-based environments."""

    world: dict[str, Any] = field(default_factory=dict)
    entities: list[dict[str, Any]] = field(default_factory=list)
    agent_observations: dict[str, dict[str, Any]] = field(default_factory=dict)
    message_history: list[Message] = field(default_factory=list)
    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)
    step_count: int = 0
    cumulative_rewards: dict[str, float] = field(default_factory=dict)

    def update(
        self,
        agent_id: str,
        action: dict[str, Any],
        reward: float = 0.0,
    ) -> SharedState:
        """Return a new SharedState with the action applied."""
        new_state = copy.deepcopy(self)
        new_state.step_count += 1
        new_state.cumulative_rewards.setdefault(agent_id, 0.0)
        new_state.cumulative_rewards[agent_id] += reward
        return new_state

    def to_observable(self, agent_id: str) -> dict[str, Any]:
        """What a single agent can observe (filtered view)."""
        return {
            "world": self.world,
            "entities": self.entities,
            "my_observation": self.agent_observations.get(agent_id, {}),
            "step_count": self.step_count,
            "my_reward": self.cumulative_rewards.get(agent_id, 0.0),
        }


@dataclass
class BlackboardEntry:
    """A single entry on the blackboard."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str = ""
    content: dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.0
    timestamp: float = field(default_factory=time.time)
    category: str = "observation"  # plan | observation | subgoal | hypothesis

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "agent_id": self.agent_id,
            "content": self.content,
            "confidence": self.confidence,
            "timestamp": self.timestamp,
            "category": self.category,
        }


# ──────────────────────────────────────────────────────────────────────────
# MessageBus
# ──────────────────────────────────────────────────────────────────────────

class MessageBus:
    """In-memory message bus with optional Redis backing stub."""

    def __init__(self, redis_client: Any | None = None):
        self._queues: dict[str, deque[Message]] = defaultdict(deque)
        self._subscribers: dict[str, list[Callable[[Message], Coroutine[Any, Any, None]]]] = defaultdict(list)
        self._redis = redis_client
        self._total_delivered = 0
        self._total_dropped = 0

    def subscribe(
        self,
        agent_id: str,
        handler: Callable[[Message], Coroutine[Any, Any, None]],
    ) -> None:
        self._subscribers[agent_id].append(handler)

    def unsubscribe(self, agent_id: str, handler: Callable[[Message], Coroutine[Any, Any, None]]) -> None:
        if agent_id in self._subscribers:
            self._subscribers[agent_id] = [h for h in self._subscribers[agent_id] if h != handler]

    def publish(self, agent_id: str, message: Message) -> None:
        self._queues[agent_id].append(message)
        # Notify async subscribers
        for handler in self._subscribers.get(agent_id, []):
            asyncio.create_task(handler(message))

    def get_messages(self, agent_id: str, since_id: str | None = None, max_messages: int = 100) -> list[Message]:
        q = self._queues.get(agent_id, deque())
        messages = [m for m in q if not m.is_expired()]
        if since_id:
            found = False
            result = []
            for m in messages:
                if found:
                    result.append(m)
                if m.id == since_id:
                    found = True
            messages = result
        self._total_delivered += len(messages)
        return messages[-max_messages:]

    def broadcast(
        self,
        from_id: str,
        content: dict[str, Any],
        exclude: list[str] | None = None,
    ) -> list[str]:
        exclude = exclude or []
        recipients = [aid for aid in self._subscribers if aid != from_id and aid not in exclude]
        for recipient in recipients:
            msg = Message(
                from_agent=from_id,
                to_agent=recipient,
                type=MessageType.BROADCAST,
                content=content,
            )
            self.publish(recipient, msg)
        return recipients

    def clear(self, agent_id: str | None = None) -> None:
        if agent_id:
            self._queues[agent_id].clear()
        else:
            self._queues.clear()

    def stats(self) -> dict[str, Any]:
        return {
            "total_delivered": self._total_delivered,
            "total_dropped": self._total_dropped,
            "subscriber_count": len(self._subscribers),
            "queue_sizes": {aid: len(q) for aid, q in self._queues.items()},
        }


# ──────────────────────────────────────────────────────────────────────────
# SharedStateManager
# ──────────────────────────────────────────────────────────────────────────

class SharedStateManager:
    """Manages immutable shared state with checkpointing."""

    def __init__(self, initial_state: SharedState | None = None):
        self._history: list[SharedState] = []
        self._current = initial_state or SharedState()
        self._history.append(self._current)

    @property
    def state(self) -> SharedState:
        return self._current

    def apply_action(self, agent_id: str, action: dict[str, Any], reward: float = 0.0) -> SharedState:
        self._current = self._current.update(agent_id, action, reward)
        self._history.append(self._current)
        return self._current

    def rollback(self, steps: int = 1) -> SharedState:
        if len(self._history) > steps:
            self._history = self._history[:-steps]
            self._current = self._history[-1]
        return self._current

    def checkpoint(self, step_number: int) -> SharedState | None:
        for s in reversed(self._history):
            if s.step_count == step_number:
                return s
        return None

    def get_history(self) -> list[SharedState]:
        return self._history.copy()


# ──────────────────────────────────────────────────────────────────────────
# Blackboard
# ──────────────────────────────────────────────────────────────────────────

class Blackboard:
    """Shared knowledge layer for specialist agents."""

    def __init__(self, vector_store: Any | None = None):
        self._entries: list[BlackboardEntry] = []
        self._vector_store = vector_store
        self._total_writes = 0
        self._total_reads = 0

    def post(self, entry: BlackboardEntry) -> None:
        self._entries.append(entry)
        self._total_writes += 1

    def get_entries(
        self,
        agent_id: str | None = None,
        category: str | None = None,
        since: float | None = None,
        limit: int = 100,
    ) -> list[BlackboardEntry]:
        result = self._entries
        if agent_id:
            result = [e for e in result if e.agent_id == agent_id]
        if category:
            result = [e for e in result if e.category == category]
        if since:
            result = [e for e in result if e.timestamp >= since]
        self._total_reads += len(result)
        return result[-limit:]

    def similarity_search(self, query: str, k: int = 5) -> list[BlackboardEntry]:
        """Stub: returns k most recent entries if no vector store."""
        if self._vector_store is None:
            return self._entries[-k:] if self._entries else []
        # Would call vector_store.hybrid_search(query, k=k) in production
        return self._entries[-k:] if self._entries else []

    def clear(self) -> None:
        self._entries.clear()

    def stats(self) -> dict[str, Any]:
        return {
            "total_entries": len(self._entries),
            "total_writes": self._total_writes,
            "total_reads": self._total_reads,
        }


# ──────────────────────────────────────────────────────────────────────────
# Convenience environment wrappers
# ──────────────────────────────────────────────────────────────────────────

class MessagePassingEnvironment:
    """Environment built on message passing."""

    def __init__(self, redis_client: Any | None = None):
        self.message_bus = MessageBus(redis_client=redis_client)
        self.agents: dict[str, Any] = {}

    def register_agent(self, agent_id: str, agent: Any) -> None:
        self.agents[agent_id] = agent
        self.message_bus.subscribe(agent_id, agent.receive_message)

    def send_message(
        self,
        from_id: str,
        to_id: str,
        content: dict[str, Any],
        msg_type: MessageType = MessageType.REQUEST,
    ) -> Message:
        msg = Message(
            from_agent=from_id,
            to_agent=to_id,
            type=msg_type,
            content=content,
        )
        self.message_bus.publish(to_id, msg)
        return msg

    def broadcast(
        self,
        from_id: str,
        content: dict[str, Any],
        exclude: list[str] | None = None,
    ) -> list[str]:
        return self.message_bus.broadcast(from_id, content, exclude=exclude)


class BlackboardEnvironment:
    """Environment built on blackboard pattern."""

    def __init__(self, vector_store: Any | None = None):
        self.blackboard = Blackboard(vector_store=vector_store)
        self.specialists: dict[str, Any] = {}
        self._total_notifications = 0

    def register_specialist(self, specialist_id: str, specialist: Any) -> None:
        self.specialists[specialist_id] = specialist

    def write_hypothesis(self, agent_id: str, hypothesis: dict[str, Any], confidence: float = 0.5) -> BlackboardEntry:
        entry = BlackboardEntry(
            agent_id=agent_id,
            content=hypothesis,
            confidence=confidence,
            category=hypothesis.get("category", "hypothesis"),
        )
        self.blackboard.post(entry)
        # Notify interested specialists
        for sid, specialist in self.specialists.items():
            if sid != agent_id:
                interests = getattr(specialist, "interests", set())
                if entry.category in interests:
                    self._total_notifications += 1
                    if hasattr(specialist, "on_blackboard_update"):
                        asyncio.create_task(specialist.on_blackboard_update(entry))
        return entry

    def read_relevant(self, agent_id: str, query: str, k: int = 5) -> list[BlackboardEntry]:
        return self.blackboard.similarity_search(query, k=k)

    def get_entries(
        self,
        agent_id: str | None = None,
        category: str | None = None,
        limit: int = 100,
    ) -> list[BlackboardEntry]:
        return self.blackboard.get_entries(agent_id=agent_id, category=category, limit=limit)
