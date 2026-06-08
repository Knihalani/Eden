"""Eden Python SDK — AI-native environment generation client.

Usage:
    import asyncio
    from eden.sdk import Eden

    async def main():
        eden = Eden()
        job = await eden.jobs.create(description="A multi-agent negotiation environment")
        print(job.job_id)

    asyncio.run(main())
"""

from eden.sdk.client import EdenClient
from eden.sdk.config import EdenConfig
from eden.sdk.errors import (
    EdenError,
    AuthenticationError,
    RateLimitError,
    ValidationError,
    NotFoundError,
    PipelineError,
    SandboxTimeoutError,
    ServerError,
)
from eden.sdk.trace import trace_agent

__all__ = [
    "EdenClient",
    "EdenConfig",
    "EdenError",
    "AuthenticationError",
    "RateLimitError",
    "ValidationError",
    "NotFoundError",
    "PipelineError",
    "SandboxTimeoutError",
    "ServerError",
    "trace_agent",
]

# Convenience alias
Eden = EdenClient
