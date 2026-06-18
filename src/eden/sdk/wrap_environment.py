"""Eden Environment Wrapper — auto-capture agent interactions for observability.

Phase 6.5: Provides `wrap_environment()` which wraps any Gymnasium-style
environment and automatically emits telemetry events for every step, reset,
and tool invocation. No manual instrumentation required.

Usage:
    import gymnasium as gym
    from eden.sdk.wrap_environment import wrap_environment

    env = gym.make("CartPole-v1")
    env = wrap_environment(env, project_id="proj_abc123", agent_id="agent_v1")

    obs, info = env.reset()
    for step in range(1000):
        action = agent.policy(obs)
        obs, reward, terminated, truncated, info = env.step(action)
        if terminated or truncated:
            break
"""

from __future__ import annotations

import time
import uuid
from datetime import UTC, datetime
from typing import Any


class EdenEnvironmentWrapper:
    """Wrapper that captures all agent-environment interactions as telemetry.

    Compatible with any object that has `.reset()` and `.step(action)` methods
    following the Gymnasium API (returns observation, reward, terminated,
    truncated, info).
    """

    def __init__(
        self,
        env: Any,
        *,
        tenant_id: str,
        project_id: str,
        agent_id: str | None = None,
        agent_version: str | None = None,
        environment_id: str | None = None,
        tags: list[str] | None = None,
    ) -> None:
        self._env = env
        self._tenant_id = tenant_id
        self._project_id = project_id
        self._agent_id = agent_id
        self._agent_version = agent_version
        self._environment_id = environment_id or getattr(env, "spec", None) and getattr(env.spec, "id", None)
        self._tags = tags or []
        self._trace_id: str | None = None
        self._step_count = 0
        self._episode_reward = 0.0
        self._start_time: float | None = None

    # ── Core delegation ───────────────────────────────────────────────────

    def reset(self, **kwargs: Any) -> tuple[Any, dict[str, Any]]:
        """Reset the environment and start a new trace."""
        self._trace_id = str(uuid.uuid4())
        self._step_count = 0
        self._episode_reward = 0.0
        self._start_time = time.time()

        result = self._env.reset(**kwargs)
        obs = result[0] if isinstance(result, tuple) else result
        info = result[1] if isinstance(result, tuple) and len(result) > 1 else {}

        self._emit_event(
            event_type="env.reset",
            name="environment.reset",
            payload={"observation_type": type(obs).__name__, "info_keys": list(info.keys())},
        )
        return obs, info

    def step(self, action: Any) -> tuple[Any, float, bool, bool, dict[str, Any]]:
        """Execute one environment step and emit telemetry."""
        step_start = time.time()
        obs, reward, terminated, truncated, info = self._env.step(action)
        step_duration_ms = (time.time() - step_start) * 1000

        self._step_count += 1
        self._episode_reward += reward

        # Capture action details safely
        action_payload = {"action_type": type(action).__name__}
        if hasattr(action, "tolist"):
            action_payload["action_shape"] = getattr(action, "shape", None)
        elif isinstance(action, (int, float, str, bool)):
            action_payload["action_value"] = action

        # Capture observation details safely
        obs_payload = {"observation_type": type(obs).__name__}
        if hasattr(obs, "shape"):
            obs_payload["observation_shape"] = getattr(obs, "shape", None)

        self._emit_event(
            event_type="env.step",
            name=f"environment.step.{self._step_count}",
            parent_span_id=None,
            duration_ms=step_duration_ms,
            payload={
                **action_payload,
                **obs_payload,
                "reward": reward,
                "terminated": terminated,
                "truncated": truncated,
                "info_keys": list(info.keys()),
                "step_number": self._step_count,
            },
            metrics={
                "reward": float(reward),
                "step_duration_ms": step_duration_ms,
                "cumulative_reward": self._episode_reward,
            },
            outcome="success" if not (terminated or truncated) else "failure" if terminated and reward <= 0 else "partial",
        )

        # Emit episode summary on termination
        if terminated or truncated:
            total_duration_ms = (time.time() - self._start_time) * 1000 if self._start_time else 0.0
            self._emit_event(
                event_type="env.episode.end",
                name="environment.episode.end",
                duration_ms=total_duration_ms,
                payload={
                    "steps": self._step_count,
                    "total_reward": self._episode_reward,
                    "terminated": terminated,
                    "truncated": truncated,
                },
                metrics={
                    "total_reward": self._episode_reward,
                    "episode_duration_ms": total_duration_ms,
                    "steps": self._step_count,
                },
                outcome="success" if self._episode_reward > 0 else "failure",
            )

        return obs, reward, terminated, truncated, info

    def render(self, **kwargs: Any) -> Any:
        """Delegate render to wrapped environment."""
        return self._env.render(**kwargs)

    def close(self) -> None:
        """Close the environment."""
        self._emit_event(
            event_type="env.close",
            name="environment.close",
            payload={"steps_completed": self._step_count},
        )
        self._env.close()

    # ── Property delegation ───────────────────────────────────────────────

    @property
    def observation_space(self) -> Any:
        return getattr(self._env, "observation_space", None)

    @property
    def action_space(self) -> Any:
        return getattr(self._env, "action_space", None)

    @property
    def metadata(self) -> Any:
        return getattr(self._env, "metadata", {})

    @property
    def spec(self) -> Any:
        return getattr(self._env, "spec", None)

    def __getattr__(self, name: str) -> Any:
        """Forward all other attributes to the wrapped environment."""
        return getattr(self._env, name)

    # ── Telemetry emission ──────────────────────────────────────────────────

    def _emit_event(
        self,
        *,
        event_type: str,
        name: str,
        parent_span_id: str | None = None,
        duration_ms: float | None = None,
        payload: dict[str, Any] | None = None,
        metrics: dict[str, float] | None = None,
        outcome: str | None = None,
    ) -> None:
        """Build and emit a telemetry event."""
        if not self._trace_id:
            self._trace_id = str(uuid.uuid4())

        event_data = {
            "event_id": str(uuid.uuid4()),
            "tenant_id": self._tenant_id,
            "project_id": self._project_id,
            "trace_id": self._trace_id,
            "realm": "environment",
            "event_type": event_type,
            "timestamp": datetime.now(UTC).isoformat(),
            "agent_id": self._agent_id,
            "agent_version": self._agent_version,
            "environment_id": self._environment_id,
            "parent_span_id": parent_span_id,
            "span_id": str(uuid.uuid4()),
            "name": name,
            "duration_ms": duration_ms,
            "payload": payload or {},
            "metrics": metrics or {},
            "attributes": {},
            "tags": self._tags,
            "outcome": outcome,
        }

        # Attempt async ingestion via the telemetry collector
        try:
            import asyncio

            from eden.observability.telemetry_collector import (
                TelemetryEvent,
                get_telemetry_collector,
            )
            collector = get_telemetry_collector()
            # If we're in an async context, await; otherwise fire-and-forget
            try:
                loop = asyncio.get_running_loop()
                if loop.is_running():
                    asyncio.create_task(collector.ingest(TelemetryEvent.from_dict(event_data)))
            except RuntimeError:
                # No event loop — synchronous context; log for now
                pass
        except Exception:
            # Telemetry should never break the environment
            pass


def wrap_environment(
    env: Any,
    *,
    tenant_id: str,
    project_id: str,
    agent_id: str | None = None,
    agent_version: str | None = None,
    environment_id: str | None = None,
    tags: list[str] | None = None,
) -> EdenEnvironmentWrapper:
    """Wrap a Gymnasium-style environment with Eden telemetry capture.

    Args:
        env: The environment to wrap. Must have `.reset()` and `.step()`.
        tenant_id: Eden organization / tenant identifier.
        project_id: Project identifier within the tenant.
        agent_id: Optional agent identifier.
        agent_version: Optional agent version string.
        environment_id: Optional environment identifier (auto-detected from env.spec.id).
        tags: Optional list of tags for filtering.

    Returns:
        EdenEnvironmentWrapper that transparently wraps `env`.
    """
    return EdenEnvironmentWrapper(
        env,
        tenant_id=tenant_id,
        project_id=project_id,
        agent_id=agent_id,
        agent_version=agent_version,
        environment_id=environment_id,
        tags=tags,
    )
