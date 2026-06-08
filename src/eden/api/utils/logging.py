"""Structured logging configuration for Eden.

Configures ``structlog`` and Python's standard ``logging`` module to emit
JSON-formatted logs in production and human-readable colored output in
development. Every log entry includes the correlation ID, service name,
environment, and timestamp.
"""

import logging
import sys
from typing import Any

import structlog

from eden.api.middleware.correlation_id import get_correlation_id
from eden.config import get_settings

settings = get_settings()


def _add_correlation_id(logger: Any, method_name: str, event_dict: dict) -> dict:
    """Add the current request's correlation ID to every log entry."""
    event_dict["correlation_id"] = get_correlation_id()
    return event_dict


def _add_service_context(logger: Any, method_name: str, event_dict: dict) -> dict:
    """Add service-level context (name, version, environment) to logs."""
    event_dict["service"] = settings.app_name.lower().replace(" ", "_")
    event_dict["version"] = settings.app_version
    event_dict["env"] = "development" if settings.debug else "production"
    return event_dict


def configure_logging() -> None:
    """Configure structured logging for the Eden application.

    In production (``debug=False``) logs are emitted as compact JSON.
    In development, colored console output is used for readability.

    This should be called **once** during application startup, before
    any log messages are emitted.
    """
    shared_processors: list[Any] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
        _add_correlation_id,
        _add_service_context,
        structlog.stdlib.ExtraAdder(),
    ]

    if settings.debug:
        # Development: colored console output
        renderer = structlog.dev.ConsoleRenderer(colors=True)
        formatter = structlog.stdlib.ProcessorFormatter(
            processor=renderer,
            foreign_pre_chain=shared_processors,
        )
    else:
        # Production: compact JSON
        renderer = structlog.processors.JSONRenderer()
        formatter = structlog.stdlib.ProcessorFormatter(
            processor=renderer,
            foreign_pre_chain=shared_processors,
        )

    # Configure stdlib logging handlers (integrate with existing handlers
    # rather than clobbering them, so uvicorn's setup stays intact)
    root_logger = logging.getLogger()

    # Only add our handler if it's not already present to avoid duplicates.
    # We mark our handler with a custom attribute so identity checks are robust.
    if not any(getattr(h, "_eden_handler", False) for h in root_logger.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(formatter)
        handler._eden_handler = True  # type: ignore[attr-defined]
        root_logger.addHandler(handler)
    root_logger.setLevel(logging.DEBUG if settings.debug else logging.INFO)

    # Reduce noise from third-party libraries
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("asyncpg").setLevel(logging.WARNING)

    # Configure structlog
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            _add_correlation_id,
            _add_service_context,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )
