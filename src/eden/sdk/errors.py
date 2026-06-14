"""Eden SDK error taxonomy.

All errors carry structured context: request_id, error_code, status_code,
docs_url, and actionable suggestions.
"""

from __future__ import annotations

from typing import Any


class EdenError(Exception):
    """Base class for all Eden SDK errors."""

    status_code: int = 500
    error_code: str = "unknown"
    docs_url: str = "https://docs.eden.dev/errors"

    def __init__(
        self,
        message: str,
        *,
        request_id: str | None = None,
        error_code: str | None = None,
        status_code: int | None = None,
        docs_url: str | None = None,
        suggestion: str | None = None,
        retry_after: int | None = None,
        response_body: dict | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.request_id = request_id
        self.error_code = error_code or self.error_code
        self.status_code = status_code or self.status_code
        self.docs_url = docs_url or self.docs_url
        self.suggestion = suggestion
        self.retry_after = retry_after
        self.response_body = response_body or {}

    def __str__(self) -> str:
        parts = [self.message]
        if self.request_id:
            parts.append(f"(request_id: {self.request_id})")
        if self.suggestion:
            parts.append(f"Suggestion: {self.suggestion}")
        return " ".join(parts)

    def __repr__(self) -> str:
        return (
            f"<{self.__class__.__name__} "
            f"code={self.error_code} "
            f"status={self.status_code} "
            f"msg={self.message!r}>"
        )


class AuthenticationError(EdenError):
    """API key invalid, expired, or missing required scopes."""

    status_code = 401
    error_code = "authentication_failed"
    docs_url = "https://docs.eden.dev/errors/authentication"


class RateLimitError(EdenError):
    """Quota exceeded or rate limit hit."""

    status_code = 429
    error_code = "rate_limit_exceeded"
    docs_url = "https://docs.eden.dev/errors/rate-limit"


class QuotaExceededError(EdenError):
    """Monthly or hard quota exceeded."""

    status_code = 429
    error_code = "quota_exceeded"
    docs_url = "https://docs.eden.dev/errors/quota"


class ValidationError(EdenError):
    """Input validation failed."""

    status_code = 422
    error_code = "validation_failed"
    docs_url = "https://docs.eden.dev/errors/validation"

    def __init__(
        self,
        *args: Any,
        field_errors: dict | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self.field_errors = field_errors or {}


class NotFoundError(EdenError):
    """Requested resource not found."""

    status_code = 404
    error_code = "not_found"
    docs_url = "https://docs.eden.dev/errors/not-found"


class PipelineError(EdenError):
    """Pipeline execution failed at a specific node."""

    status_code = 500
    error_code = "pipeline_failed"
    docs_url = "https://docs.eden.dev/errors/pipeline"

    def __init__(
        self,
        *args: Any,
        failed_node: str | None = None,
        node_logs: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self.failed_node = failed_node
        self.node_logs = node_logs or ""


class SandboxTimeoutError(EdenError):
    """Code execution exceeded time limit."""

    status_code = 504
    error_code = "sandbox_timeout"
    docs_url = "https://docs.eden.dev/errors/sandbox-timeout"

    def __init__(
        self,
        *args: Any,
        timeout_seconds: int | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self.timeout_seconds = timeout_seconds


class ServerError(EdenError):
    """Internal server error."""

    status_code = 500
    error_code = "internal_error"
    docs_url = "https://docs.eden.dev/errors/server"


class ConflictError(EdenError):
    """Resource conflict (e.g., duplicate idempotency key with different payload)."""

    status_code = 409
    error_code = "conflict"
    docs_url = "https://docs.eden.dev/errors/conflict"


class IdempotencyError(EdenError):
    """Idempotency key mismatch."""

    status_code = 422
    error_code = "idempotency_error"
    docs_url = "https://docs.eden.dev/errors/idempotency"


def raise_for_status(status_code: int, body: dict, request_id: str | None = None) -> None:
    """Raise the appropriate EdenError for an HTTP status code."""
    detail = body.get("detail", body.get("message", "Unknown error"))
    meta = body.get("meta", {})
    req_id = request_id or meta.get("request_id")

    kwargs = {
        "message": detail,
        "request_id": req_id,
        "response_body": body,
    }

    if status_code == 401:
        raise AuthenticationError(**kwargs)
    if status_code == 403:
        # Map 403 quota/rate-limit to specific errors
        if "quota" in detail.lower() or "limit" in detail.lower():
            raise QuotaExceededError(**kwargs)
        raise AuthenticationError(
            message=f"Permission denied: {detail}",
            request_id=req_id,
            response_body=body,
        )
    if status_code == 404:
        raise NotFoundError(**kwargs)
    if status_code == 409:
        raise ConflictError(**kwargs)
    if status_code == 422:
        field_errors = body.get("data", {}).get("field_errors") if isinstance(body.get("data"), dict) else None
        raise ValidationError(**kwargs, field_errors=field_errors)
    if status_code == 429:
        retry_after = None
        if isinstance(body.get("retry_after"), int):
            retry_after = body["retry_after"]
        raise RateLimitError(**kwargs, retry_after=retry_after)
    if status_code == 504:
        raise SandboxTimeoutError(**kwargs)
    if status_code >= 500:
        raise PipelineError(**kwargs) if "pipeline" in detail.lower() else ServerError(**kwargs)
    if status_code >= 400:
        raise EdenError(**kwargs, status_code=status_code)
