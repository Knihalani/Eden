/**
 * Eden SDK error taxonomy.
 */

export interface ErrorMeta {
  requestId?: string;
  errorCode?: string;
  docsUrl?: string;
  suggestion?: string;
  retryAfter?: number;
  responseBody?: Record<string, unknown>;
}

export class EdenError extends Error {
  statusCode: number = 500;
  errorCode: string = "unknown";
  docsUrl: string = "https://docs.eden.dev/errors";
  requestId?: string;
  suggestion?: string;
  retryAfter?: number;
  responseBody?: Record<string, unknown>;

  constructor(message: string, meta?: ErrorMeta) {
    super(message);
    this.name = "EdenError";
    if (meta) {
      this.requestId = meta.requestId;
      this.errorCode = meta.errorCode ?? this.errorCode;
      this.docsUrl = meta.docsUrl ?? this.docsUrl;
      this.suggestion = meta.suggestion;
      this.retryAfter = meta.retryAfter;
      this.responseBody = meta.responseBody;
    }
  }

  toString(): string {
    const parts = [this.message];
    if (this.requestId) parts.push(`(request_id: ${this.requestId})`);
    if (this.suggestion) parts.push(`Suggestion: ${this.suggestion}`);
    return parts.join(" ");
  }
}

export class AuthenticationError extends EdenError {
  statusCode = 401;
  errorCode = "authentication_failed";
  docsUrl = "https://docs.eden.dev/errors/authentication";
}

export class RateLimitError extends EdenError {
  statusCode = 429;
  errorCode = "rate_limit_exceeded";
  docsUrl = "https://docs.eden.dev/errors/rate-limit";
}

export class QuotaExceededError extends EdenError {
  statusCode = 429;
  errorCode = "quota_exceeded";
  docsUrl = "https://docs.eden.dev/errors/quota";
}

export class ValidationError extends EdenError {
  statusCode = 422;
  errorCode = "validation_failed";
  docsUrl = "https://docs.eden.dev/errors/validation";
  fieldErrors?: Record<string, string>;

  constructor(message: string, meta?: ErrorMeta & { fieldErrors?: Record<string, string> }) {
    super(message, meta);
    this.fieldErrors = meta?.fieldErrors;
  }
}

export class NotFoundError extends EdenError {
  statusCode = 404;
  errorCode = "not_found";
  docsUrl = "https://docs.eden.dev/errors/not-found";
}

export class PipelineError extends EdenError {
  statusCode = 500;
  errorCode = "pipeline_failed";
  docsUrl = "https://docs.eden.dev/errors/pipeline";
  failedNode?: string;
  nodeLogs?: string;
}

export class SandboxTimeoutError extends EdenError {
  statusCode = 504;
  errorCode = "sandbox_timeout";
  docsUrl = "https://docs.eden.dev/errors/sandbox-timeout";
  timeoutSeconds?: number;
}

export class ServerError extends EdenError {
  statusCode = 500;
  errorCode = "internal_error";
  docsUrl = "https://docs.eden.dev/errors/server";
}

export function raiseForStatus(statusCode: number, body: Record<string, unknown>, requestId?: string): void {
  const detail = (body.detail as string) ?? (body.message as string) ?? "Unknown error";
  const meta = (body.meta as Record<string, unknown>) ?? {};
  const reqId = requestId ?? (meta.request_id as string);

  const kwargs: ErrorMeta = {
    message: detail,
    requestId: reqId,
    responseBody: body,
  };

  if (statusCode === 401) throw new AuthenticationError(detail, kwargs);
  if (statusCode === 403) {
    if (detail.toLowerCase().includes("quota") || detail.toLowerCase().includes("limit")) {
      throw new QuotaExceededError(detail, kwargs);
    }
    throw new AuthenticationError(`Permission denied: ${detail}`, kwargs);
  }
  if (statusCode === 404) throw new NotFoundError(detail, kwargs);
  if (statusCode === 422) {
    const fieldErrors = (typeof body.data === "object" && body.data !== null)
      ? (body.data as Record<string, unknown>).fieldErrors as Record<string, string> | undefined
      : undefined;
    throw new ValidationError(detail, { ...kwargs, fieldErrors });
  }
  if (statusCode === 429) {
    const retryAfter = typeof body.retry_after === "number" ? body.retry_after : undefined;
    throw new RateLimitError(detail, { ...kwargs, retryAfter });
  }
  if (statusCode === 504) throw new SandboxTimeoutError(detail, kwargs);
  if (statusCode >= 500) throw new ServerError(detail, kwargs);
  if (statusCode >= 400) throw new EdenError(detail, { ...kwargs, statusCode });
}
